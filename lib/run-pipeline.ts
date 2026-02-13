/**
 * Pipeline contract for the Lab UI: source + reference + params → draw to canvas.
 * Runs the real pipeline (decode → match → halation → grain) and exports to canvas.
 */

import type { LookParams, LookParamsGrading } from "./look-params";
import {
  gradingToEngine,
  engineToGrading,
  DEFAULT_LOOK_PARAMS,
} from "./look-params";
import {
  processOne,
  exportToCanvas,
  frameToImageData,
  decode,
  computeImageStats,
  type ImageStats,
} from "@/src/lib/pipeline";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";

const MAX_PREVIEW_EDGE = 1600;

/**
 * Draw the raw source image to the canvas (no grading). Use when source is
 * uploaded so the user sees a preview before clicking Apply.
 * If signal is aborted before drawing, skips the canvas update (caller may abort when Apply is clicked).
 */
export async function previewSource(
  sourceFile: File,
  canvas: HTMLCanvasElement,
  signal?: AbortSignal
): Promise<void> {
  const frame = await decode(sourceFile);
  if (signal?.aborted) return;
  const { width, height } = frame;
  const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  if (signal?.aborted) return;

  if (scale >= 1) {
    exportToCanvas(frame, canvas);
    return;
  }

  const temp = document.createElement("canvas");
  temp.width = width;
  temp.height = height;
  const tempCtx = temp.getContext("2d");
  if (!tempCtx) {
    exportToCanvas(frame, canvas);
    return;
  }
  tempCtx.putImageData(frameToImageData(frame), 0, 0);

  if (signal?.aborted) return;

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(temp, 0, 0, width, height, 0, 0, w, h);
}

export interface RunPipelineResult {
  /** When reference was used, the fitted grading params for the UI to store. */
  fittedGrading?: LookParams["grading"];
  /** Source image exposure and chroma stats (for correction context / bias). */
  sourceStats?: ImageStats;
  /** Reference image stats when reference file was used. */
  refStats?: ImageStats;
}

/**
 * Utility for debugging: export the baseline render (after decode + baseline
 * normalization, before any matching) as a PNG Blob. Useful for A/B against
 * Lightroom exports and for verifying matcher input consistency.
 */
export async function exportBaselinePngBlob(
  sourceFile: File
): Promise<Blob> {
  const frame = await decode(sourceFile);
  const imageData = frameToImageData(frame);
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not get 2D context for baseline export");
  }
  ctx.putImageData(imageData, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Failed to encode baseline PNG"));
          return;
        }
        resolve(blob);
      },
      "image/png",
      0.95
    );
  });
}

/**
 * Run the pipeline and draw the graded result to the canvas.
 * Uses source and reference Files; drives luma/color match + density from LookParams.match.
 * When reference exists: fits grading from it (algorithm does all the work) and returns fittedGrading for UI.
 * When no reference: uses params.grading (e.g. last fitted or defaults).
 * Optionally scales the result to fit within MAX_PREVIEW_EDGE for preview.
 */
