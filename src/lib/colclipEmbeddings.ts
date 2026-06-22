/**
 * Per-tile embeddings for fine-grained retrieval (Phase 2).
 * Uses DINOv2 per-tile until a ColCLIP model is available in Transformers.js.
 * Tiles are row-major 0..(gridRows*gridCols-1).
 */

import { yieldToMain } from "@/lib/yield-to-main";
import { imageToSemanticEmbedding } from "@/src/lib/semanticEmbeddings";
import {
  imageToChromaticEmbedding,
  imageToEmbedding,
} from "@/src/lib/embeddings";

const TILE_PROGRESS_MIN_MS = 200;

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

type TileCanvas = HTMLCanvasElement | OffscreenCanvas;

function createTileCanvas(width: number, height: number): TileCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToPngBlob(canvas: TileCanvas): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: "image/png", quality: 0.92 });
  }
  return new Promise((resolve, reject) => {
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

function get2dContext(
  canvas: TileCanvas
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  return canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
}

/**
 * Resize tile ImageData to 224x224 and return as PNG Blob for the embedding model.
 * Works in main thread (HTMLCanvasElement) and workers (OffscreenCanvas).
 */
function tileToBlob224(tile: ImageData): Promise<Blob> {
  const canvas = createTileCanvas(TILE_MODEL_INPUT_SIZE, TILE_MODEL_INPUT_SIZE);
  const ctx = get2dContext(canvas);
  if (!ctx) {
    return Promise.reject(new Error("Could not get 2D context"));
  }
  const temp = createTileCanvas(tile.width, tile.height);
  const tctx = get2dContext(temp);
  if (!tctx) {
    return Promise.reject(new Error("Could not get temp 2D context"));
  }
  tctx.putImageData(tile, 0, 0);
  ctx.drawImage(
    temp as CanvasImageSource,
    0,
    0,
    tile.width,
    tile.height,
    0,
    0,
    TILE_MODEL_INPUT_SIZE,
    TILE_MODEL_INPUT_SIZE
  );
  return canvasToPngBlob(canvas);
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
  let lastProgressAt = 0;
  for (let ti = 0; ti < numTiles; ti++) {
    const tile = getTile(imageData, ti, gridCols, gridRows);
    const blob = await tileToBlob224(tile);
    const vec = await imageToSemanticEmbedding(blob);
    results.push(vec);
    if (onProgress) {
      const now = performance.now();
      if (
        ti === numTiles - 1 ||
        now - lastProgressAt >= TILE_PROGRESS_MIN_MS
      ) {
        lastProgressAt = now;
        onProgress(ti + 1, numTiles);
      }
    }
    if (ti + 1 < numTiles) {
      await yieldToMain();
    }
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

/**
 * Per-tile OKLab chroma histogram (16-dim): 8×a + 8×b only, same semantics as `imageToChromaticEmbedding`.
 */
export function imageToChromaticTileEmbeddings(
  imageData: ImageData,
  gridCols: number = 10,
  gridRows: number = 10
): number[][] {
  const numTiles = gridCols * gridRows;
  const results: number[][] = [];
  for (let ti = 0; ti < numTiles; ti++) {
    const tile = getTile(imageData, ti, gridCols, gridRows);
    results.push(imageToChromaticEmbedding(tile));
  }
  return results;
}

/**
 * Async variant that yields between tiles so the UI can stay responsive.
 */
export async function imageToChromaticTileEmbeddingsAsync(
  imageData: ImageData,
  gridCols: number = 10,
  gridRows: number = 10,
  onProgress?: (current: number, total: number) => void
): Promise<number[][]> {
  const numTiles = gridCols * gridRows;
  const results: number[][] = [];
  let lastProgressAt = 0;
  for (let ti = 0; ti < numTiles; ti++) {
    const tile = getTile(imageData, ti, gridCols, gridRows);
    results.push(imageToChromaticEmbedding(tile));
    if (onProgress) {
      const now = performance.now();
      if (
        ti === numTiles - 1 ||
        now - lastProgressAt >= TILE_PROGRESS_MIN_MS
      ) {
        lastProgressAt = now;
        onProgress(ti + 1, numTiles);
      }
    }
    if (ti + 1 < numTiles) {
      await yieldToMain();
    }
  }
  return results;
}
