/**
 * POST /api/train/openai-loop
 *
 * OpenAI Vision training loop: for each source/reference pair, iteratively
 * apply params, compare result to reference via OpenAI Vision, update params,
 * then write (auto_params, corrected_params) to grading_corrections.
 *
 * Body: { pairs: Array<{ source_base64: string; reference_base64: string }> }
 * Or:   { pairs: Array<{ source_url: string; reference_url: string }> }
 *
 * Requires OPENAI_API_KEY. Images are resized to ~1536 longest edge for the API.
 */

import { NextResponse } from "next/server";
import {
  decodeBufferToLinearFloat,
  frameToPngBuffer,
} from "@/src/lib/pipeline/decodeNode";
import { processFramesFloat } from "@/src/lib/pipeline/processFrames";
import {
  buildExposureMapFromFloat,
  type ExposureMap,
} from "@/src/lib/pipeline/exposureMap";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";
import {
  engineToGrading,
  DEFAULT_LOOK_PARAMS,
} from "@/lib/look-params";
import {
  applyGradingDeltas,
  filterNonHalationDeltas,
  filterHalationDeltas,
  filterPhaseDeltas,
  ensureFullMatch,
  parseJsonDeltas,
} from "@/lib/apply-grading-deltas";
import { buildEngineParamsFromLookParams } from "@/lib/build-engine-params";
import {
  computeImageStatsFromFloat,
  computeBandAnchorsFromFrame,
  pixelFrameF32ToPixelFrameRGBA,
} from "@/src/lib/pipeline";
import type { LookParams, LookParamsMatch } from "@/lib/look-params";
import type { PixelFrameF32, PixelFrameRGBA } from "@/src/lib/pipeline/types";
import { supabaseAdmin } from "@/lib/supabase/server";

/** Max edge for images sent to OpenAI (evaluation prompt). At least 2048 for color accuracy. */
const IMAGE_MAX_EDGE = 2048;
/** Max edge for final export PNG (much larger than evaluation; e.g. 30MB for high-res). */
const EXPORT_MAX_EDGE = 8192;

const OPENAI_SYSTEM_PROMPT = `
You are a professional color grader with expert knowledge in the characteristics of color negative film. You will be grading a digital raw image to look exactly like a film reference. You compare a RESULT image to a REFERENCE image and suggest NUMERIC parameter deltas so the result looks as close as possible to the reference.
You might receive one or two previous edit iterations that can teach you about the visual effects of your tools. You will work in one isolated phase, before the image is handed to the next professional.

Output rules:
- Return a single JSON object ONLY (no prose, no markdown).
- Each key is a parameter name, each value is a numeric delta TO ADD to the current value.
- Omit keys for “no change”.


- Values MUST be numeric deltas. Do NOT output nested objects, arrays, strings, or booleans.

The user message specifies which parameters and includes phase-specific guidance.

Return ONLY valid JSON.`;

/** Substep 1: non-halation params only. Halation is disabled (strength=0) in this substep. */
const OPENAI_SUBSTEP1_PROMPT = `Focus on exposure, contrast, color density, curves, refraction, per-band controls. Do NOT adjust halation.

Adjust: exposureStrength, exposureCurve.L_out_0…6, blackPoint, blackRange, blackStrength; contrastCurve.values_0…6; colorDensityCurve.scale_0…6; colorStrength, bandMidTemp/Hue/Sat, band*Hue/Temp/Sat/Luma; refractionShadow/Highlight.<color>.hue/.sat, refractionSplitL.
Omit: highlightFillStrength, highlightFillWarmth, halationTailGamma, halationContrastGate, halationRimStrength, halationBloomStrength, halationRimRadius, halationBloomRadius.
EV: exposureCurve L_out 1=0 EV, 1.4≈+0.5 EV. Refraction green=120°; 120→115=orange, 120→125=greener.
Return JSON of deltas only. Omit keys for no change.`;

/** Substep 2: halation params only. */
const OPENAI_SUBSTEP2_PROMPT = `Focus ONLY on halation (highlight bloom/rim). Compare bloom and rim to reference.

Adjust only: highlightFillStrength (0–2), highlightFillWarmth (-1–1), halationTailGamma (2–6), halationContrastGate (0–1), halationRimStrength (0–1), halationBloomStrength (0–1), halationRimRadius (0–0.75), halationBloomRadius (0–2.5).
Return JSON of deltas only. Omit keys for no change.`;

