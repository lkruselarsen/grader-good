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
import { decodeBuffer, frameToPngBuffer, resizeFrame } from "@/src/lib/pipeline/decodeNode";
import { processOne } from "@/src/lib/pipeline";
import { frameToImageData } from "@/src/lib/pipeline/exportStage";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";
import {
  engineToGrading,
  DEFAULT_LOOK_PARAMS,
  defaultRefractionWheel,
  default7HandleIdentity,
  defaultExposureCurve,
  defaultColorDensityCurve,
  defaultContrastCurve,
} from "@/lib/look-params";
import { buildEngineParamsFromLookParams } from "@/lib/build-engine-params";
import { computeImageStats } from "@/src/lib/pipeline/imageStats";
import type { LookParams, LookParamsMatch } from "@/lib/look-params";
import type { PixelFrameRGBA } from "@/src/lib/pipeline/types";
import { supabaseAdmin } from "@/lib/supabase/server";

const IMAGE_MAX_EDGE = 1536;
const TRAINING_RESIZE_MAX_EDGE = 2048;

const OPENAI_SYSTEM_PROMPT = `
You compare a graded RESULT image to a REFERENCE image and suggest NUMERIC parameter deltas so the result looks as close as possible to the reference. RAW source might be underexposed: Use the exposure curve to fix from start.
You will be grading a digital raw image to look exactly like a film reference. Film reference might have split colors highlights vs shadows, Use Per‑band temperature for that temperature split.
Film has both unique color seperation and density, so keep your eyes out for individual objects colors not matching the reference:
Examples: A car with the wrong red, a tree with the wrong green, a flower with the wrong pink: Use  Refraction (Highlight/Shadow)(hue [0-360], saturation [0-3]) to nudge a color in a different direction. 


Output rules:
- Return a single JSON object ONLY (no prose, no markdown).
- Each key is a parameter name, each value is a numeric delta TO ADD to the current value.
- Omit keys for “no change”.



You may adjust these MATCH parameters (JSON keys):

Scalar match controls:
- exposureStrength (0–1.5): strength of matching a simiplied version of the reference exposure.
  - Positive delta → (towards simiplied reference exposure).
  - Negative delta → (towards source exposure).
- colorStrength (0–1.8): how strongly colors pull towards a simplified model ofthe reference; 0 = source color, 1 = match reference, >1 exaggerates the reference. (be aware, it will not translate color seperation very well)
- blackStrength (3–8): how strongly shadows and blacks are pulled towards the reference’s black depth; high values are valid when the reference has very deep blacks.
- blackRange (0.3–1.8): upper luminance bound for the black/shadow pull; higher values extend the black adjustment further into midtones.
- blackPoint (0–0.3, training clamp): black floor anchor; decreasing this deepens blacks, increasing this lifts blacks slightly.

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

Highlight fill and actuance:
- highlightFillStrength (0–1): highlight bloom/density strength.
  - Higher values add more veiling glow around bright specular regions.
- highlightFillWarmth (-1–1): tint for the highlight fill.
  - Negative = cooler bloom, positive = warmer bloom.
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

7‑handle curves (tonal and colour density shaping):

Exposure curve:
- exposureCurve.L_out_0 … exposureCurve.L_out_6 (0–2):
  - Exposure multipliers at fixed input anchors [0, 1/6, 2/6, 3/6, 4/6, 5/6, 1].
  - 1 = neutral, >1 brightens that tonal region, <1 darkens it.
  - Handles blend smoothly between neighbours.
  - Example: raising handle 3 and 4 brightens midtones; lowering handle 0 and 1 deepens shadows.

Color density curve:
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

Grading‑side tone and saturation curves:
- toneCurve.L_out_0 … toneCurve.L_out_6 (0–1):
  - Final grading tone curve outputs at fixed anchors; 0 = black, 1 = white.
  - Raising values lifts that tonal region; lowering values deepens it.
- saturationByL.scale_0 … saturationByL.scale_15 (0.2–2.5) [if present]:
  - Per‑L saturation scalars in grading; >1 increases saturation at that L anchor, <1 decreases it.


JSON output schema:
- Keys you may emit include (but are not limited to):
  - Scalar: exposureStrength, blackStrength, blackRange, blackPoint, highlightFillStrength, highlightFillWarmth, actuanceStrength, actuanceRadius.
  - Band hue/temp: bandLowerShadow, bandUpperShadow, bandMid, bandLowerHigh, bandUpperHigh, and all corresponding *Hue, *Sat, *Luma, *Temp fields listed above.
  - Refraction: refractionShadow.<color>.hue / .sat, refractionHighlight.<color>.hue / .sat, refractionSplitL.
  - Curves: exposureCurve.L_out_0 … L_out_6, colorDensityCurve.scale_0 … scale_6, contrastCurve.values_0 … values_6, toneCurve.L_out_0 … L_out_6.
- Values MUST be numeric deltas (e.g. 0.1, -0.05). Do NOT output nested objects, arrays, strings, or booleans.

Example (structure only):
{"exposureStrength": 0.05, "blackStrength": 0.8, "blackPoint": -0.02, "bandMidTemp": -0.1, "refractionHighlight.green.hue": -15, "contrastCurve.values_3": 0.5}

Return ONLY valid JSON.`;


