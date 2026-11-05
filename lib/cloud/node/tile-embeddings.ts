/**
 * Node port of the lab2 tile embedding worker: 10×10 DINOv2 tile embeddings
 * plus per-tile chroma histograms, computed exactly like
 * `imageToColClipTileEmbeddings` / `imageToChromaticTileEmbeddings` in the
 * browser (same tiling, same 224px canvas resize, same q8 model).
 * Analysis only: the result feeds dataset search, never the pixels.
 */

import {
  getTile,
  imageToChromaticTileEmbeddings,
  TILE_MODEL_INPUT_SIZE,
} from "@/src/lib/colclipEmbeddings";
import { SEMANTIC_EMBEDDING_DIM } from "@/src/lib/semanticEmbeddings";
import { pixelFrameF32ToPixelFrameRGBA, type PixelFrameF32 } from "@/src/lib/pipeline/types";
import { createCanvas, installNodeCanvasGlobals } from "./canvas";

const GRID = 10;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelinePromise: Promise<any> | null = null;

async function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      if (process.env.TRANSFORMERS_CACHE_DIR) env.cacheDir = process.env.TRANSFORMERS_CACHE_DIR;
      // Browsers run this model on WASM, whose default dtype is q8; match it.
      return pipeline("image-feature-extraction", "Xenova/dinov2-small", { dtype: "q8" });
    })();
  }
  return pipelinePromise;
}

function poolAndNormalize(arr: ArrayLike<number>): number[] {
  if (arr.length < SEMANTIC_EMBEDDING_DIM) {
    throw new Error(`Unexpected embedding length: ${arr.length}`);
  }
  let vec: number[];
  if (arr.length === SEMANTIC_EMBEDDING_DIM) {
    vec = Array.from(arr, Number);
  } else {
    const dim = SEMANTIC_EMBEDDING_DIM;
    const seqLen = Math.floor(arr.length / dim);
    vec = new Array(dim).fill(0);
    for (let i = 0; i < arr.length; i++) vec[i % dim] += Number(arr[i]);
    for (let i = 0; i < dim; i++) vec[i] /= seqLen;
  }
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  const mag = Math.sqrt(sumSq) || 1;
  return vec.map((v) => v / mag);
}

export async function computeTileEmbeddingsNode(
  frame: PixelFrameF32
): Promise<{ semantic: number[][]; chromatic: number[][] }> {
  installNodeCanvasGlobals();
  const rgba = pixelFrameF32ToPixelFrameRGBA(frame);
  return computeTileEmbeddingsFromImageData(
    new ImageData(rgba.data as Uint8ClampedArray<ArrayBuffer>, rgba.width, rgba.height)
  );
}

export async function computeTileEmbeddingsFromImageData(
  imageData: ImageData
): Promise<{ semantic: number[][]; chromatic: number[][] }> {
  installNodeCanvasGlobals();
  const { RawImage } = await import("@huggingface/transformers");
  const pipe = await getPipeline();

  const out224 = createCanvas(TILE_MODEL_INPUT_SIZE, TILE_MODEL_INPUT_SIZE);
  const ctx = out224.getContext("2d");
  const semantic: number[][] = [];
  for (let ti = 0; ti < GRID * GRID; ti++) {
    const tile = getTile(imageData, ti, GRID, GRID);
    const temp = createCanvas(tile.width, tile.height);
    temp.getContext("2d").putImageData(tile as never, 0, 0);
    ctx.clearRect(0, 0, TILE_MODEL_INPUT_SIZE, TILE_MODEL_INPUT_SIZE);
    ctx.drawImage(
      temp,
      0,
      0,
      tile.width,
      tile.height,
      0,
      0,
      TILE_MODEL_INPUT_SIZE,
      TILE_MODEL_INPUT_SIZE
    );
    const px = ctx.getImageData(0, 0, TILE_MODEL_INPUT_SIZE, TILE_MODEL_INPUT_SIZE);
    const image = new RawImage(
      new Uint8ClampedArray(px.data),
      TILE_MODEL_INPUT_SIZE,
      TILE_MODEL_INPUT_SIZE,
      4
    );
    const output = await pipe(image);
    semantic.push(poolAndNormalize(output.data as ArrayLike<number>));
  }
  const chromatic = imageToChromaticTileEmbeddings(imageData, GRID, GRID);
  return { semantic, chromatic };
}