const PHASE_PROMPTS: Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, string> = {
  1: `Phase 1: Exposure only. RAW source may be underexposed.

Parameters (adjust only these):
- exposureCurve.L_out_0 … L_out_6: L_out_0 = blackpoint. L_out_1–6 (0–2) = exposure multipliers; 1 = neutral, >1 brightens, <1 darkens. EV: 1 = 0 EV, 1.4≈+0.5 EV, 0.7≈−0.5 EV.
- blackPoint (0–0.2), blackRange (0.3–1.8), blackStrength (5–8): shadow depth.
- bandLowerShadowLuma … bandUpperHighLuma (-0.2–0.2): per-band tone adjustment. 
- exposureStrength (0–1.5): toward simplified reference exposure. 

If raw source is strongly underexeposed: Max out exposureCurve.L_out_1 … L_out_6, bandUpperShadowLuma … bandUpperHighLuma, exposureStrength if you are in Run 1, Iteration 1. Let next agents work their way back.


Band awareness: If exposure was pushed up, "midtones" may contain lifted shadows; bands use post-adjustment L. Return JSON of deltas only. Omit keys for no change.`,
  2: `Phase 2: Overall contrast only. Make the digital raw look exactly like the film reference.

Parameters: contrastCurve.values_0 … values_6 (-5 to +5). Filmic curve: H0 darkest shadows, H6 brightest highlights. Negative = deeper density, positive = bleach-bypass feel. Default no-change: [-5,-3.5,-1.75,0,1.75,3.5,5]. Also: bandLowerShadowLuma (only decrease, never lift), exposureCurve.L_out_0 (only decrease, never lift), blackStrength (5–8).

Return JSON of deltas only. Omit keys for no change.`,
  3: `Phase 3: Color density curve only. Make the digital raw look exactly like the color density in film reference

Parameters: colorDensityCurve.scale_0 … scale_6 (0.2–2.5). Per-tonal-region chroma at 7 L anchors. >1 increases saturation at that L; <1 reduces it. Film has strong density in midtones/lower highlights.

Return JSON of deltas only. Omit keys for no change.`,
  4: `Phase 4: Overall grading (hue/temp) only. Film reference may have split colors (highlights vs shadows). Make the digital raw look exactly like the grading in thefilm reference.

Parameters: colorStrength (0–1.8), bandMidTemp (-1–1), bandMidHue (-1–1), bandMidSat. Per-band temp: −1≈7500K cool, +1≈4000K warm; ±0.1≈±200K. Per-band hue: −1=−30°, +1=+30°; 0°=red, 120°=green, 240°=blue.

Return JSON of deltas only. Omit keys for no change.`,
  5: `Phase 5: Per-band grading only. Film has unique color separation. Watch for individual objects' colors not matching reference. Make the digital raw look exactly like the color grading in the film reference.

Parameters: bandLowerShadow*, bandUpperShadow*, bandLowerHigh*, bandUpperHigh* (Hue, Sat, Temp only — no Luma). Hue: + = clockwise, − = counter-clockwise. Temp: − = cooler, + = warmer. Use bands to target shadows vs mids vs highlights.

Return JSON of deltas only. Omit keys for no change.`,
  6: `Phase 6: Refraction only. Fix specific object colors: car wrong red, tree wrong green, flower wrong pink. Fix individual, isolated colors that might have been ruined by the overall grade.

Parameters: refractionShadow.<color>.hue (0–360), .sat (0–3); refractionHighlight.<color>.hue, .sat; refractionSplitL (0–1). Defaults: red=0, yellow=60, green=120, teal=180, blue=240, purple=300. Green 120→115 = more orange; 120→125 = cooler/greener. Are you getting greens right? Check current params before adjusting.

Return JSON of deltas only. Omit keys for no change.`,
  7: `Phase 7: Actuance only. Microcontrast and sharpness.

Parameters: actuanceStrength (0.75–3): higher = stronger crispness. actuanceRadius (0.5–5): lower = fine detail only, higher = coarser structures.

Return JSON of deltas only. Omit keys for no change.`,
  8: `Phase 8: Halation only. Highlight bloom and rim.

Parameters: highlightFillStrength (0–2), highlightFillWarmth (-1–1), halationTailGamma (2–6, default 4), halationContrastGate (0–1), halationRimStrength (0–1), halationBloomStrength (0–1), halationRimRadius (0–0.75), halationBloomRadius (0–2.5).

Return JSON of deltas only. Omit keys for no change.`,
};

async function bufferFromBase64(dataUrlOrRaw: string | unknown): Promise<Buffer> {
  const str =
    typeof dataUrlOrRaw === "string"
      ? dataUrlOrRaw
      : typeof (dataUrlOrRaw as { data?: string })?.data === "string"
        ? (dataUrlOrRaw as { data: string }).data
        : null;
  if (!str) throw new Error("Invalid base64: expected string or object with .data string");
  const base64 = str.includes(",") ? str.split(",")[1] : str;
  if (!base64) throw new Error("Invalid base64");
  return Buffer.from(base64, "base64");
}


