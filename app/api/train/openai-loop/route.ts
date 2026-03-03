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
  decodeBuffer,
  decodeBufferLinear,
  frameToPngBuffer,
} from "@/src/lib/pipeline/decodeNode";
import { processFrames } from "@/src/lib/pipeline/processFrames";
import {
  buildExposureMapFromLinearRgb,
  buildExposureMapFromSrgb,
  type ExposureMap,
} from "@/src/lib/pipeline/exposureMap";
import { frameToImageData } from "@/src/lib/pipeline/exportStage";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";
import {
  engineToGrading,
  DEFAULT_LOOK_PARAMS,
} from "@/lib/look-params";
import {
  applyGradingDeltas,
  filterNonHalationDeltas,
  filterHalationDeltas,
  ensureFullMatch,
  parseJsonDeltas,
} from "@/lib/apply-grading-deltas";
import { buildEngineParamsFromLookParams } from "@/lib/build-engine-params";
import { computeImageStats } from "@/src/lib/pipeline/imageStats";
import type { LookParams, LookParamsMatch } from "@/lib/look-params";
import type { PixelFrameRGBA } from "@/src/lib/pipeline/types";
import { supabaseAdmin } from "@/lib/supabase/server";

/** Max edge for images sent to OpenAI (evaluation prompt). At least 2048 for color accuracy. */
const IMAGE_MAX_EDGE = 2048;
/** Max edge for final export PNG (much larger than evaluation; e.g. 30MB for high-res). */
const EXPORT_MAX_EDGE = 8192;

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
- Omit keys for “no change”.


You may adjust these MATCH parameters (JSON keys):

Scalar match controls:
- exposureStrength (0–1.9): strength of matching a simiplied version of the reference exposure.
  - Positive delta → (towards simiplied reference exposure).
  - Negative delta → (towards source exposure).
- colorStrength (0–1.8): how strongly colors pull towards a simplified model ofthe reference; 0 = source color, 1 = match reference, >1 exaggerates the reference. (be aware, it will not translate color seperation very well)
- blackStrength (3–8): how strongly shadows and blacks are pulled towards the reference’s black depth; high values are valid when the reference has very deep blacks.
- blackRange (0.3–1.8): upper luminance bound for the black/shadow pull; higher values extend the black adjustment further into midtones.
- blackPoint (0–0.3, training clamp): black floor anchor; decreasing this deepens blacks, increasing this lifts blacks slightly.

7‑handle curves (tonal and colour density shaping):

Exposure curve:
- exposureCurve.L_out_0 … exposureCurve.L_out_6 (0–2):
  - Exposure multipliers at fixed input anchors [0, 1/6, 2/6, 3/6, 4/6, 5/6, 1].
  - 1 = neutral, >1 brightens that tonal region, <1 darkens it.
  - Handles blend smoothly between neighbours.
  - Example: raising handle 3 and 4 brightens midtones; lowering handle 0 and 1 deepens shadows.

Color density curve. Film has strong color density in the midtones and lower highlights, less density in shadows and upper highlights:
- colorDensityCurve.scale_0 … colorDensityCurve.scale_6 (0.2–2.5):
  - Per‑tonal‑region chroma scales at the same 7 anchors.
  - >1 increases saturation around that L; <1 reduces it.
  - Use this when only specific luminance ranges (e.g. bright highlights) are too saturated or too flat.

Filmic contrast curve:
- contrastCurve.values_0 … contrastCurve.values_6 (-5 to +5):
  - One value per handle, mapping to tonal zones:
    - 0 = darkest shadows (H1)
    - 1 = shadows (H2)
    - 2 = mid‑shadows (H3)
    - 3 = midtones (H4)
    - 4 = mid‑high (H5)
    - 5 = highlights (H6)
    - 6 = brightest highlights (H7)
  - The underlying curve is FILMIC: negative values increase density (deeper, richer darkening), positive values create a subtle bleach‑bypass feel (brighter, lower density).
  - Default “no‑change” filmic shape is:
    - H1: -5, H2: -3.5, H3: -1.75, H4: 0, H5: +1.75, H6: +3.5, H7: +5.
  - You suggest DELTAS to these values, e.g. "contrastCurve.values_3": 0.5 to slightly brighten midtones.
  - The curve is smoothly interpolated between handles; extreme endpoints are constrained so H1/H2 and H6/H7 cannot move too far from their defaults.

Five-band colour shaping:
- bandLowerShadowHue, bandUpperShadowHue, bandMidHue, bandLowerHighHue, bandUpperHighHue (-1–1):
  - Per‑band hue rotation. Increasing shifts hue CLOCKWISE around the color wheel; decreasing shifts COUNTER‑CLOCKWISE.
  - Example for blues: +delta moves blue → purple, −delta moves blue → teal.

