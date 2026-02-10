/**
 * Deterministic image embedding for similarity search.
 * OKLab histogram (16L + 8a + 8b = 32 dims), unit-normalized for cosine distance.
 * No ML, pure math. Used to find reference images similar to a source.
 */

import { srgb8ToOklab } from "@/src/lib/pipeline/stages/oklab";

export const EMBEDDING_DIM = 32;
const L_BINS = 16;
const A_BINS = 8;
const B_BINS = 8;

/** OKLab a,b range approx -0.4..0.4; map to 0..1 for binning */
function toBin01(value: number, min: number, max: number): number {
  const t = (value - min) / (max - min);
  return Math.max(0, Math.min(1, t));
}

/**
 * Compute a 32-dim embedding from an image's OKLab distribution.
 * Embeddings with similar tonal/color histograms will be close in cosine distance.
 */
export function imageToEmbedding(img: ImageData): number[] {
  const d = img.data;
  const histL = new Array<number>(L_BINS).fill(0);
  const histA = new Array<number>(A_BINS).fill(0);
  const histB = new Array<number>(B_BINS).fill(0);
  let count = 0;

  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const { L, a, b } = srgb8ToOklab(d[i], d[i + 1], d[i + 2]);
    const biL = Math.min(L_BINS - 1, Math.floor(L * L_BINS));
    const biA = Math.min(A_BINS - 1, Math.floor(toBin01(a, -0.4, 0.4) * A_BINS));
    const biB = Math.min(B_BINS - 1, Math.floor(toBin01(b, -0.4, 0.4) * B_BINS));
    histL[biL]++;
    histA[biA]++;
    histB[biB]++;
    count++;
  }

  if (count === 0) {
    return new Array(EMBEDDING_DIM).fill(0);
  }

  const norm = (arr: number[]) => {
    const scale = 1 / count;
    return arr.map((v) => v * scale);
  };
  const vec = [...norm(histL), ...norm(histA), ...norm(histB)];

  // Unit-normalize for cosine similarity
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  const mag = Math.sqrt(sumSq) || 1;
  return vec.map((v) => v / mag);
}