async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  maxAttempts: number,
  runId: string
): Promise<Response> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const res = await fetch(input, init);
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        console.error(
          `[openai-loop] OpenAI fetch non-OK (attempt ${attempt}/${maxAttempts})`,
          {
            status: res.status,
            statusText: res.statusText,
            body: bodyText.slice(0, 500),
            runId,
          }
        );
        lastError = new Error(
          `OpenAI API error: ${res.status} ${res.statusText} ${bodyText.slice(
            0,
            200
          )}`
        );
      } else {
        return res;
      }
    } catch (err) {
      lastError = err;
      console.error(
        `[openai-loop] OpenAI fetch failed (attempt ${attempt}/${maxAttempts})`,
        { error: err, runId }
      );
    }

    if (attempt < maxAttempts) {
      const delayMs = 500 * attempt * attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`OpenAI fetch failed after ${maxAttempts} attempts`);
}

const TRAINING_OUTPUTS_BUCKET = "training-outputs";

async function persistTrainingImage(
  frame: PixelFrameRGBA,
  runId: string,
  pairIndex: number,
  suffix: string
): Promise<string | null> {
  if (!supabaseAdmin) return null;
  try {
    const png = await frameToPngBuffer(frame, { maxEdge: EXPORT_MAX_EDGE });
    const path = `run-${runId}/pair-${pairIndex}-${suffix}.png`;
    try {
      await supabaseAdmin.storage.createBucket(TRAINING_OUTPUTS_BUCKET, {
        public: true,
        fileSizeLimit: 50 * 1024 * 1024,
      });
    } catch {
      // Bucket may already exist
    }
    const { error } = await supabaseAdmin.storage
      .from(TRAINING_OUTPUTS_BUCKET)
      .upload(path, png, { contentType: "image/png", upsert: true });
    if (error) {
      console.error("[openai-loop] persistTrainingImage upload failed:", error);
      return null;
    }
    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from(TRAINING_OUTPUTS_BUCKET).getPublicUrl(path);
    return publicUrl;
  } catch (err) {
    console.error("[openai-loop] persistTrainingImage failed:", err);
    return null;
  }
}

async function updateTrainingRun(
  runId: string,
  patch: {
    status?: string;
    current_iteration?: number;
    max_iterations?: number;
    error?: string | null;
    final_image_base64?: string | null;
    current_pair?: number;
    total_pairs?: number;
    recovery_image_url?: string | null;
    final_image_urls?: string[] | null;
  }
): Promise<void> {
  if (!supabaseAdmin) return;
  const updates: Record<string, unknown> = {};
  if ("status" in patch && patch.status !== undefined) updates.status = patch.status;
  if ("current_iteration" in patch && patch.current_iteration !== undefined)
    updates.current_iteration = patch.current_iteration;
  if ("max_iterations" in patch && patch.max_iterations !== undefined)
    updates.max_iterations = patch.max_iterations;
  if ("error" in patch) updates.error = patch.error;
  if ("final_image_base64" in patch) updates.final_image_base64 = patch.final_image_base64;
  if ("current_pair" in patch && patch.current_pair !== undefined)
    updates.current_pair = patch.current_pair;
  if ("total_pairs" in patch && patch.total_pairs !== undefined)
    updates.total_pairs = patch.total_pairs;
  if ("recovery_image_url" in patch) updates.recovery_image_url = patch.recovery_image_url;
  if ("final_image_urls" in patch) updates.final_image_urls = patch.final_image_urls ?? [];
  await supabaseAdmin.from("training_runs").update(updates).eq("id", runId);
}

function getPhasedSchedule(maxIter: number): {
  itersPerPhase: number;
  numRuns: number;
} {
  if (maxIter <= 15) return { itersPerPhase: 5, numRuns: 2 };
  if (maxIter <= 30) return { itersPerPhase: 10, numRuns: 2 };
  return { itersPerPhase: 10, numRuns: 4 };
}