Per‑band temperature (cold ↔ warm):
- bandLowerShadowTemp, bandUpperShadowTemp, bandMidTemp, bandLowerHighTemp, bandUpperHighTemp (-1–1):
  - Per‑band color temperature controls along the OKLab b‑axis.
  - Negative values make that band COOLER (more blue/cyan).
  - Positive values make that band WARMER (more yellow/orange).
  - If only shadows are too warm, use NEGATIVE temp only in shadow bands; if only highlights are too warm, cool the highlight bands, etc.

Highlight fill (halation):
- highlightFillStrength (0–1): overall halation strength.
- highlightFillWarmth (-1–1): tint for halation (negative = cooler, positive = warmer).
- halationTailGamma (2–6): stepper curve so ultra-highlights (99.99%) dominate over lower (98%). Default 4.
- halationContrastGate (0–1): dark-neighbor gating; strong at highlight vs shadow edges, weak between highlight plateaus.
- halationRimStrength (0–1): thin red edge component. halationBloomStrength (0–1): soft bloom component.
- halationRimRadius (0–2): rim blur radius as % of image short edge (resolution-independent). halationBloomRadius (0–10): bloom blur radius as % of image short edge.

Actuance: Film is known to have stronger microcontrast in the midtones.
- actuanceStrength (0.75–3): local contrast (microcontrast) strength on fine/medium details.
  - Higher values increase crispness; near 0.75 is subtle, near 3 is very strong.
- actuanceRadius (0.5–5): actuance radius.
  - Lower values → only very fine detail; higher values → coarser structures.

Refraction wheels (shadow/highlight colour remapping):
- refractionShadow.<color>.hue (0–360) and refractionHighlight.<color>.hue (0–360):
  - Per‑wheel hue targets in degrees for each of six colours: red, yellow, green, teal, blue, purple.
  - Defaults are: red=0, yellow=60, green=120, teal=180, blue=240, purple=300.
  - Setting green.hue to 110 makes greens slightly yellower/warmer; And setting green.hue to 160 would push it less warm and more teal, etc.
- refractionShadow.<color>.sat and refractionHighlight.<color>.sat (0–3):
  - Per‑wheel saturation multipliers. 0 = completely desaturated, 1 = unchanged, 3 = 3× saturation.
- refractionSplitL (0–1):
  - Luminance split between shadow and highlight wheels.
  - Lower values → more of the image uses the SHADOW wheel.
  - Higher values → more uses the HIGHLIGHT wheel.
Use refraction when specific hues in shadows or highlights are wrong even after band controls (e.g. “greens too cyan only in highlights”).

Grading‑side tone and saturation curves:
- toneCurve.L_out_0 … toneCurve.L_out_6 (0–1):
  - Final grading tone curve outputs at fixed anchors; 0 = black, 1 = white.
  - Raising values lifts that tonal region; lowering values deepens it.
- saturationByL.scale_0 … saturationByL.scale_15 (0.2–2.5) [if present]:
  - Per‑L saturation scalars in grading; >1 increases saturation at that L anchor, <1 decreases it.

JSON output schema:
- Keys you may emit include (but are not limited to):
  - Scalar: exposureStrength, blackStrength, blackRange, blackPoint, highlightFillStrength, highlightFillWarmth, halationTailGamma, halationContrastGate, halationRimStrength, halationBloomStrength, halationRimRadius, halationBloomRadius, actuanceStrength, actuanceRadius.
  - Band hue/temp: bandLowerShadow, bandUpperShadow, bandMid, bandLowerHigh, bandUpperHigh, and all corresponding *Hue, *Sat, *Luma, *Temp fields listed above.
  - Refraction: refractionShadow.<color>.hue / .sat, refractionHighlight.<color>.hue / .sat, refractionSplitL.
  - Curves: exposureCurve.L_out_0 … L_out_6, colorDensityCurve.scale_0 … scale_6, contrastCurve.values_0 … values_6, toneCurve.L_out_0 … L_out_6.
- Values MUST be numeric deltas (e.g. 0.1, -0.05). Do NOT output nested objects, arrays, strings, or booleans.

Example (structure only):
{"exposureStrength": 0.05, "blackStrength": 0.8, "blackPoint": -0.02, "bandMidTemp": -0.1, "refractionHighlight.green.hue": -15, "contrastCurve.values_3": 0.5}