const CLAMP_MAP: Record<string, [number, number]> = {
  exposureStrength: [0, 2],
  // Training and AI can easily over-drive luma on underexposed RAWs; keep this conservative.
  lumaStrength: [0, 0.5],
  colorStrength: [0, 2],
  blackStrength: [0, 8],
  blackRange: [0.2, 1.8],
  // Avoid extremely high blackPoint values from AI that would cause flat, milky blacks.
  blackPoint: [0, 0.3],
  colorDensity: [0.5, 2],
  bandLowerShadow: [0, 2],
  bandUpperShadow: [0, 2],
  bandMid: [0, 2],
  bandLowerHigh: [0, 2],
  bandUpperHigh: [0, 2],
  highlightFillStrength: [0, 1],
  highlightFillWarmth: [-1, 1],
  actuanceStrength: [0, 3],
  actuanceRadius: [0.5, 5],
  bandLowerShadowHue: [-1, 1],
  bandUpperShadowHue: [-1, 1],
  bandMidHue: [-1, 1],
  bandLowerHighHue: [-1, 1],
  bandUpperHighHue: [-1, 1],
  bandLowerShadowSat: [0, 2],
  bandUpperShadowSat: [0, 2],
  bandMidSat: [0, 2],
  bandLowerHighSat: [0, 2],
  bandUpperHighSat: [0, 2],
  bandLowerShadowLuma: [-0.2, 0.2],
  bandUpperShadowLuma: [-0.2, 0.2],
  bandMidLuma: [-0.2, 0.2],
  bandLowerHighLuma: [-0.2, 0.2],
  bandUpperHighLuma: [-0.2, 0.2],
  // Simple scalar refraction split goes directly on LookParamsMatch.
  refractionSplitL: [0, 1],
  // Per-band colour temperature (cold ↔ warm).
  bandLowerShadowTemp: [-1, 1],
  bandUpperShadowTemp: [-1, 1],
  bandMidTemp: [-1, 1],
  bandLowerHighTemp: [-1, 1],
  bandUpperHighTemp: [-1, 1],
};

