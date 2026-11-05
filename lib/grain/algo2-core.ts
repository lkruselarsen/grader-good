import { processTileAlgo2 } from "./algo2-tile";
import { calculateCircleSizes } from "./calculate-circle-sizes";
import { applyExposureBlend } from "./exposure-blend";
import { applyFineGrainEffect } from "./fine-grain";
import type { GrainCanvasFactory, GrainExportParams, GrainProgress } from "./types";

const TILE_SIZE = 150;
const MACRO_TILE_SIZE = TILE_SIZE * 3;

const createDomCanvas: GrainCanvasFactory = (width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/**
 * Apply algo2 film grain to full-resolution 8-bit image data.
 * Runs after the graded export PNG is encoded (post-pipeline, pre-download).
 */
export async function applyAlgo2GrainToImageData(
  sourceImageData: ImageData,
  params: GrainExportParams,
  onProgress?: (progress: GrainProgress) => void,
  createCanvas: GrainCanvasFactory = createDomCanvas
): Promise<ImageData> {
  const { width, height } = sourceImageData;
  const circleSizes = calculateCircleSizes(width, height);

  const resultCtx = createCanvas(width, height).getContext("2d");
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

    const fineCtx = createCanvas(width, height).getContext("2d");
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