Return ONLY valid JSON.`;

/** Substep 1: non-halation params only. Halation is disabled (strength=0) in this substep. */
const OPENAI_SUBSTEP1_PROMPT = `Focus on exposure, contrast, color density, curves, refraction, per-band controls. Do NOT adjust halation params.
Omit: highlightFillStrength, highlightFillWarmth, halationTailGamma, halationContrastGate, halationRimStrength, halationBloomStrength, halationRimRadius, halationBloomRadius.
Return a single JSON object of parameter deltas only. Omit keys for no change. Values must be numeric deltas.`;

/** Substep 2: halation params only. */
const OPENAI_SUBSTEP2_PROMPT = `Focus ONLY on halation (highlight bloom/rim). Compare highlight bloom and rim to the reference.
Adjust only: highlightFillStrength (0–1), highlightFillWarmth (-1–1), halationTailGamma (2–6), halationContrastGate (0–1), halationRimStrength (0–1), halationBloomStrength (0–1), halationRimRadius (0–2), halationBloomRadius (0–10).
Return a single JSON object of parameter deltas only. Omit keys for no change. Values must be numeric deltas.`;

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
}): Promise<void> {
  const { apiKey, requestUrl, runId, pairs, maxIterations, cameraType } = options;

  // Track the configured max_iterations and total pairs on the run up-front.
  await updateTrainingRun(runId, {
    status: "running",
    current_iteration: 0,
    max_iterations: maxIterations,
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
        // full dynamic range. Two-substep + lazy exposure map + memory pacing reduce OOM risk.
        const PROCESS_MAX_EDGE = 4096;
        const sourceFrame: PixelFrameRGBA = await decodeBuffer(sourceBuffer, PROCESS_MAX_EDGE);
        const referenceFrame: PixelFrameRGBA = await decodeBuffer(referenceBuffer, PROCESS_MAX_EDGE);
        // Yield to event loop after RAW decode before heavy processing (memory-conscious pacing).
        await new Promise<void>((r) => setImmediate(r));
        // Lazy exposure map: built only when halation runs (substep 2). Saves ~12MB at 1MP until needed.
        // Try linear RAW decode first so rawBoost uses true RAW luminance; fallback to sRGB for non-RAW.
        let exposureMap: ExposureMap | null = null;
        async function getExposureMap(): Promise<ExposureMap> {
          if (!exposureMap) {
            const linearFrame = await decodeBufferLinear(
              sourceBuffer,
              PROCESS_MAX_EDGE
            );
            if (linearFrame) {
              exposureMap = buildExposureMapFromLinearRgb(
                linearFrame.width,
                linearFrame.height,
                linearFrame.data,
                4
              );
            } else {
              exposureMap = buildExposureMapFromSrgb(sourceFrame);
            }
          }
          return exposureMap;
        }

        const refImageData = frameToImageData(referenceFrame);
        const engineParams = fitLookParamsFromReference(refImageData);
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
            let resultFrame1: PixelFrameRGBA = processFrames(
              sourceFrame,
              referenceFrame,
              { strength: 1, grading: engine1, exposureMap: undefined }
            );

            const referencePng = await frameToPngBuffer(referenceFrame, {
              maxEdge: IMAGE_MAX_EDGE,
            });
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

This is iteration ${iterations} of ${maxIterations}, substep 1 (non-halation). iterations 1-10 get exposure and contrast right. If exposure and contrast are ~90% correct, pick up refraction, per-band temp, hue.

Last iteration deltas: ${lastDeltaText}

Current match parameters: ${currentMatchText}

Baseline: ${baseMatchText}

Compare the first image (result) to the second (reference). Return JSON of parameter deltas only.`;
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
            const resultFrame2 = processFrames(sourceFrame, referenceFrame, {
              strength: 1,
              grading: engine2,
              exposureMap: await getExposureMap(),
            });
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

Compare the first image (result) to the second (reference). Return JSON of halation parameter deltas only.`;
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
            const sourceStats = computeImageStats(
              frameToImageData(sourceFrame)
            );
            const refStats = computeImageStats(
              frameToImageData(referenceFrame)
            );
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
              processFrames(sourceFrame, referenceFrame, {
                strength: 1,
                grading: buildEngineParamsFromLookParams(
                  currentParams,
                  fittedGrading
                ),
                exposureMap: await getExposureMap(),
              });
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

        if (pairSucceeded) break;

        if (brokeDueToFetchError) continue;

        // Normal success: exited while with empty deltas or max iterations
        const sourceStats = computeImageStats(frameToImageData(sourceFrame));
        const refStats = computeImageStats(frameToImageData(referenceFrame));

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
          processFrames(sourceFrame, referenceFrame, {
            strength: 1,
            grading: buildEngineParamsFromLookParams(
              currentParams,
              fittedGrading
            ),
            exposureMap: await getExposureMap(),
          });
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
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const pairs = body.pairs;
  const maxIterations = Math.max(5, Math.min(100, body.max_iterations ?? 20));
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
  });

  return NextResponse.json({
    run_id: runId,
    max_iterations: maxIterations,
  });
}
