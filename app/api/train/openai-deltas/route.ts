/**
 * POST /api/train/openai-deltas
 *
 * Thin API: receives result + reference base64 images, calls OpenAI Vision,
 * returns parameter deltas. No RAW decoding, no processFrames.
 */

import { NextResponse } from "next/server";
import { parseJsonDeltas } from "@/lib/apply-grading-deltas";

const OPENAI_SYSTEM_PROMPT = `
You compare a graded RESULT image to a REFERENCE image and suggest NUMERIC parameter deltas so the result looks as close as possible to the reference.
RAW source might be underexposed: If you are working on iteration 1-10, priotise getting exposure right.use the exposure curve and exposureStrength (0–1.9) to fix exposure. If exposure and contrast is correct, colors will be easier.
You will be grading a digital raw image to look exactly like a film reference. 
Film reference might have split colors highlights vs shadows, Use Per‑band temperature for that temperature split.
Film has both unique color seperation and density, so keep your eyes out for individual objects colors not matching the reference:
If exposure is correct, focus on these: Examples: A car with the wrong red, a tree with the wrong green, a flower with the wrong pink: Use  Refraction (Highlight/Shadow)(hue [0-360], saturation [0-3]) to nudge a color in a different direction. 
Are you getting greens right?


Output rules:
- Return a single JSON object ONLY (no prose, no markdown).
- Each key is a parameter name, each value is a numeric delta TO ADD to the current value.
- Omit keys for "no change".


You may adjust these MATCH parameters (JSON keys):

Scalar match controls:
- exposureStrength (0–1.9): strength of matching a simiplied version of the reference exposure.
- colorStrength (0–1.8): how strongly colors pull towards a simplified model of the reference.
- blackStrength (3–8): how strongly shadows and blacks are pulled towards the reference's black depth.
- blackRange (0.3–1.8): upper luminance bound for the black/shadow pull.
- blackPoint (0–0.3, training clamp): black floor anchor.

7‑handle curves: exposureCurve.L_out_0 … L_out_6 (0–2), colorDensityCurve.scale_0 … scale_6 (0.2–2.5),
contrastCurve.values_0 … values_6 (-5 to +5), toneCurve.L_out_0 … L_out_6 (0–1).

Five-band colour shaping: bandLowerShadowHue … bandUpperHighHue (-1–1).
Per‑band temperature: bandLowerShadowTemp … bandUpperHighTemp (-1–1).

Highlight fill (halation): highlightFillStrength, highlightFillWarmth, halationTailGamma, halationContrastGate,
halationRimStrength, halationBloomStrength, halationRimRadius, halationBloomRadius.

Actuance: actuanceStrength, actuanceRadius.

Refraction wheels: refractionShadow.<color>.hue/.sat, refractionHighlight.<color>.hue/.sat, refractionSplitL.

Return ONLY valid JSON.`;

const OPENAI_SUBSTEP1_PROMPT = `Focus on exposure, contrast, color density, curves, refraction, per-band controls. Do NOT adjust halation params.
Omit: highlightFillStrength, highlightFillWarmth, halationTailGamma, halationContrastGate, halationRimStrength, halationBloomStrength, halationRimRadius, halationBloomRadius.
Return a single JSON object of parameter deltas only. Omit keys for no change. Values must be numeric deltas.`;

const OPENAI_SUBSTEP2_PROMPT = `Focus ONLY on halation (highlight bloom/rim). Compare highlight bloom and rim to the reference.
Adjust only: highlightFillStrength (0–1), highlightFillWarmth (-1–1), halationTailGamma (2–6), halationContrastGate (0–1), halationRimStrength (0–1), halationBloomStrength (0–1), halationRimRadius (0–2), halationBloomRadius (0–10).
Return a single JSON object of parameter deltas only. Omit keys for no change. Values must be numeric deltas.`;

interface OpenAIDeltasBody {
  result_base64: string;
  reference_base64: string;
  substep?: 1 | 2;
  iteration?: number;
  max_iterations?: number;
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

  const { result_base64, reference_base64, substep = 1 } = body;
  if (!result_base64 || !reference_base64) {
    return NextResponse.json(
      { error: "result_base64 and reference_base64 are required" },
      { status: 400 }
    );
  }

  const subPrompt = substep === 2 ? OPENAI_SUBSTEP2_PROMPT : OPENAI_SUBSTEP1_PROMPT;
  const iteration = body.iteration ?? 1;
  const maxIterations = body.max_iterations ?? 20;
  const lastDeltas = body.last_deltas ?? {};
  const currentMatch = body.current_match ?? {};
  const initialMatch = body.initial_match ?? {};

  const lastDeltaText =
    Object.keys(lastDeltas).length > 0
      ? JSON.stringify(lastDeltas)
      : "none (this is the first iteration or previous step produced no changes)";
  const currentMatchText = JSON.stringify(currentMatch);
  const baseMatchText = JSON.stringify(initialMatch);

  const userText =
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
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${result_base64}` },
              },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${reference_base64}` },
              },
            ],
          },
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
    const content = data.choices?.[0]?.message?.content ?? "";
    const deltas = parseJsonDeltas(content);

    return NextResponse.json({ deltas });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `OpenAI request failed: ${msg}` },
      { status: 500 }
    );
  }
}
