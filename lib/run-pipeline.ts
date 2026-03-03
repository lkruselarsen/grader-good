/**
 * Pipeline contract for the Lab UI: source + reference + params → draw to canvas.
 * Runs the real pipeline (decode → match → halation → grain) and exports to canvas.
 */

import type { LookParams, LookParamsGrading } from "./look-params";
import { engineToGrading, DEFAULT_LOOK_PARAMS } from "./look-params";
import { buildEngineParamsFromLookParams } from "./build-engine-params";
import {
  processOne,
  exportToCanvas,
  frameToImageData,
  buildExposureMapFromSrgb,
  buildExposureMapFromLinearRgb,
  computeImageStats,
  type ImageStats,
} from "@/src/lib/pipeline";
import { decode, decodeDngLinear } from "@/src/lib/pipeline/decode";
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
 * Run the full pipeline at the source's native resolution (no MAX_PREVIEW_EDGE cap)
 * and return the graded result as a PNG Blob. Use for the Export button.
 */
export async function exportGradedPngBlob(
  sourceFile: File,
  referenceFile: File | null,
  params: LookParams,
  options?: RunPipelineOptions
): Promise<Blob> {
  const onProgress = options?.onProgress;

  onProgress?.("Decoding…");
  const decodedSource = await decode(sourceFile);
  const decodedRef = referenceFile ? await decode(referenceFile) : null;

  const linearSource = await decodeDngLinear(sourceFile);
  const exposureMap =
    linearSource != null
      ? buildExposureMapFromLinearRgb(
          linearSource.width,
          linearSource.height,
          new Uint8Array(linearSource.data),
          4
        )
      : buildExposureMapFromSrgb(decodedSource);

  let finalGrading: LookParamsGrading;
  if (decodedRef) {
    const refImageData = new ImageData(
      new Uint8ClampedArray(decodedRef.data),
      decodedRef.width,
      decodedRef.height
    );
    finalGrading = engineToGrading(fitLookParamsFromReference(refImageData));
  } else {
    finalGrading = params?.grading ?? DEFAULT_LOOK_PARAMS.grading;
  }

  onProgress?.("Applying grade…");
  const engineWithMatch = buildEngineParamsFromLookParams(params, finalGrading);
  const result = await processOne(decodedSource, decodedRef, {
    strength: 1,
    grading: engineWithMatch,
    exposureMap,
  });

  onProgress?.("Encoding PNG…");
  const canvas = document.createElement("canvas");
  canvas.width = result.width;
  canvas.height = result.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context for export");
  ctx.putImageData(frameToImageData(result), 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Failed to encode graded PNG"));
          return;
        }
        resolve(blob);
      },
      "image/png"
    );
  });
}

export interface RunPipelineOptions {
  /** Called at each phase so the UI can show progress (e.g. "Decoding…", "Applying grade…"). */
  onProgress?: (phase: string) => void;
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
  canvas: HTMLCanvasElement,
  options?: RunPipelineOptions
): Promise<RunPipelineResult> {
  const onProgress = options?.onProgress;

  onProgress?.("Decoding…");
  const decodedSource = await decode(sourceFile);
  const sourceStats = computeImageStats(frameToImageData(decodedSource));
  const decodedRef = referenceFile ? await decode(referenceFile) : null;
  const refStats = decodedRef
    ? computeImageStats(frameToImageData(decodedRef))
    : undefined;

  const linearSource = await decodeDngLinear(sourceFile);
  const exposureMap =
    linearSource != null
      ? buildExposureMapFromLinearRgb(
          linearSource.width,
          linearSource.height,
          new Uint8Array(linearSource.data),
          4
        )
      : buildExposureMapFromSrgb(decodedSource);

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

  onProgress?.("Applying grade…");
  const engineWithMatch = buildEngineParamsFromLookParams(params, finalGrading);
  const result = await processOne(decodedSource, decodedRef, {
    strength: 1,
    grading: engineWithMatch,
    exposureMap,
  });

  const ret: RunPipelineResult = {
    ...(fittedGrading && { fittedGrading }),
    sourceStats,
    ...(refStats && { refStats }),
  };

  onProgress?.("Drawing…");
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