export async function runPipeline(
  sourceFile: File,
  referenceFile: File | null,
  params: LookParams,
  canvas: HTMLCanvasElement
): Promise<RunPipelineResult> {
  const lumaStrength = params?.match?.lumaStrength ?? 1;
  const colorStrength = params?.match?.colorStrength ?? 1;
  const colorDensity = params?.match?.colorDensity ?? 1;
  const exposureStrength = params?.match?.exposureStrength ?? 1;
  const bandLowerShadow = params?.match?.bandLowerShadow ?? 1;
  const bandUpperShadow = params?.match?.bandUpperShadow ?? 1;
  const bandMid = params?.match?.bandMid ?? 1;
  const bandLowerHigh = params?.match?.bandLowerHigh ?? 1;
  const bandUpperHigh = params?.match?.bandUpperHigh ?? 1;
  const bandLowerShadowHue = params?.match?.bandLowerShadowHue ?? 0;
  const bandUpperShadowHue = params?.match?.bandUpperShadowHue ?? 0;
  const bandMidHue = params?.match?.bandMidHue ?? 0;
  const bandLowerHighHue = params?.match?.bandLowerHighHue ?? 0;
  const bandUpperHighHue = params?.match?.bandUpperHighHue ?? 0;
  const bandLowerShadowSat = params?.match?.bandLowerShadowSat ?? 1;
  const bandUpperShadowSat = params?.match?.bandUpperShadowSat ?? 1;
  const bandMidSat = params?.match?.bandMidSat ?? 1;
  const bandLowerHighSat = params?.match?.bandLowerHighSat ?? 1;
  const bandUpperHighSat = params?.match?.bandUpperHighSat ?? 1;
  const bandLowerShadowLuma = params?.match?.bandLowerShadowLuma ?? 0;
  const bandUpperShadowLuma = params?.match?.bandUpperShadowLuma ?? 0;
  const bandMidLuma = params?.match?.bandMidLuma ?? 0;
  const bandLowerHighLuma = params?.match?.bandLowerHighLuma ?? 0;
  const bandUpperHighLuma = params?.match?.bandUpperHighLuma ?? 0;

  const decodedSource = await decode(sourceFile);
  const sourceStats = computeImageStats(frameToImageData(decodedSource));
  const decodedRef = referenceFile ? await decode(referenceFile) : null;
  const refStats = decodedRef
    ? computeImageStats(frameToImageData(decodedRef))
    : undefined;

  let finalGrading: LookParamsGrading;
  let fittedGrading: LookParams["grading"] | undefined;

  if (decodedRef) {
    const refImageData = new ImageData(
      new Uint8ClampedArray(decodedRef.data),
      decodedRef.width,
      decodedRef.height
    );
    const engineParams = fitLookParamsFromReference(refImageData);
    fittedGrading = engineToGrading(engineParams);
    finalGrading = fittedGrading;
  } else {
    finalGrading = params?.grading ?? DEFAULT_LOOK_PARAMS.grading;
  }

  const engine = gradingToEngine(finalGrading);
  const engineWithMatch = engine as typeof engine & {
    colorDensity?: number;
    lumaStrength?: number;
    colorStrength?: number;
    exposureStrength?: number;
    refBlackL?: number;
    blackStrength?: number;
    blackRange?: number;
    colorBandStrengths?: {
      lowerShadow: number;
      upperShadow: number;
      mid: number;
      lowerHigh: number;
      upperHigh: number;
    };
    colorBandOverrides?: {
      hue: {
        lowerShadow: number;
        upperShadow: number;
        mid: number;
        lowerHigh: number;
        upperHigh: number;
      };
      sat: {
        lowerShadow: number;
        upperShadow: number;
        mid: number;
        lowerHigh: number;
        upperHigh: number;
      };
      luma: {
        lowerShadow: number;
        upperShadow: number;
        mid: number;
        lowerHigh: number;
        upperHigh: number;
      };
    };
    highlightFill?: { strength: number; warmth?: number };
  };
  engineWithMatch.colorDensity = colorDensity;
  engineWithMatch.lumaStrength = lumaStrength;
  engineWithMatch.colorStrength = colorStrength;
  engineWithMatch.exposureStrength = exposureStrength;
  // Black point: UI override takes precedence over fitted refBlackL.
  const blackPoint =
    params?.match?.blackPoint ?? finalGrading?.refBlackL ?? 0.05;
  engineWithMatch.refBlackL = blackPoint;
  // Black match controls (A: strength, B: range into midtones).
  if (typeof params?.match?.blackStrength === "number") {
    engineWithMatch.blackStrength = params.match.blackStrength;
  }
  if (typeof params?.match?.blackRange === "number") {
    engineWithMatch.blackRange = params.match.blackRange;
  }
  engineWithMatch.colorBandStrengths = {
    lowerShadow: bandLowerShadow,
    upperShadow: bandUpperShadow,
    mid: bandMid,
    lowerHigh: bandLowerHigh,
    upperHigh: bandUpperHigh,
  };
  engineWithMatch.colorBandOverrides = {
    hue: {
      lowerShadow: bandLowerShadowHue,
      upperShadow: bandUpperShadowHue,
      mid: bandMidHue,
      lowerHigh: bandLowerHighHue,
      upperHigh: bandUpperHighHue,
    },
    sat: {
      lowerShadow: bandLowerShadowSat,
      upperShadow: bandUpperShadowSat,
      mid: bandMidSat,
      lowerHigh: bandLowerHighSat,
      upperHigh: bandUpperHighSat,
    },
    luma: {
      lowerShadow: bandLowerShadowLuma,
      upperShadow: bandUpperShadowLuma,
      mid: bandMidLuma,
      lowerHigh: bandLowerHighLuma,
      upperHigh: bandUpperHighLuma,
    },
  };
  engineWithMatch.highlightFill = {
    strength: params?.match?.highlightFillStrength ?? 0,
    warmth: params?.match?.highlightFillWarmth ?? 0,
  };
  const result = await processOne(decodedSource, decodedRef, {
    strength: 1,
    grading: engine,
  });

  const ret: RunPipelineResult = {
    ...(fittedGrading && { fittedGrading }),
    sourceStats,
    ...(refStats && { refStats }),
  };

  const { width, height } = result;
  const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  if (scale >= 1) {
    exportToCanvas(result, canvas);
    return ret;
  }

  const temp = document.createElement("canvas");
  temp.width = width;
  temp.height = height;
  const tempCtx = temp.getContext("2d");
  if (!tempCtx) {
    exportToCanvas(result, canvas);
    return ret;
  }
  tempCtx.putImageData(frameToImageData(result), 0, 0);

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return ret;
  ctx.drawImage(temp, 0, 0, width, height, 0, 0, w, h);
  return ret;
}
