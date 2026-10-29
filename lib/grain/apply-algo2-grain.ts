import {
  scalePngBlobToDimensions,
  scalePngBlobToLongEdge,
} from "@/lib/lab2/build-export-png-blob";
import { applyAlgo2GrainToImageData } from "./algo2-core";
import { PREVIEW_GRAIN_WORKING_LONG_EDGE } from "./constants";
import type { GrainExportParams, GrainProgress } from "./types";

export { applyAlgo2GrainToImageData };

/**
 * Apply algo2 grain to a low-res preview PNG by temporarily upscaling so algo2
 * sees a full-size canvas, then downscaling back to the preview dimensions.
 */
export async function applyGrainToPreviewPngBlob(
  previewBlob: Blob,
  params: GrainExportParams,
  onProgress?: (progress: GrainProgress) => void
): Promise<Blob> {
  const bitmap = await createImageBitmap(previewBlob);
  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;
  bitmap.close();

  const originalLongEdge = Math.max(originalWidth, originalHeight);
  const needsUpscale = originalLongEdge < PREVIEW_GRAIN_WORKING_LONG_EDGE;

  let workingBlob = previewBlob;
  if (needsUpscale) {
    onProgress?.({ stage: "Upscaling for grain", percentage: 5 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    workingBlob = await scalePngBlobToLongEdge(
      previewBlob,
      PREVIEW_GRAIN_WORKING_LONG_EDGE
    );
  }

  const grainStart = needsUpscale ? 10 : 5;
  const grainSpan = needsUpscale ? 70 : 90;
  let grainBlob = await applyGrainToPngBlob(workingBlob, params, (progress) => {
    onProgress?.({
      stage: progress.stage,
      percentage:
        grainStart + Math.round(progress.percentage * (grainSpan / 100)),
    });
  });

  if (needsUpscale) {
    onProgress?.({ stage: "Downscaling to preview size", percentage: 88 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    grainBlob = await scalePngBlobToDimensions(
      grainBlob,
      originalWidth,
      originalHeight
    );
  }

  onProgress?.({ stage: "Grain complete", percentage: 100 });
  return grainBlob;
}

/** Apply algo2 grain to a graded PNG blob (full resolution). */
export async function applyGrainToPngBlob(
  blob: Blob,
  params: GrainExportParams,
  onProgress?: (progress: GrainProgress) => void
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("No 2D context");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const source = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const result = await applyAlgo2GrainToImageData(source, params, onProgress);
  ctx.putImageData(result, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed after grain"))),
      "image/png"
    );
  });
}
