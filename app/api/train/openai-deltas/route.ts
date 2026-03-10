/**
 * POST /api/train/openai-deltas
 *
 * Thin API: receives result + reference base64 images, calls OpenAI Vision,
 * returns parameter deltas. No RAW decoding, no processFrames.
 */

import { NextResponse } from "next/server";
import {
  parseJsonDeltas,
  filterPhaseDeltas,
} from "@/lib/apply-grading-deltas";

const OPENAI_SYSTEM_PROMPT = `
You compare a graded RESULT image to a REFERENCE image and suggest NUMERIC parameter deltas so the result looks as close as possible to the reference.
You will be grading a digital raw image to look exactly like a film reference. Each phase focuses on a subset of parameters; only adjust what the phase allows. The user message specifies which parameters and includes phase-specific guidance.

Output rules:
- Return a single JSON object ONLY (no prose, no markdown).
- Each key is a parameter name, each value is a numeric delta TO ADD to the current value.
- Omit keys for "no change".
- Values MUST be numeric deltas. Do NOT output nested objects, arrays, strings, or booleans.

Return ONLY valid JSON.`;

const OPENAI_SUBSTEP1_PROMPT = `Focus on exposure, contrast, color density, curves, refraction, per-band controls. Do NOT adjust halation.

Adjust: exposureStrength, exposureCurve.L_out_0…6, blackPoint, blackRange, blackStrength; contrastCurve.values_0…6; colorDensityCurve.scale_0…6; colorStrength, bandMidTemp/Hue/Sat, band*Hue/Temp/Sat/Luma; refractionShadow/Highlight.<color>.hue/.sat, refractionSplitL.
Omit: highlightFillStrength, highlightFillWarmth, halationTailGamma, halationContrastGate, halationRimStrength, halationBloomStrength, halationRimRadius, halationBloomRadius.
EV: exposureCurve L_out 1=0 EV, 1.4≈+0.5 EV. Refraction green=120°; 120→115=orange, 120→125=greener.
Return JSON of deltas only. Omit keys for no change.`;

const OPENAI_SUBSTEP2_PROMPT = `Focus ONLY on halation (highlight bloom/rim). Compare bloom and rim to reference.

Adjust only: highlightFillStrength (0–2), highlightFillWarmth (-1–1), halationTailGamma (2–6), halationContrastGate (0–1), halationRimStrength (0–1), halationBloomStrength (0–1), halationRimRadius (0–0.75), halationBloomRadius (0–2.5).
Return JSON of deltas only. Omit keys for no change.`;

const PHASE_PROMPTS: Record<
  1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
  string
