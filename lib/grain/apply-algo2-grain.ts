import {
  scalePngBlobToDimensions,
  scalePngBlobToLongEdge,
} from "@/lib/lab2/build-export-png-blob";
import { processTileAlgo2 } from "./algo2-tile";
import { calculateCircleSizes } from "./calculate-circle-sizes";
import { PREVIEW_GRAIN_WORKING_LONG_EDGE } from "./constants";
import { applyExposureBlend } from "./exposure-blend";
import { applyFineGrainEffect } from "./fine-grain";
import type { GrainExportParams, GrainProgress } from "./types";

const TILE_SIZE = 150;
const MACRO_TILE_SIZE = TILE_SIZE * 3;

/**
 * Apply algo2 film grain to full-resolution 8-bit image data.
 * Runs after the graded export PNG is encoded (post-pipeline, pre-download).
 */
export async function applyAlgo2GrainToImageData(
  sourceImageData: ImageData,
  params: GrainExportParams,
  onProgress?: (progress: GrainProgress) => void
): Promise<ImageData> {
  const { width, height } = sourceImageData;
  const circleSizes = calculateCircleSizes(width, height);

  const resultCanvas = document.createElement("canvas");
  resultCanvas.width = width;
  resultCanvas.height = height;
  const resultCtx = resultCanvas.getContext("2d");
  if (!resultCtx) {
    throw new Error("No 2D context for grain processing");
  }

  resultCtx.fillStyle = "rgb(2, 2, 2)";
  resultCtx.fillRect(0, 0, width, height);

  const totalMacroTilesX = Math.ceil(width / MACRO_TILE_SIZE);
  const totalMacroTilesY = Math.ceil(height / MACRO_TILE_SIZE);
  const totalMacroTiles = totalMacroTilesX * totalMacroTilesY;
  let macroTilesProcessed = 0;

  onProgress?.({ stage: "Applying grain", percentage: 5 });

  for (let macroY = 0; macroY < height; macroY += MACRO_TILE_SIZE) {
    for (let macroX = 0; macroX < width; macroX += MACRO_TILE_SIZE) {
      const actualMacroWidth = Math.min(MACRO_TILE_SIZE, width - macroX);
      const actualMacroHeight = Math.min(MACRO_TILE_SIZE, height - macroY);

      if (actualMacroWidth <= 0 || actualMacroHeight <= 0) continue;

      for (let tileY = 0; tileY < actualMacroHeight; tileY += TILE_SIZE) {
        for (let tileX = 0; tileX < actualMacroWidth; tileX += TILE_SIZE) {
          const actualTileWidth = Math.min(TILE_SIZE, actualMacroWidth - tileX);
          const actualTileHeight = Math.min(TILE_SIZE, actualMacroHeight - tileY);

          if (actualTileWidth <= 0 || actualTileHeight <= 0) continue;

          processTileAlgo2(
            resultCtx,
            macroX + tileX,
            macroY + tileY,
            actualTileWidth,
            actualTileHeight,
            circleSizes,
            sourceImageData
          );
        }
      }

      macroTilesProcessed++;
      if (macroTilesProcessed % 2 === 0) {
        onProgress?.({
          stage: "Applying grain",
          percentage: 5 + Math.round((macroTilesProcessed / totalMacroTiles) * 65),
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  onProgress?.({ stage: "Blending exposure", percentage: 75 });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  let output = applyExposureBlend(
    sourceImageData,
    resultCtx,
    params.pointillistOpacityMagnitude
  );

  if (params.fineGrainEnabled) {
    onProgress?.({ stage: "Applying fine grain", percentage: 88 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const fineCanvas = document.createElement("canvas");
    fineCanvas.width = width;
    fineCanvas.height = height;
    const fineCtx = fineCanvas.getContext("2d");
    if (!fineCtx) {
      throw new Error("No 2D context for fine grain");
    }
    fineCtx.putImageData(output, 0, 0);
    applyFineGrainEffect(
      fineCtx,
      width,
      height,
      params.fineGrainStrength,
      params.fineGrainExtraChroma
    );
    output = fineCtx.getImageData(0, 0, width, height);
  }

  onProgress?.({ stage: "Grain complete", percentage: 100 });
  return output;
}

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