async function runTrainingJob(options: {
  apiKey: string;
  requestUrl: string;
  runId: string;
  pairs: Array<{
    source_base64?: string;
    reference_base64?: string;
    source_url?: string;
    reference_url?: string;
  }>;
  maxIterations: number;
  cameraType: string | null;
  useLibraw?: boolean;
  phased?: boolean;
}): Promise<void> {
  const { apiKey, requestUrl, runId, pairs, maxIterations, cameraType, useLibraw, phased } = options;

  const { itersPerPhase, numRuns } = phased
    ? getPhasedSchedule(maxIterations)
    : { itersPerPhase: 0, numRuns: 1 };
  const totalPhaseIterations = phased
    ? numRuns * 8 * itersPerPhase
    : maxIterations;

  // Track the configured max_iterations and total pairs on the run up-front.
  await updateTrainingRun(runId, {
    status: "running",
    current_iteration: 0,
    max_iterations: phased ? totalPhaseIterations : maxIterations,
    error: null,
    final_image_base64: null,
    current_pair: 0,
    total_pairs: pairs.length,
    recovery_image_url: null,
    final_image_urls: [],
  });

  const finalImageUrls: string[] = [];
  const RETRY_WINDOW_MS = 6 * 60 * 1000; // 6 minutes

  try {
    for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
      let pairSucceeded = false;
      let lastFetchError: unknown;
      const retryWindowStart = Date.now();

      while (!pairSucceeded && Date.now() - retryWindowStart < RETRY_WINDOW_MS) {
        await updateTrainingRun(runId, {
          current_pair: pairIndex,
          total_pairs: pairs.length,
        });
        const pair = pairs[pairIndex];

        let sourceBuffer: Buffer;
        let referenceBuffer: Buffer;
        if (pair.source_base64 && pair.reference_base64) {
          sourceBuffer = await bufferFromBase64(pair.source_base64);
          referenceBuffer = await bufferFromBase64(pair.reference_base64);
        } else if (pair.source_url && pair.reference_url) {
          const [srcRes, refRes] = await Promise.all([
            fetch(pair.source_url),
            fetch(pair.reference_url),
          ]);
          if (!srcRes.ok || !refRes.ok) throw new Error("Failed to fetch URLs");
          sourceBuffer = Buffer.from(await srcRes.arrayBuffer());
          referenceBuffer = Buffer.from(await refRes.arrayBuffer());
        } else {
          throw new Error(
            "Each pair must have source_base64+reference_base64 or source_url+reference_url"
          );
        }

        // Run grading on the RAW source at high resolution. 4096px gives ~16MP; edits apply to
        // full dynamic range. Linear float pipeline preserves dynamic range.
        const PROCESS_MAX_EDGE = 4096;
        const sourceFrame: PixelFrameF32 = await decodeBufferToLinearFloat(
          sourceBuffer,
          PROCESS_MAX_EDGE
        );
        const referenceFrame: PixelFrameF32 = await decodeBufferToLinearFloat(
          referenceBuffer,
          PROCESS_MAX_EDGE
        );
        await new Promise<void>((r) => setImmediate(r));

        const exposureMap: ExposureMap = buildExposureMapFromFloat(sourceFrame);

        const engineParams = fitLookParamsFromReference(referenceFrame);
        const fittedGrading = engineToGrading(engineParams);
        const initialMatch = { ...DEFAULT_LOOK_PARAMS.match };
        let currentParams: LookParams = {
          match: initialMatch,
          grading: fittedGrading,
        };

        let lastDeltas: Record<string, number> = { one: 1 };
        let iterations = 0;
        let lastResultFrame: PixelFrameRGBA | null = null;
        let brokeDueToFetchError = false;

        const sourcePng = await frameToPngBuffer(
          pixelFrameF32ToPixelFrameRGBA(sourceFrame),
          { maxEdge: IMAGE_MAX_EDGE }
        );
        const sourceBase64 = sourcePng.toString("base64");

        const referencePng = await frameToPngBuffer(
          pixelFrameF32ToPixelFrameRGBA(referenceFrame),
          { maxEdge: IMAGE_MAX_EDGE }
        );
        const referenceBase64 = referencePng.toString("base64");

        if (phased) {
          let globalIterCount = 0;
          let bandAnchors: number[] | null = null;
          let secondLastResultBase64: string | null = null;
          let secondLastParams: Record<string, unknown> | null = null;
          for (let runIdx = 0; runIdx < numRuns; runIdx++) {
            for (let phase = 1; phase <= 8; phase++) {
              for (let phaseIter = 0; phaseIter < itersPerPhase; phaseIter++) {
                globalIterCount++;
                await updateTrainingRun(runId, {
                  current_iteration: globalIterCount,
                });
                const useHalation = phase === 8;
                const paramsForPhase: LookParams = useHalation
                  ? currentParams
                  : {
                      match: {
                        ...currentParams.match,
                        highlightFillStrength: 0,
                      },
                      grading: currentParams.grading,
                    };
                const enginePhase = buildEngineParamsFromLookParams(
                  paramsForPhase,
                  fittedGrading
                );
                const resultFramePhaseFloat = processFramesFloat(
                  sourceFrame,
                  referenceFrame,
                  {
                    strength: 1,
                    grading: enginePhase,
                    exposureMap: useHalation ? exposureMap : undefined,
                    colorBandAnchors: bandAnchors ?? undefined,
                  }
                );
                lastResultFrame = pixelFrameF32ToPixelFrameRGBA(resultFramePhaseFloat);
                if (phase === 1 && phaseIter === itersPerPhase - 1) {
                  bandAnchors = computeBandAnchorsFromFrame(resultFramePhaseFloat);
                }
                const resultPngPhase = await frameToPngBuffer(lastResultFrame, {
                  maxEdge: IMAGE_MAX_EDGE,
                });
                const resultBase64Phase = resultPngPhase.toString("base64");
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
                            ? "Per-band"
                            : phase === 6
                              ? "Refraction"
                              : phase === 7
                                ? "Actuance"
                                : "Halation";
                const hasSecondLast = secondLastResultBase64 != null;
                const includeSource = phase === 1 && !hasSecondLast;
                const paramsBeforeDeltas = JSON.stringify(currentParams.match);
                const secondLastText = hasSecondLast
                  ? `\nLast params (absolute): ${paramsBeforeDeltas}\nDeltas from second-last to last: ${JSON.stringify(lastDeltas)}\nSecond-last params (absolute): ${JSON.stringify(secondLastParams ?? {})}`
                  : "";
                const imgDesc = hasSecondLast
                  ? "Images: 1=result, 2=second-last edit, 3=reference."
                  : includeSource
                    ? "Images: 1=result, 2=reference, 3=pre-edit source. Use source to see original dark vs bright."
                    : "Images: 1=result, 2=reference.";
                const lastRunNote =
                  runIdx + 1 === numRuns
                    ? "\nYou are in the last run. The previous agents will have attempted to get the core parameters on point. Prioritize smaller adjustments.\n"
                    : "";
                const phaseUserText = `${PHASE_PROMPTS[phase as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8]}${lastRunNote}

Run ${runIdx + 1}/${numRuns}, Phase ${phase} (${phaseName}), iteration ${phaseIter + 1}/${itersPerPhase}.${secondLastText}

Current match parameters: ${paramsBeforeDeltas}

${imgDesc} Compare result to reference. Return JSON of parameter deltas only for this phase. Required: include a "description" field (short phrase) describing your intent, e.g. "lift shadows +0.2 EV" or "no change".`;

                const contentItems: Array<
                  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
                > = [
                  { type: "text", text: phaseUserText },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/png;base64,${resultBase64Phase}`,
                    },
                  },
                ];
                if (hasSecondLast) {
                  contentItems.push({
                    type: "image_url",
                    image_url: {
                      url: `data:image/png;base64,${secondLastResultBase64}`,
                    },
                  });
                }
                contentItems.push({
                  type: "image_url",
                  image_url: {
                    url: `data:image/png;base64,${referenceBase64}`,
                  },
                });
                if (includeSource) {
                  contentItems.push({
                    type: "image_url",
                    image_url: {
                      url: `data:image/png;base64,${sourceBase64}`,
                    },
                  });
                }

                const openaiResPhase = await fetchWithRetry(
                  "https://api.openai.com/v1/chat/completions",
                  {
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
                          content: contentItems,
                        },
                      ],
                    }),
                  },
                  3,
                  runId
                );
                if (!openaiResPhase.ok) {
                  const errBody = await openaiResPhase.text();
                  throw new Error(
                    `OpenAI API error: ${openaiResPhase.status} ${errBody}`
                  );
                }
                const dataPhase = (await openaiResPhase.json()) as {
                  choices?: Array<{ message?: { content?: string } }>;
                };
                const contentPhase =
                  dataPhase.choices?.[0]?.message?.content ?? "";
                let iterationDescription: string | undefined;
                try {
                  const parsed = JSON.parse(
                    contentPhase.trim().replace(/^```json?\s*|\s*```$/g, "")
                  ) as Record<string, unknown>;
                  if (
                    typeof parsed.description === "string" &&
                    parsed.description.trim().length > 0
                  ) {
                    iterationDescription = parsed.description.trim();
                  }
                } catch {
                  // ignore
                }
                const rawDeltas = parseJsonDeltas(contentPhase);
                const deltasPhase = filterPhaseDeltas(
                  phase as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
                  rawDeltas
                );
                try {
                  if (supabaseAdmin) {
                    await supabaseAdmin.from("training_iteration_logs").insert({
                    training_run_id: runId,
                    pair_index: pairIndex,
                    run_index: runIdx + 1,
                    phase,
                    phase_iteration: phaseIter + 1,
                    description: iterationDescription ?? "No description provided",
                    params_changed: Object.keys(deltasPhase).length > 0 ? deltasPhase : null,
                    });
                  }
                } catch (logErr) {
                  console.warn(
                    "[openai-loop] Failed to insert iteration log:",
                    logErr
                  );
                }
                secondLastResultBase64 = resultBase64Phase;
                secondLastParams = { ...currentParams.match };
                if (Object.keys(deltasPhase).length > 0) {
                  currentParams = applyGradingDeltas(
                    currentParams,
                    deltasPhase
                  );
                }
                lastDeltas = deltasPhase;
              }
            }
          }
          iterations = globalIterCount;
        } else {
        while (
          Object.keys(lastDeltas).length > 0 &&
          iterations < maxIterations &&
          !brokeDueToFetchError
        ) {
          iterations++;
          await updateTrainingRun(runId, {
            current_iteration: iterations,
          });

          try {
            // Substep 1: non-halation grading (halation strength=0). No exposure map. Halation early-exits.
            const paramsSubstep1: LookParams = {
              match: { ...currentParams.match, highlightFillStrength: 0 },
              grading: currentParams.grading,
            };
            const engine1 = buildEngineParamsFromLookParams(
              paramsSubstep1,
              fittedGrading
            );
            let resultFrame1: PixelFrameRGBA = pixelFrameF32ToPixelFrameRGBA(
              processFramesFloat(
                sourceFrame,
                referenceFrame,
                { strength: 1, grading: engine1, exposureMap: undefined }
              )
            );

            const referencePng = await frameToPngBuffer(
              pixelFrameF32ToPixelFrameRGBA(referenceFrame),
              { maxEdge: IMAGE_MAX_EDGE }
            );
            const referenceBase64 = referencePng.toString("base64");

            const resultPng1 = await frameToPngBuffer(resultFrame1, {
              maxEdge: IMAGE_MAX_EDGE,
            });
            const resultBase641 = resultPng1.toString("base64");

            const openaiRes1 = await fetchWithRetry(
              "https://api.openai.com/v1/chat/completions",
              {
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
                        {
                          type: "text",
                          text: (() => {
                            const isFirstIteration = iterations === 1;
                            const lastIsSentinel =
                              Object.keys(lastDeltas).length === 1 &&
                              (lastDeltas as Record<string, number>).one === 1;
                            const hasPreviousDeltas =
                              !isFirstIteration &&
                              !lastIsSentinel &&
                              Object.keys(lastDeltas).length > 0;
                            const lastDeltaText = hasPreviousDeltas
                              ? JSON.stringify(lastDeltas)
                              : "none (this is the first iteration or previous step produced no changes)";
                            const currentMatchText = JSON.stringify(
                              currentParams.match
                            );
                            const baseMatchText = JSON.stringify(initialMatch);
                            return `${OPENAI_SUBSTEP1_PROMPT}

This is iteration ${iterations} of ${maxIterations}, substep 1 (non-halation). iterations 1-15 get exposure, contrast, blackstength, exposurematch right. After that, get the core grading perfect: is each color looking 100% exactly like the reference? (ignore colors relating to halation).

Last iteration deltas: ${lastDeltaText}

Current match parameters: ${currentMatchText}

Baseline: ${baseMatchText}

Images: 1=result, 2=reference, 3=pre-edit source. Use the source to see what was originally dark vs bright when exposure has been pushed. Compare result to reference, return JSON of parameter deltas only.`;
                          })(),
                        },
                        {
                          type: "image_url",
                          image_url: {
                            url: `data:image/png;base64,${resultBase641}`,
                          },
                        },
                        {
                          type: "image_url",
                          image_url: {
                            url: `data:image/png;base64,${referenceBase64}`,
                          },
                        },
                        {
                          type: "image_url",
                          image_url: {
                            url: `data:image/png;base64,${sourceBase64}`,
                          },
                        },
                      ],
                    },
                  ],
                }),
              },
              3,
              runId
            );

            if (!openaiRes1.ok) {
              const errBody = await openaiRes1.text();
              throw new Error(
                `OpenAI API error: ${openaiRes1.status} ${errBody}`
              );
            }

            const data1 = (await openaiRes1.json()) as {
              choices?: Array<{ message?: { content?: string } }>;
            };
            const content1 = data1.choices?.[0]?.message?.content ?? "";
            const deltas1 = parseJsonDeltas(content1);
            const nonHalationDeltas = filterNonHalationDeltas(deltas1);
            if (Object.keys(nonHalationDeltas).length > 0) {
              currentParams = applyGradingDeltas(
                currentParams,
                nonHalationDeltas
              );
            }
            // Clear substep 1 result to help GC (Phase 4).
            resultFrame1 = null as unknown as PixelFrameRGBA;

            // Yield between substeps (memory-conscious pacing).
            await new Promise<void>((r) => setImmediate(r));
            if (typeof globalThis.gc === "function") globalThis.gc();
            const heapUsed = process.memoryUsage().heapUsed;
            if (heapUsed > 6 * 1024 * 1024 * 1024) {
              await new Promise((r) => setTimeout(r, 500));
            }

            // Substep 2: full halation. Build exposure map lazily here.
            const engine2 = buildEngineParamsFromLookParams(
              currentParams,
              fittedGrading
            );
            const resultFrame2 = pixelFrameF32ToPixelFrameRGBA(
              processFramesFloat(sourceFrame, referenceFrame, {
                strength: 1,
                grading: engine2,
                exposureMap,
              })
            );
            lastResultFrame = resultFrame2;

            const resultPng2 = await frameToPngBuffer(resultFrame2, {
              maxEdge: IMAGE_MAX_EDGE,
            });
            const resultBase642 = resultPng2.toString("base64");

            const openaiRes2 = await fetchWithRetry(
              "https://api.openai.com/v1/chat/completions",
              {
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
                        {
                          type: "text",
                          text: (() => {
                            const lastDeltaText = JSON.stringify(lastDeltas);
                            const currentMatchText = JSON.stringify(
                              currentParams.match
                            );
                            return `${OPENAI_SUBSTEP2_PROMPT}

This is iteration ${iterations} of ${maxIterations}, substep 2 (halation). Focus on highlight bloom/rim compared to reference.

Last deltas (both substeps): ${lastDeltaText}

Current match parameters: ${currentMatchText}

Images: 1=result, 2=reference, 3=pre-edit source. Compare result to reference, return JSON of halation parameter deltas only.`;
                          })(),
                        },
                        {
                          type: "image_url",
                          image_url: {
                            url: `data:image/png;base64,${resultBase642}`,
                          },
                        },
                        {
                          type: "image_url",
                          image_url: {
                            url: `data:image/png;base64,${referenceBase64}`,
                          },
                        },
                        {
                          type: "image_url",
                          image_url: {
                            url: `data:image/png;base64,${sourceBase64}`,
                          },
                        },
                      ],
                    },
                  ],
                }),
              },
              3,
              runId
            );

            if (!openaiRes2.ok) {
              const errBody = await openaiRes2.text();
              throw new Error(
                `OpenAI API error: ${openaiRes2.status} ${errBody}`
              );
            }

            const data2 = (await openaiRes2.json()) as {
              choices?: Array<{ message?: { content?: string } }>;
            };
            const content2 = data2.choices?.[0]?.message?.content ?? "";
            const deltas2 = parseJsonDeltas(content2);
            const halationDeltas = filterHalationDeltas(deltas2);
            if (Object.keys(halationDeltas).length > 0) {
              currentParams = applyGradingDeltas(
                currentParams,
                halationDeltas
              );
            }

            lastDeltas = { ...nonHalationDeltas, ...halationDeltas };
            if (Object.keys(lastDeltas).length === 0) break;
          } catch (fetchErr) {
          lastFetchError = fetchErr;
          const progress = iterations / maxIterations;
          const isNearlyComplete = progress >= 0.75;

          if (!isNearlyComplete) {
            const elapsedMin = ((Date.now() - retryWindowStart) / 60000).toFixed(
              1
            );
            console.error(
              `[openai-loop] Fetch failed at iteration ${iterations} (progress ${(progress * 100).toFixed(0)}%), retrying (${elapsedMin} of 6 min elapsed)`
            );
          }

          if (isNearlyComplete) {
            // Treat as success: save correction, persist final image, continue to next pair
            const sourceStats = computeImageStatsFromFloat(sourceFrame);
            const refStats = computeImageStatsFromFloat(referenceFrame);
            const correctionPayload = {
              sourceId: `openai-loop-pair-${pairIndex}-${Date.now()}`,
              referenceId: null,
              sourceFilename: "source.png",
              referenceFilename: "reference.png",
              autoParams: {
                match: ensureFullMatch(initialMatch),
                grading: fittedGrading,
              },
              correctedParams: {
                match: ensureFullMatch(currentParams.match),
                grading: currentParams.grading,
              },
              source_exposure: sourceStats.exposureLevel,
              source_chroma_distribution: sourceStats.chromaDistribution,
              reference_exposure: refStats.exposureLevel,
              reference_chroma_distribution: refStats.chromaDistribution,
              source_type: "png",
              camera_type: cameraType,
              completed_iterations: iterations,
            };
            try {
              const correctionRes = await fetch(
                new URL("/api/corrections", requestUrl).toString(),
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(correctionPayload),
                }
              );
              if (!correctionRes.ok) {
                const errData = (await correctionRes.json()) as {
                  error?: string;
                };
                console.error(
                  "[openai-loop] Failed to save corrections on fetch error (≥75%):",
                  errData.error
                );
              }
            } catch (postErr) {
              console.error(
                "[openai-loop] POST corrections on fetch error (≥75%):",
                postErr
              );
            }
            const frameToExport =
              lastResultFrame ??
              pixelFrameF32ToPixelFrameRGBA(
                processFramesFloat(sourceFrame, referenceFrame, {
                  strength: 1,
                  grading: buildEngineParamsFromLookParams(
                    currentParams,
                    fittedGrading
                  ),
                  exposureMap,
                })
              );
            const finalUrl = await persistTrainingImage(
              frameToExport,
              runId,
              pairIndex,
              "final"
            );
            if (finalUrl) finalImageUrls.push(finalUrl);
            const finalPng = await frameToPngBuffer(frameToExport, {
              maxEdge: EXPORT_MAX_EDGE,
            });
            await updateTrainingRun(runId, {
              current_iteration: iterations,
              final_image_base64: finalPng.toString("base64"),
              final_image_urls: finalImageUrls,
            });
            pairSucceeded = true;
          }
          brokeDueToFetchError = true;
        }
        }
        }

        if (pairSucceeded) break;

        if (brokeDueToFetchError) continue;

        // Normal success: exited while with empty deltas or max iterations
        const sourceStats = computeImageStatsFromFloat(sourceFrame);
        const refStats = computeImageStatsFromFloat(referenceFrame);

        const correctionPayload = {
          sourceId: `openai-loop-pair-${pairIndex}-${Date.now()}`,
          referenceId: null,
          sourceFilename: "source.png",
          referenceFilename: "reference.png",
          autoParams: {
            match: ensureFullMatch(initialMatch),
            grading: fittedGrading,
          },
          correctedParams: {
            match: ensureFullMatch(currentParams.match),
            grading: currentParams.grading,
          },
          source_exposure: sourceStats.exposureLevel,
          source_chroma_distribution: sourceStats.chromaDistribution,
          reference_exposure: refStats.exposureLevel,
          reference_chroma_distribution: refStats.chromaDistribution,
          source_type: "png",
          camera_type: cameraType,
          completed_iterations: iterations,
        };

        const correctionRes = await fetch(
          new URL("/api/corrections", requestUrl).toString(),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(correctionPayload),
          }
        );
        if (!correctionRes.ok) {
          const errData = (await correctionRes.json()) as { error?: string };
          throw new Error(errData.error ?? "Failed to POST correction");
        }

        const frameToExport =
          lastResultFrame ??
          pixelFrameF32ToPixelFrameRGBA(
            processFramesFloat(sourceFrame, referenceFrame, {
              strength: 1,
              grading: buildEngineParamsFromLookParams(
                currentParams,
                fittedGrading
              ),
              exposureMap,
            })
          );
        const finalPng = await frameToPngBuffer(frameToExport, {
          maxEdge: EXPORT_MAX_EDGE,
        });
        const finalImageBase64 = finalPng.toString("base64");

        const finalUrl = await persistTrainingImage(
          frameToExport,
          runId,
          pairIndex,
          "final"
        );
        if (finalUrl) finalImageUrls.push(finalUrl);

        await updateTrainingRun(runId, {
          current_iteration: iterations,
          final_image_base64: finalImageBase64,
          final_image_urls: finalImageUrls,
        });
        pairSucceeded = true;
      }

      if (!pairSucceeded) {
        console.error(
          `[openai-loop] Pair ${pairIndex} failed after 6 minutes of retries - skipping to next pair`
        );
        continue;
      }
    }

    await updateTrainingRun(runId, {
      status: "done",
      final_image_urls: finalImageUrls,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateTrainingRun(runId, {
      status: "error",
      error: message,
    });
  }
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY not set" }, { status: 401 });
  }

  let body: {
    pairs?: Array<{
      source_base64?: string;
      reference_base64?: string;
      source_url?: string;
      reference_url?: string;
    }>;
    max_iterations?: number;
    camera_type?: string | null;
    use_libraw?: boolean;
    phased?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const phased = body.phased ?? false;
  const rawMaxIter = body.max_iterations ?? 20;
  const maxIterations = phased
    ? rawMaxIter <= 15
      ? 10
      : rawMaxIter <= 30
        ? 20
        : 40
    : Math.max(5, Math.min(100, rawMaxIter));
  const pairs = body.pairs;
  const cameraType = body.camera_type ?? null;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return NextResponse.json(
      { error: "Body must include pairs: array of { source_base64, reference_base64 } or { source_url, reference_url }" },
      { status: 400 }
    );
  }

  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase not configured" },
      { status: 503 }
    );
  }

  // Create a training run row so the UI can poll status and progress.
  const { data, error } = await supabaseAdmin
    .from("training_runs")
    .insert({
      status: "pending",
      current_iteration: 0,
      max_iterations: maxIterations,
      camera_type: cameraType,
      error: null,
      final_image_base64: null,
    })
    .select("id")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to create training run" },
      { status: 500 }
    );
  }

  const runId: string = data.id;

  // Fire-and-forget background job; the request returns immediately with run_id.
  void runTrainingJob({
    apiKey,
    requestUrl: request.url,
    runId,
    pairs,
    maxIterations,
    cameraType,
    useLibraw: body.use_libraw ?? false,
    phased,
  });

  return NextResponse.json({
    run_id: runId,
    max_iterations: maxIterations,
  });
}
