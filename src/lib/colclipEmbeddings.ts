/**
 * Per-tile embeddings for fine-grained retrieval (Phase 2).
 * Uses DINOv2 per-tile until a ColCLIP model is available in Transformers.js.
 * Tiles are row-major 0..(gridRows*gridCols-1).
 */

import { imageToSemanticEmbedding } from "@/src/lib/semanticEmbeddings";
import { imageToEmbedding } from "@/src/lib/embeddings";

export const COLCLIP_TILE_DIM = 384; // Same as DINOv2 for now
const TILE_MODEL_INPUT_SIZE = 224;

/**
 * Extract a single tile from ImageData as a new ImageData (native tile size).
 */
function getTile(
  img: ImageData,
  tileIndex: number,
  gridCols: number,
  gridRows: number
): ImageData {
  const { width, height, data } = img;
  const tileW = Math.floor(width / gridCols);
  const tileH = Math.floor(height / gridRows);
  const col = tileIndex % gridCols;
  const row = Math.floor(tileIndex / gridCols);
  const x0 = col * tileW;
  const y0 = row * tileH;
  const out = new ImageData(tileW, tileH);
  for (let y = 0; y < tileH; y++) {
    for (let x = 0; x < tileW; x++) {
      const srcIdx = ((y0 + y) * width + (x0 + x)) * 4;
      const dstIdx = (y * tileW + x) * 4;
      out.data[dstIdx] = data[srcIdx];
      out.data[dstIdx + 1] = data[srcIdx + 1];
      out.data[dstIdx + 2] = data[srcIdx + 2];
      out.data[dstIdx + 3] = data[srcIdx + 3];
    }
  }
  return out;
}

/**
 * Resize tile ImageData to 224x224 and return as PNG Blob for the embedding model.
 */
function tileToBlob224(tile: ImageData): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = TILE_MODEL_INPUT_SIZE;
    canvas.height = TILE_MODEL_INPUT_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("Could not get 2D context"));
      return;
    }
    const temp = document.createElement("canvas");
    temp.width = tile.width;
    temp.height = tile.height;
    const tctx = temp.getContext("2d");
    if (!tctx) {
      reject(new Error("Could not get temp 2D context"));
      return;
    }
    tctx.putImageData(tile, 0, 0);
    ctx.drawImage(temp, 0, 0, tile.width, tile.height, 0, 0, TILE_MODEL_INPUT_SIZE, TILE_MODEL_INPUT_SIZE);
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("toBlob failed"));
      },
      "image/png",
      0.92
    );
  });
}

/**
 * Compute ColCLIP-style tile embeddings (currently DINOv2 per tile).
 * Returns one 384-dim vector per tile, row-major.
 * Optional onProgress(current, total) is called after each tile (1-based current).
 */
export async function imageToColClipTileEmbeddings(
  imageData: ImageData,
  gridCols: number = 10,
  gridRows: number = 10,
  onProgress?: (current: number, total: number) => void
): Promise<number[][]> {
  const numTiles = gridCols * gridRows;
  const results: number[][] = [];
  for (let ti = 0; ti < numTiles; ti++) {
    const tile = getTile(imageData, ti, gridCols, gridRows);
    const blob = await tileToBlob224(tile);
    const vec = await imageToSemanticEmbedding(blob);
    results.push(vec);
    onProgress?.(ti + 1, numTiles);
  }
  return results;
}

/**
 * Compute optional 32-dim tonal embedding per tile (same as global tonal but per tile).
 */
export function imageToTonalTileEmbeddings(
  imageData: ImageData,
  gridCols: number = 10,
  gridRows: number = 10
): number[][] {
  const numTiles = gridCols * gridRows;
  const results: number[][] = [];
  for (let ti = 0; ti < numTiles; ti++) {
    const tile = getTile(imageData, ti, gridCols, gridRows);
    results.push(imageToEmbedding(tile));
  }
  return results;
}