> = {
  1: `Phase 1: Exposure only. RAW source may be underexposed.

Parameters (adjust only these):
- exposureStrength (0–1.5): toward simplified reference exposure.
- exposureCurve.L_out_0 … L_out_6: L_out_0 = blackpoint, only decrease (0–1), never lift. L_out_1–6 (0–2) = exposure multipliers; 1 = neutral, >1 brightens, <1 darkens. EV: 1 = 0 EV, 1.4≈+0.5 EV, 0.7≈−0.5 EV.
- blackPoint (0–0.2), blackRange (0.3–1.8), blackStrength (5–8): shadow depth.
- bandLowerShadowLuma … bandUpperHighLuma (-0.2–0.2): per-band tone nudge.

Return JSON of deltas only. Omit keys for no change.`,
  2: `Phase 2: Overall contrast only.

Parameters: contrastCurve.values_0 … values_6 (-5 to +5). Filmic curve: H0 darkest shadows, H6 brightest highlights. Negative = deeper density, positive = bleach-bypass feel. Default no-change: [-5,-3.5,-1.75,0,1.75,3.5,5]. Also: bandLowerShadowLuma (only decrease, never lift), exposureCurve.L_out_0 (only decrease, never lift), blackStrength (5–8).
If blacks are too gray: Decrease bandLowerShadowLuma and exposureCurve.L_out_0. And increase blackStrength.
Return JSON of deltas only. Omit keys for no change.`,
  3: `Phase 3: Color density curve only.

Parameters: colorDensityCurve.scale_0 … scale_6 (0.2–2.5). Per-tonal-region chroma at 7 L anchors. >1 increases saturation at that L; <1 reduces it. Film has strong density in midtones/lower highlights.

Return JSON of deltas only. Omit keys for no change.`,
  4: `Phase 4: Overall grading (hue/temp) only. Film reference may have split colors (highlights vs shadows).

Parameters: colorStrength (0–1.8), bandMidTemp (-1–1), bandMidHue (-1–1), bandMidSat. Per-band temp: −1≈7500K cool, +1≈4000K warm; ±0.1≈±200K. Per-band hue: −1=−30°, +1=+30°; 0°=red, 120°=green, 240°=blue.

Return JSON of deltas only. Omit keys for no change.`,
  5: `Phase 5: Per-band grading only. Film has unique color separation. Watch for individual objects' colors not matching reference.

Parameters: bandLowerShadow*, bandUpperShadow*, bandLowerHigh*, bandUpperHigh* (Hue, Sat, Temp only — no Luma). Hue: + = clockwise, − = counter-clockwise. Temp: − = cooler, + = warmer. Use bands to target shadows vs mids vs highlights.

Return JSON of deltas only. Omit keys for no change.`,
  6: `Phase 6: Refraction only. Fix specific object colors: car wrong red, tree wrong green, flower wrong pink.

Parameters: refractionShadow.<color>.hue (0–360), .sat (0–3); refractionHighlight.<color>.hue, .sat; refractionSplitL (0–1). Defaults: red=0, yellow=60, green=120, teal=180, blue=240, purple=300. Green 120→115 = more orange; 120→125 = cooler/greener. Are you getting greens right?

Return JSON of deltas only. Omit keys for no change.`,
  7: `Phase 7: Actuance only. Microcontrast and sharpness.

Parameters: actuanceStrength (0.75–3): higher = stronger crispness. actuanceRadius (0.5–5): lower = fine detail only, higher = coarser structures.

Return JSON of deltas only. Omit keys for no change.`,
  8: `Phase 8: Halation only. Highlight bloom and rim.

Parameters: highlightFillStrength (0–2), highlightFillWarmth (-1–1), halationTailGamma (2–6, default 4), halationContrastGate (0–1), halationRimStrength (0–1), halationBloomStrength (0–1), halationRimRadius (0–0.75), halationBloomRadius (0–2.5).

Return JSON of deltas only. Omit keys for no change.`,
};