function applyScalarMatchDeltas(
  match: LookParamsMatch,
  deltas: Record<string, number>
): LookParamsMatch {
  const next: LookParamsMatch = { ...match };
  for (const [key, delta] of Object.entries(deltas)) {
    if (typeof delta !== "number" || !Number.isFinite(delta)) continue;
    // Skip any refraction/curve-style keys here; they are handled separately.
    if (
      key.startsWith("refractionShadow.") ||
      key.startsWith("refractionHighlight.") ||
      key.startsWith("exposureCurve.") ||
      key.startsWith("colorDensityCurve.") ||
      key.startsWith("toneCurve.") ||
      key.startsWith("contrastCurve.")
    ) {
      continue;
    }
    const current = (next as unknown as Record<string, unknown>)[key];
    const base =
      typeof current === "number"
        ? current
        : (DEFAULT_LOOK_PARAMS.match as unknown as Record<string, unknown>)[key];
    const numericBase = typeof base === "number" ? base : 0;
    const [min, max] = CLAMP_MAP[key] ?? [numericBase - 2, numericBase + 2];
    const value = numericBase + delta;
    (next as unknown as Record<string, number>)[key] = Math.max(
      min,
      Math.min(max, value)
    );
  }
  return next;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function applyRefractionAndCurveDeltas(
  params: LookParams,
  deltas: Record<string, number>
): LookParams {
  const next: LookParams = {
    match: { ...params.match },
    grading: { ...params.grading },
  };

  // Ensure optional nested structures exist when needed.
  function ensureRefractionWheel(field: "refractionShadow" | "refractionHighlight") {
    if (!next.match[field]) {
      next.match[field] = defaultRefractionWheel();
    }
    return next.match[field]!;
  }

  function ensureExposureCurve() {
    if (!next.match.exposureCurve) {
      next.match.exposureCurve = defaultExposureCurve();
    }
    return next.match.exposureCurve!;
  }

  function ensureContrastCurve() {
    if (!next.match.contrastCurve) {
      next.match.contrastCurve = defaultContrastCurve();
    }
    return next.match.contrastCurve!;
  }

  function ensureColorDensityCurve() {
    if (!next.match.colorDensityCurve) {
      next.match.colorDensityCurve = defaultColorDensityCurve();
    }
    return next.match.colorDensityCurve!;
  }

  function ensureToneCurve() {
    if (!next.grading.toneCurve) {
      // Tone curve uses the same 7-handle structure (L_in/L_out).
      next.grading.toneCurve = default7HandleIdentity();
    }
    return next.grading.toneCurve!;
  }

  const colorIndex: Record<string, number> = {
    red: 0,
    yellow: 1,
    green: 2,
    teal: 3,
    blue: 4,
    purple: 5,
  };

  for (const [key, delta] of Object.entries(deltas)) {
    if (typeof delta !== "number" || !Number.isFinite(delta)) continue;

    // Refraction wheels: refractionShadow.red.hue / .sat etc.
    const refractionMatch = key.match(
      /^refraction(Shadow|Highlight)\.(red|yellow|green|teal|blue|purple)\.(hue|sat)$/
    );
    if (refractionMatch) {
      const [, which, color, channel] = refractionMatch as [
        string,
        "Shadow" | "Highlight",
        keyof typeof colorIndex,
        "hue" | "sat"
      ];
      const wheelField =
        which === "Shadow" ? "refractionShadow" : "refractionHighlight";
      const wheel = ensureRefractionWheel(wheelField);
      const idx = colorIndex[color];
      const node = wheel[idx];
      if (channel === "hue") {
        node.hue = clamp(node.hue + delta, 0, 360);
      } else {
        node.sat = clamp(node.sat + delta, 0, 3);
      }
      continue;
    }

    // Exposure curve handles: exposureCurve.L_out_0 ... L_out_6 (0..2, 1 = neutral)
    const expCurveMatch = key.match(/^exposureCurve\.L_out_(\d+)$/);
    if (expCurveMatch) {
      const idx = parseInt(expCurveMatch[1]!, 10);
      const curve = ensureExposureCurve();
      if (idx >= 0 && idx < curve.L_out.length) {
        const base = curve.L_out[idx] ?? 1;
        curve.L_out[idx] = clamp(base + delta, 0, 2);
      }
      continue;
    }

    // Contrast curve handles: contrastCurve.values_0 ... values_6 (-5..+5)
    const contrastCurveMatch = key.match(/^contrastCurve\.values_(\d+)$/);
    if (contrastCurveMatch) {
      const idx = parseInt(contrastCurveMatch[1]!, 10);
      const curve = ensureContrastCurve();
      if (idx >= 0 && idx < curve.values.length) {
        const base = curve.values[idx] ?? 0;
        curve.values[idx] = clamp(base + delta, -5, 5);
      }
      continue;
    }

    // Color density curve handles: colorDensityCurve.scale_0 ... scale_6
    const cdCurveMatch = key.match(/^colorDensityCurve\.scale_(\d+)$/);
    if (cdCurveMatch) {
      const idx = parseInt(cdCurveMatch[1]!, 10);
      const curve = ensureColorDensityCurve();
      if (idx >= 0 && idx < curve.scale.length) {
        const base = curve.scale[idx] ?? 1;
        curve.scale[idx] = clamp(base + delta, 0.2, 2.5);
      }
      continue;
    }

    // Tone curve handles: toneCurve.L_out_0 ... L_out_6 (grading stage).
    const toneCurveMatch = key.match(/^toneCurve\.L_out_(\d+)$/);
    if (toneCurveMatch) {
      const idx = parseInt(toneCurveMatch[1]!, 10);
      const curve = ensureToneCurve();
      if (idx >= 0 && idx < curve.L_out.length) {
        const base = curve.L_out[idx] ?? curve.L_in[idx] ?? idx / 6;
        curve.L_out[idx] = clamp(base + delta, 0, 1);
      }
      continue;
    }
  }

  return next;
}

function applyDeltasToParams(
  params: LookParams,
  deltas: Record<string, number>
): LookParams {
  // First, update simple scalar match params (including refractionSplitL).
  const scalarUpdatedMatch = applyScalarMatchDeltas(params.match, deltas);
  const withScalars: LookParams = {
    match: scalarUpdatedMatch,
    grading: params.grading,
  };
  // Then, handle refraction wheels and curve handles using the same deltas.
  return applyRefractionAndCurveDeltas(withScalars, deltas);
}

/** Ensures match has all optional curve/refraction fields so corrections table and learn job see full structure. */
function ensureFullMatch(match: LookParamsMatch): LookParamsMatch {
  const m = { ...match };
  if (!m.exposureCurve) m.exposureCurve = defaultExposureCurve();
  if (!m.contrastCurve) m.contrastCurve = defaultContrastCurve();
  if (!m.refractionShadow) m.refractionShadow = defaultRefractionWheel();
  if (!m.refractionHighlight) m.refractionHighlight = defaultRefractionWheel();
  if (m.refractionSplitL === undefined) m.refractionSplitL = 0.5;
  if (!m.colorDensityCurve) m.colorDensityCurve = defaultColorDensityCurve();
  return m;
}

function parseJsonDeltas(text: string): Record<string, number> {
  const trimmed = text.trim().replace(/^```json?\s*|\s*```$/g, "");
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

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

async function updateTrainingRun(
  runId: string,
  patch: {
    status?: string;
    current_iteration?: number;
    max_iterations?: number;
    error?: string | null;
    final_image_base64?: string | null;
  }
): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from("training_runs")
    .update({
      ...("status" in patch ? { status: patch.status } : {}),
      ...("current_iteration" in patch
        ? { current_iteration: patch.current_iteration }
        : {}),
      ...("max_iterations" in patch ? { max_iterations: patch.max_iterations } : {}),
      ...("error" in patch ? { error: patch.error } : {}),
      ...("final_image_base64" in patch
        ? { final_image_base64: patch.final_image_base64 }
        : {}),
    })
    .eq("id", runId);
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

  // Track the configured max_iterations on the run up-front.
  await updateTrainingRun(runId, {
    status: "running",
    current_iteration: 0,
    max_iterations: maxIterations,
    error: null,
    final_image_base64: null,
  });

  try {
    for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
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

      let sourceFrame: PixelFrameRGBA = await decodeBuffer(sourceBuffer);
      let referenceFrame: PixelFrameRGBA = await decodeBuffer(referenceBuffer);

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

      while (Object.keys(lastDeltas).length > 0 && iterations < maxIterations) {
        iterations++;
        await updateTrainingRun(runId, {
          current_iteration: iterations,
        });

        const engine = buildEngineParamsFromLookParams(currentParams, fittedGrading);
        const resultFrame = await processOne(sourceFrame, referenceFrame, {
          strength: 1,
          grading: engine,
        });
        lastResultFrame = resultFrame;

        const resultPng = await frameToPngBuffer(resultFrame, {
          maxEdge: IMAGE_MAX_EDGE,
        });
        const referencePng = await frameToPngBuffer(referenceFrame, {
          maxEdge: IMAGE_MAX_EDGE,
        });

        const resultBase64 = resultPng.toString("base64");
        const referenceBase64 = referencePng.toString("base64");

        const openaiRes = await fetchWithRetry(
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

                        return `This is iteration ${iterations} of ${maxIterations}. Early iterations can use larger experimental changes; late iterations should make smaller, targeted adjustments.

Last iteration deltas (JSON, applied before rendering this graded result): ${lastDeltaText}

Current match parameters (after applying all previous deltas): ${currentMatchText}

Baseline match parameters before any deltas: ${baseMatchText}

Compare the first image (graded result) to the second (reference). Based on the visual differences and the parameter context above, return a JSON object of parameter deltas only. Omit keys for no change.`;
                      })(),
                    },
                    {
                      type: "image_url",
                      image_url: { url: `data:image/png;base64,${resultBase64}` },
                    },
                    {
                      type: "image_url",
                      image_url: { url: `data:image/png;base64,${referenceBase64}` },
                    },
                  ],
                },
              ],
            }),
          },
          3,
          runId
        );

        if (!openaiRes.ok) {
          const errBody = await openaiRes.text();
          throw new Error(`OpenAI API error: ${openaiRes.status} ${errBody}`);
        }

        const data = (await openaiRes.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content ?? "";
        lastDeltas = parseJsonDeltas(content);
        if (Object.keys(lastDeltas).length === 0) break;

        currentParams = applyDeltasToParams(currentParams, lastDeltas);
      }

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
        (await processOne(sourceFrame, referenceFrame, {
          strength: 1,
          grading: buildEngineParamsFromLookParams(currentParams, fittedGrading),
        }));
      const finalPng = await frameToPngBuffer(frameToExport, {
        maxEdge: IMAGE_MAX_EDGE,
      });
      const finalImageBase64 = finalPng.toString("base64");

      await updateTrainingRun(runId, {
        current_iteration: iterations,
        final_image_base64: finalImageBase64,
      });
    }

    await updateTrainingRun(runId, {
      status: "done",
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
