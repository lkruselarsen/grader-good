/**
 * Image stats for correction context: exposure level and chroma distribution.
 * OKLab-based, same space as the matcher. Used at correction upload and at apply.
 */

import { srgb8ToOklab } from "./stages/oklab";

/** Same 5 L bands as match.ts for comparable chroma distribution. */
const COLOR_BAND_ANCHORS = [0.08, 0.25, 0.5, 0.7, 0.9];
const BAND_COUNT = COLOR_BAND_ANCHORS.length;

function chroma(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}

/** Triangular weight for L in band k (sum to 1 over bands). */
function bandWeight(L: number, k: number): number {
  const center = COLOR_BAND_ANCHORS[k];
  const halfWidth = k === 0
    ? (COLOR_BAND_ANCHORS[1] - center) * 0.6
    : k === BAND_COUNT - 1
      ? (center - COLOR_BAND_ANCHORS[k - 1]) * 0.6
      : Math.min(
          (COLOR_BAND_ANCHORS[k + 1] - center) * 0.5,
          (center - COLOR_BAND_ANCHORS[k - 1]) * 0.5
        );
  const dist = Math.abs(L - center);
  return Math.max(0, 1 - dist / halfWidth);
}

export interface ExposureLevel {
  medianL: number;
  p05L: number;
  p95L: number;
}

export interface ChromaBand {
  meanA: number;
  meanB: number;
  meanC: number;
  weight: number;
}

export interface ChromaDistribution {
  meanA: number;
  meanB: number;
  meanC: number;
  bands: ChromaBand[];
}

export interface ImageStats {
  exposureLevel: ExposureLevel;
  chromaDistribution: ChromaDistribution;
}

const NEUTRAL_EXPOSURE: ExposureLevel = {
  medianL: 0.5,
  p05L: 0.05,
  p95L: 0.95,
};

const NEUTRAL_CHROMA: ChromaDistribution = {
  meanA: 0,
  meanB: 0,
  meanC: 0,
  bands: COLOR_BAND_ANCHORS.map(() => ({
    meanA: 0,
    meanB: 0,
    meanC: 0,
    weight: 0,
  })),
};

/**
 * Compute exposure and chroma stats from RGBA pixel data (ImageData or PixelFrameRGBA layout).
 * Skips transparent pixels (alpha < 128). Returns neutral defaults if no opaque pixels.
 */
export function computeImageStats(image: ImageData): ImageStats {
  const d = image.data;
  const nPix = d.length >> 2;
  // Typed arrays avoid V8 OOM from per-pixel push to plain number[].
  const Ls = new Float32Array(nPix);
  const oas = new Float32Array(nPix);
  const obs = new Float32Array(nPix);
  const Cs = new Float32Array(nPix);
  let n = 0;

  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < 128) continue;
    const { L, a, b } = srgb8ToOklab(d[i]!, d[i + 1]!, d[i + 2]!);
    const c = chroma(a, b);
    Ls[n] = L;
    oas[n] = a;
    obs[n] = b;
    Cs[n] = c;
    n++;
  }

  if (n === 0) {
    return {
      exposureLevel: NEUTRAL_EXPOSURE,
      chromaDistribution: NEUTRAL_CHROMA,
    };
  }

  const LsortedBuf = new Float32Array(Ls.subarray(0, n));
  LsortedBuf.sort();
  const exposureLevel: ExposureLevel = {
    medianL: LsortedBuf[Math.floor(n * 0.5)] ?? 0.5,
    p05L: LsortedBuf[Math.floor(n * 0.05)] ?? 0.05,
    p95L: LsortedBuf[Math.floor(n * 0.95)] ?? 0.95,
  };

  let sumA = 0, sumB = 0, sumC = 0;
  for (let i = 0; i < n; i++) { sumA += oas[i]!; sumB += obs[i]!; sumC += Cs[i]!; }
  const bands: ChromaBand[] = COLOR_BAND_ANCHORS.map(() => ({
    meanA: 0,
    meanB: 0,
    meanC: 0,
    weight: 0,
  }));

  for (let i = 0; i < n; i++) {
    const L = Ls[i]!;
    const a = oas[i]!;
    const b = obs[i]!;
    const c = Cs[i]!;
    let totalW = 0;
    for (let k = 0; k < BAND_COUNT; k++) totalW += bandWeight(L, k);
    if (totalW < 1e-9) totalW = 1;
    for (let k = 0; k < BAND_COUNT; k++) {
      const wk = bandWeight(L, k) / totalW;
      bands[k].meanA += a * wk;
      bands[k].meanB += b * wk;
      bands[k].meanC += c * wk;
      bands[k].weight += wk;
    }
  }

  for (let k = 0; k < BAND_COUNT; k++) {
    const w = bands[k].weight;
    if (w > 1e-9) {
      bands[k].meanA /= w;
      bands[k].meanB /= w;
      bands[k].meanC /= w;
    }
  }

  const chromaDistribution: ChromaDistribution = {
    meanA: sumA / n,
    meanB: sumB / n,
    meanC: sumC / n,
    bands,
  };

  return {
    exposureLevel,
    chromaDistribution,
  };
}