interface OpenAIDeltasBody {
  result_base64: string;
  reference_base64: string;
  substep?: 1 | 2;
  phase?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  source_base64?: string;
  second_last_base64?: string;
  second_last_params?: Record<string, unknown>;
  iteration?: number;
  max_iterations?: number;
  run?: number;
  num_runs?: number;
  phase_iteration?: number;
  iters_per_phase?: number;
  last_deltas?: Record<string, number>;
  current_match?: Record<string, unknown>;
  initial_match?: Record<string, unknown>;
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY not set" }, { status: 401 });
  }

  let body: OpenAIDeltasBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { result_base64, reference_base64, substep = 1, phase } = body;
  if (!result_base64 || !reference_base64) {
    return NextResponse.json(
      { error: "result_base64 and reference_base64 are required" },
      { status: 400 }
    );
  }

  const isPhased = typeof phase === "number" && phase >= 1 && phase <= 8;

  const iteration = body.iteration ?? 1;
  const maxIterations = body.max_iterations ?? 20;
  const lastDeltas = body.last_deltas ?? {};
  const currentMatch = body.current_match ?? {};
  const initialMatch = body.initial_match ?? {};
  const run = body.run ?? 1;
  const phaseIteration = body.phase_iteration ?? 1;
  const itersPerPhase = body.iters_per_phase ?? 5;

  const lastDeltaText =
    Object.keys(lastDeltas).length > 0
      ? JSON.stringify(lastDeltas)
      : "none (this is the first iteration or previous step produced no changes)";
  const currentMatchText = JSON.stringify(currentMatch);
  const baseMatchText = JSON.stringify(initialMatch);
  const hasSecondLast = isPhased && !!body.second_last_base64;

  let userText: string;
  if (isPhased && phase) {
    const phaseName =
      phase === 1
        ? "Exposure"
        : phase === 2
          ? "Contrast"
          : phase === 3
            ? "Color density"
            : phase === 4
              ? "Overall grading"
              : phase === 5
                ? "Per-band grading"
                : phase === 6
                  ? "Refraction"
                  : phase === 7
                    ? "Actuance"
                    : "Halation";
    const includeSource = phase === 1 && !hasSecondLast;
    const secondLastBlurb = hasSecondLast
      ? `\nLast params (absolute): ${currentMatchText}\nDeltas from second-last to last: ${lastDeltaText}\nSecond-last params (absolute): ${JSON.stringify(body.second_last_params ?? {})}`
      : "";
    const imgDesc = hasSecondLast
      ? "Images: 1=result, 2=second-last edit, 3=reference."
      : includeSource
        ? "Images: 1=result, 2=reference, 3=pre-edit source. Use source to see original dark vs bright."
        : "Images: 1=result, 2=reference.";
    const lastRunNote =
      body.num_runs != null && run === body.num_runs
        ? "\nYou are in the last run. The previous agents will have attempted to get the core parameters on point. Prioritize smaller adjustments.\n"
        : "";
    userText = `${PHASE_PROMPTS[phase]}${lastRunNote}

Run ${run}${body.num_runs != null ? `/${body.num_runs}` : ""}, Phase ${phase} (${phaseName}), iteration ${phaseIteration} of ${itersPerPhase} in this phase.${secondLastBlurb}

Current match parameters: ${currentMatchText}

${imgDesc} Compare result to reference. Return JSON of parameter deltas only for this phase.`;
  } else {
    const subPrompt =
      substep === 2 ? OPENAI_SUBSTEP2_PROMPT : OPENAI_SUBSTEP1_PROMPT;
    userText =
      substep === 2
        ? `${subPrompt}

This is iteration ${iteration} of ${maxIterations}, substep 2 (halation). Focus on highlight bloom/rim compared to reference.

Last deltas (both substeps): ${lastDeltaText}

Current match parameters: ${currentMatchText}

Compare the first image (result) to the second (reference). Return JSON of halation parameter deltas only.`
        : `${subPrompt}

This is iteration ${iteration} of ${maxIterations}, substep 1 (non-halation). iterations 1-10 get exposure and contrast right. If exposure and contrast are ~90% correct, pick up refraction, per-band temp, hue.

Last iteration deltas: ${lastDeltaText}

Current match parameters: ${currentMatchText}

Baseline: ${baseMatchText}

Compare the first image (result) to the second (reference). Return JSON of parameter deltas only.`;
  }

  const contentItems: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    { type: "text", text: userText },
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${result_base64}` },
    },
  ];
  if (isPhased && hasSecondLast && body.second_last_base64) {
    contentItems.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${body.second_last_base64}` },
    });
  }
  contentItems.push({
    type: "image_url",
    image_url: { url: `data:image/png;base64,${reference_base64}` },
  });
  if (isPhased && phase === 1 && !hasSecondLast && body.source_base64) {
    contentItems.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${body.source_base64}` },
    });
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 1024,
        messages: [
          { role: "system", content: OPENAI_SYSTEM_PROMPT },
          { role: "user", content: contentItems },
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      return NextResponse.json(
        { error: `OpenAI API error: ${res.status} ${errBody.slice(0, 300)}` },
        { status: 502 }
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawContent = data.choices?.[0]?.message?.content ?? "";
    let deltas = parseJsonDeltas(rawContent);
    if (isPhased && phase) {
      deltas = filterPhaseDeltas(phase, deltas);
    }

    return NextResponse.json({ deltas });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `OpenAI request failed: ${msg}` },
      { status: 500 }
    );
  }
}
