/**
 * Parametric color grading: fit LookParams from reference, apply to source.
 * Pure math, deterministic, OKLab-based. No LUT, ML, or external libs.
 */

import { oklabToSrgb8, srgb8ToOklab } from "./oklab";

/** Multi-segment tone curve: L_in -> L_out at anchors. Used when present instead of LGG. */
export interface ToneCurveParams {
  L_in: number[];
  L_out: number[];
}

/** Multi-segment tint: a/b per luminance band. Used when present instead of global/shadow/highlight tint. */
export interface TintByLParams {
  L_anchors: number[];
  a: number[];
  b: number[];
}

/** Per-band saturation/density from reference: chroma scale by L (1 = neutral, <1 = desaturated in that band). */
export interface SaturationByLParams {
  L_anchors: number[];
  scale: number[];
}

/** JSON-serializable grading parameters. Stable for embeddings. */
export interface LookParams {
  tone: {
    lift: number;
    gamma: number;
    gain: number;
  };
  /** Multi-segment tone curve. When present, used instead of tone + shadowContrast. */
  toneCurve?: ToneCurveParams;
  saturation: {
    shadowRolloff: number;
    highlightRolloff: number;
    shadowColorDensity: number;
    highlightColorDensity: number;
  };
  warmth: number;
  /** Global green–magenta shift (a-axis in OKLab). Fitted from reference mean a. */
  tint: number;
  shadowTint: { a: number; b: number };
  highlightTint: { a: number; b: number };
  shadowContrast: number;
  /** Multi-segment tint per L band. When present, used instead of warmth/tint/shadowTint/highlightTint. */
  tintByL?: TintByLParams;
  /** Per-band saturation/density from reference. When present, chroma is scaled by this per L. */
  saturationByL?: SaturationByLParams;
  /** Overall reference saturation: 1 = neutral, <1 = reference is desaturated (desaturate source), >1 = reference is saturated. */
  refSaturation?: number;
  /** Global chroma multiplier (1 = neutral, >1 = richer, <1 = paler). Applied after other saturation. */
  colorDensity?: number;
  /** Reference midtone micro-contrast (RMS of detail band on L in mids). Used to match local contrast on source. */
  microContrastMid?: number;
  /** UI-driven luma match strength (0..2, 1 = match reference; <1 lean to source; >1 overshoot). */
  lumaStrength?: number;
  /** UI-driven color match strength (0..2, 1 = match reference; <1 lean to source; >1 overshoot). */
  colorStrength?: number;
  /** Reference mid-L (median L) used for exposure matching (0..1, ~0.5 default). */
  refMidL?: number;
  /** UI-driven exposure match strength (0..2, 1 = match reference; <1 lean to source; >1 overshoot). */
  exposureStrength?: number;
}

/** Identity / neutral params (no change). */
export function defaultLookParams(): LookParams {
  return {
    tone: { lift: 0, gamma: 1, gain: 1 },
    saturation: {
      shadowRolloff: 0,
      highlightRolloff: 0,
      shadowColorDensity: 1,
      highlightColorDensity: 1,
    },
    warmth: 0,
    tint: 0,
    shadowTint: { a: 0, b: 0 },
    highlightTint: { a: 0, b: 0 },
    shadowContrast: 1,
    colorDensity: 1,
    microContrastMid: 0,
    lumaStrength: 1,
    colorStrength: 1,
    refMidL: 0.5,
    exposureStrength: 1,
  };
}

/** Chroma in OKLab: C = sqrt(a^2 + b^2). */
function chroma(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}

/** Piecewise linear interpolation: map L to curve(L) using L_in/L_out anchors. */
function piecewiseLinear(L: number, L_in: number[], L_out: number[]): number {
  const n = L_in.length;
  if (n === 0) return L;
  if (L <= L_in[0]) return L_out[0];
  if (L >= L_in[n - 1]) return L_out[n - 1];
  for (let i = 0; i < n - 1; i++) {
    if (L >= L_in[i] && L <= L_in[i + 1]) {
      const t = (L - L_in[i]) / (L_in[i + 1] - L_in[i]);
      return L_out[i] + t * (L_out[i + 1] - L_out[i]);
    }
  }
  return L_out[n - 1];
}

/**
 * Interpolate a/b tint from tintByL at given L.
 * Uses band-centered weight falloff (sharper transitions) instead of linear blend.
 */
function interpolateTintByL(
  L: number,
  tintByL: TintByLParams
): { a: number; b: number } {
  const { L_anchors, a, b } = tintByL;
  const n = L_anchors.length;
  if (n === 0) return { a: 0, b: 0 };
  const bandHalfWidth = 0.65 / n;
  let sumA = 0;
  let sumB = 0;
  let sumW = 0;
  for (let i = 0; i < n; i++) {
    const center = L_anchors[i];
    const dist = Math.abs(L - center);
    const w = Math.max(0, 1 - dist / bandHalfWidth);
    if (w > 0) {
      sumA += w * a[i];
      sumB += w * b[i];
      sumW += w;
    }
  }
  if (sumW < 1e-9) {
    const i = L <= L_anchors[0] ? 0 : n - 1;
    return { a: a[i], b: b[i] };
  }
  return { a: sumA / sumW, b: sumB / sumW };
}

/** Interpolate saturation scale from saturationByL at given L. */
function interpolateSaturationByL(L: number, sat: SaturationByLParams): number {
  const { L_anchors, scale } = sat;
  const n = L_anchors.length;
  if (n === 0) return 1;
  if (L <= L_anchors[0]) return scale[0];
  if (L >= L_anchors[n - 1]) return scale[n - 1];
  for (let i = 0; i < n - 1; i++) {
    if (L >= L_anchors[i] && L <= L_anchors[i + 1]) {
      const t = (L - L_anchors[i]) / (L_anchors[i + 1] - L_anchors[i]);
      return scale[i] + t * (scale[i + 1] - scale[i]);
    }
  }
  return scale[n - 1];
}

/** Saturation rolloff scale as function of L. */
function satScale(L: number, shadowRolloff: number, highlightRolloff: number): number {
  return Math.max(
    0,
    1 - shadowRolloff * (1 - L) ** 2 - highlightRolloff * L ** 2
  );
}

/** Color density scale: boost in shadows, reduce in highlights. */
function colorDensityScale(
  L: number,
  shadowColorDensity: number,
  highlightColorDensity: number
): number {
  const shadowW = (1 - L) ** 2;
  const highlightW = L ** 2;
  return (
    1 +
    (shadowColorDensity - 1) * shadowW +
    (highlightColorDensity - 1) * highlightW
  );
}

/** Apply shadow contrast (power on toe) before main LGG. */
function applyShadowContrast(L: number, shadowContrast: number): number {
  if (shadowContrast === 1 || L >= 0.4) return L;
  const t = L / 0.4;
  return Math.pow(t, shadowContrast) * 0.4;
}

/** Apply lift-gamma-gain to L (0..1). */
function applyLGG(
  L: number,
  lift: number,
  gamma: number,
  gain: number
): number {
  let v = L * gain + lift;
  v = Math.max(0.001, Math.min(1, v));
  return Math.pow(v, gamma);
}

/**
 * Derive grading parameters from a reference image.
 * Simple V1: histograms, percentiles, mean chroma by L.
 */
export function fitLookParamsFromReference(ref: ImageData): LookParams {
  const { data: d, width, height } = ref;
  const Ls: number[] = [];
  const Cs: number[] = [];
  const oas: number[] = [];
  const bs: number[] = [];
  // Full-resolution L grid + mask so we can measure reference micro-contrast in midtones.
  const nPix = width * height;
  const Lgrid = new Float32Array(nPix);
  const mask = new Uint8Array(nPix);

  for (let i = 0; i < d.length; i += 4) {
    const pix = i >> 2;
    const alpha = d[i + 3];
    if (alpha < 128) {
      Lgrid[pix] = 0;
      mask[pix] = 0;
      continue;
    }
    const { L, a: oa, b } = srgb8ToOklab(d[i], d[i + 1], d[i + 2]);
    Ls.push(L);
    Cs.push(chroma(oa, b));
    oas.push(oa);
    bs.push(b);
    Lgrid[pix] = L;
    mask[pix] = 1;
  }

  const m = Ls.length;
  if (m === 0) return defaultLookParams();

  const Lsorted = [...Ls].sort((a, b) => a - b);
  const p25 = Lsorted[Math.floor(m * 0.25)] ?? 0.25;
  const p75 = Lsorted[Math.floor(m * 0.75)] ?? 0.75;
  const p95 = Lsorted[Math.floor(m * 0.95)] ?? 0.95;
  const refMidL = Lsorted[Math.floor(m * 0.5)] ?? 0.5;

  const meanA = oas.reduce((s, x) => s + x, 0) / oas.length;
  const meanB = bs.reduce((s, x) => s + x, 0) / bs.length;
  const warmth = Math.max(-0.35, Math.min(0.35, meanB * 1.1));
  const tint = Math.max(-0.2, Math.min(0.2, meanA * 0.7));

  const lift = Math.max(-0.2, Math.min(0.2, 0.4 * (p25 - 0.25)));
  const gamma = Math.max(0.5, Math.min(2, 1 + 0.6 * (0.5 - (p75 - p25))));
  let gain = Math.max(0.5, Math.min(2, 0.85 + 0.3 * (p75 / 0.75)));
  if (p95 > 0.92) {
    gain = Math.min(gain, 1.15);
  }

  const bins = 10;
  const binCounts = new Array<number>(bins).fill(0);
  const binC = new Array<number>(bins).fill(0);
  const binA = new Array<number>(bins).fill(0);
  const binB = new Array<number>(bins).fill(0);
  for (let i = 0; i < m; i++) {
    const L = Ls[i];
    const bi = Math.min(bins - 1, Math.floor(L * bins));
    binCounts[bi]++;
    binC[bi] += Cs[i];
    binA[bi] += oas[i];
    binB[bi] += bs[i];
  }

  let cMid = 0;
  let cMidCount = 0;
  for (let bi = Math.floor(bins * 0.3); bi <= Math.floor(bins * 0.7); bi++) {
    if (binCounts[bi] > 0) {
      cMid += binC[bi];
      cMidCount += binCounts[bi];
    }
  }
  cMid = cMidCount > 0 ? cMid / cMidCount : 0;

  const cShadow = binCounts[0] > 0 ? binC[0] / binCounts[0] : 0;
  const cHighlight =
    binCounts[bins - 1] > 0 ? binC[bins - 1] / binCounts[bins - 1] : 0;

  const shadowRolloff =
    cMid > 1e-6 ? Math.max(0, Math.min(1, 1 - cShadow / cMid)) : 0;
  const highlightRolloff =
    cMid > 1e-6 ? Math.max(0, Math.min(1, 1 - cHighlight / cMid)) : 0;

  const shadowColorDensity =
    cMid > 1e-6 && cShadow > 1e-6
      ? Math.max(0.5, Math.min(2, cShadow / cMid))
      : 1;
  const highlightColorDensity =
    cMid > 1e-6 && cHighlight > 1e-6
      ? Math.max(0.5, Math.min(1, cHighlight / cMid))
      : 1;

  const shadowA =
    binCounts[0] > 0 ? binA[0] / binCounts[0] : 0;
  const shadowB = binCounts[0] > 0 ? binB[0] / binCounts[0] : 0;
  const highlightA =
    binCounts[bins - 1] > 0 ? binA[bins - 1] / binCounts[bins - 1] : 0;
  const highlightB =
    binCounts[bins - 1] > 0 ? binB[bins - 1] / binCounts[bins - 1] : 0;

  const shadowTint = {
    a: Math.max(-0.22, Math.min(0.22, shadowA * 0.95)),
    b: Math.max(-0.22, Math.min(0.22, (shadowB - meanB) * 0.95)),
  };
  const highlightTint = {
    a: Math.max(-0.22, Math.min(0.22, highlightA * 0.95)),
    b: Math.max(-0.22, Math.min(0.22, (highlightB - meanB) * 0.95)),
  };

  const shadowSpread = p25;
  const shadowContrast =
    shadowSpread > 0.05
      ? Math.max(0.5, Math.min(2, 0.15 / shadowSpread))
      : 1;

  // Multi-segment tone curve: 8 anchors with stronger fitting in shadows
  const toneAnchors = [0, 0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 1];
  const percentiles = [0.02, 0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 0.98];
  const maxL = p95 > 0.92 ? 0.95 : 1; // Constrain when reference has blown highlights
  const L_out: number[] = [];
  for (let k = 0; k < toneAnchors.length; k++) {
    const idx = Math.floor((percentiles[k] ?? 0.5) * m);
    const v = Lsorted[Math.min(idx, m - 1)] ?? toneAnchors[k];
    L_out.push(Math.min(v, maxL));
  }
  // Optional slope floor: avoid forcing contrast when reference has soft toe/shoulder.
  // Use raw L_out from reference so curve shape (including flat bits) carries over.
  const toneCurve: ToneCurveParams = {
    L_in: [...toneAnchors],
    L_out: [...L_out],
  };

  // Multi-segment tint: 16 bands, stronger local tint (deviation from global), sharper transitions
  const numTintBands = 16;
  const tintAnchors: number[] = [];
  for (let k = 0; k < numTintBands; k++) {
    tintAnchors.push((k + 0.5) / numTintBands);
  }
  const rawA: number[] = [];
  const rawB: number[] = [];
  for (let k = 0; k < tintAnchors.length; k++) {
    const lo = k === 0 ? 0 : (tintAnchors[k - 1] + tintAnchors[k]) / 2;
    const hi =
      k === tintAnchors.length - 1
        ? 1
        : (tintAnchors[k] + tintAnchors[k + 1]) / 2;
    let sumA = 0;
    let sumB = 0;
    let count = 0;
    for (let i = 0; i < m; i++) {
      const L = Ls[i];
      if (L >= lo && L <= hi) {
        sumA += oas[i];
        sumB += bs[i];
        count++;
      }
    }
    if (count > 0) {
      rawA.push(sumA / count);
      rawB.push(sumB / count);
    } else {
      rawA.push(k > 0 ? rawA[k - 1] : meanA);
      rawB.push(k > 0 ? rawB[k - 1] : meanB);
    }
  }
  // Stronger local tint: deviation from global mean, scaled up
  const localScale = 1.4;
  const tintA = rawA.map((v) =>
    Math.max(-0.35, Math.min(0.35, (v - meanA) * localScale))
  );
  const tintB = rawB.map((v) =>
    Math.max(-0.45, Math.min(0.45, (v - meanB) * localScale))
  );
  const tintByL: TintByLParams = {
    L_anchors: tintAnchors,
    a: tintA,
    b: tintB,
  };

  const sumC: number[] = [];
  const countC: number[] = [];
  for (let k = 0; k < tintAnchors.length; k++) {
    const lo = k === 0 ? 0 : (tintAnchors[k - 1] + tintAnchors[k]) / 2;
    const hi =
      k === tintAnchors.length - 1
        ? 1
        : (tintAnchors[k] + tintAnchors[k + 1]) / 2;
    let s = 0;
    let n = 0;
    for (let i = 0; i < m; i++) {
      const L = Ls[i];
      if (L >= lo && L <= hi) {
        s += Cs[i];
        n++;
      }
    }
    sumC.push(s);
    countC.push(n);
  }
  let midChroma = 0;
  let cMidN = 0;
  for (let k = Math.floor(numTintBands * 0.25); k <= Math.floor(numTintBands * 0.75); k++) {
    if (countC[k] > 0) {
      midChroma += sumC[k];
      cMidN += countC[k];
    }
  }
  midChroma = cMidN > 0 ? midChroma / cMidN : 0.1;
  const saturationScale = sumC.map((s, k) =>
    countC[k] > 0 && midChroma > 1e-6
      ? Math.max(0.2, Math.min(2, s / countC[k] / midChroma))
      : 1
  );
  const saturationByL: SaturationByLParams = {
    L_anchors: [...tintAnchors],
    scale: saturationScale,
  };

  // Overall reference saturation: use median chroma so a few saturated spots don't pull the mean up.
  // Higher NEUTRAL (0.10) so desaturated film reliably gets scale < 1; saturated refs get > 1.
  const NEUTRAL_CHROMA = 0.10;
  const CsSorted = Cs.length > 0 ? [...Cs].sort((a, b) => a - b) : [NEUTRAL_CHROMA];
  const refMedianC = CsSorted[Math.floor(CsSorted.length * 0.5)] ?? NEUTRAL_CHROMA;
  const refSaturation =
    refMedianC <= 1e-6 ? 1 : Math.max(0.1, Math.min(2.5, refMedianC / NEUTRAL_CHROMA));

  // Reference midtone micro-contrast on L (RMS of high-frequency band in mid-L).
  const microContrastMid = computeMidDetailRms(Lgrid, mask, width, height);

  return {
    tone: { lift, gamma, gain },
    toneCurve,
    saturation: {
      shadowRolloff,
      highlightRolloff,
      shadowColorDensity,
      highlightColorDensity,
    },
    warmth,
    tint,
    shadowTint,
    highlightTint,
    shadowContrast,
    tintByL,
    saturationByL,
    refSaturation,
    microContrastMid,
    refMidL,
  };
}

/**
 * Compute source L range (p2, p98) for contrast-preserving curve application.
 */
function sourceLRange(d: Uint8ClampedArray): { L_min: number; L_max: number; range: number } {
  const Ls: number[] = [];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const { L } = srgb8ToOklab(d[i], d[i + 1], d[i + 2]);
    Ls.push(L);
  }
  if (Ls.length === 0) return { L_min: 0, L_max: 1, range: 1 };
  const sorted = [...Ls].sort((a, b) => a - b);
  const m = sorted.length;
  const p2 = sorted[Math.min(Math.floor(m * 0.02), m - 1)] ?? 0;
  const p98 = sorted[Math.min(Math.floor(m * 0.98), m - 1)] ?? 1;
  const range = Math.max(1e-6, p98 - p2);
  return { L_min: p2, L_max: p98, range };
}

/** Median source L over opaque pixels (used for exposure matching). */
function sourceMidL(d: Uint8ClampedArray): number {
  const Ls: number[] = [];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const { L } = srgb8ToOklab(d[i], d[i + 1], d[i + 2]);
    Ls.push(L);
  }
  if (Ls.length === 0) return 0.5;
  const sorted = [...Ls].sort((a, b) => a - b);
  const m = sorted.length;
  return sorted[Math.floor(m * 0.5)] ?? 0.5;
}

/** Simple separable 5-tap Gaussian blur (approx σ≈1) on a luminance grid. */
function gaussianBlur5(
  src: Float32Array,
  width: number,
  height: number
): Float32Array {
  const n = width * height;
  const tmp = new Float32Array(n);
  const out = new Float32Array(n);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const xm2 = x - 2 < 0 ? 0 : x - 2;
      const xm1 = x - 1 < 0 ? 0 : x - 1;
      const xp1 = x + 1 >= width ? width - 1 : x + 1;
      const xp2 = x + 2 >= width ? width - 1 : x + 2;
      const v =
        src[rowOffset + xm2] * 1 +
        src[rowOffset + xm1] * 4 +
        src[rowOffset + x] * 6 +
        src[rowOffset + xp1] * 4 +
        src[rowOffset + xp2] * 1;
      tmp[rowOffset + x] = v / 16;
    }
  }

  // Vertical pass
  for (let y = 0; y < height; y++) {
    const ym2 = y - 2 < 0 ? 0 : y - 2;
    const ym1 = y - 1 < 0 ? 0 : y - 1;
    const yp1 = y + 1 >= height ? height - 1 : y + 1;
    const yp2 = y + 2 >= height ? height - 1 : y + 2;
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const v =
        tmp[ym2 * width + x] * 1 +
        tmp[ym1 * width + x] * 4 +
        tmp[y * width + x] * 6 +
        tmp[yp1 * width + x] * 4 +
        tmp[yp2 * width + x] * 1;
      out[idx] = v / 16;
    }
  }

  return out;
}

/**
 * RMS of a single high-frequency detail band on L, restricted to midtones.
 * Used as a simple scalar "micro-contrast in mids" descriptor.
 */
function computeMidDetailRms(
  Lgrid: Float32Array,
  mask: Uint8Array,
  width: number,
  height: number
): number {
  const n = width * height;
  if (n === 0) return 0;
  const blurred = gaussianBlur5(Lgrid, width, height);
  let sumSq = 0;
  let count = 0;
  for (let idx = 0; idx < n; idx++) {
    if (!mask[idx]) continue;
    const L = Lgrid[idx];
    if (L < 0.25 || L > 0.75) continue; // focus on mids
    const d = L - blurred[idx];
    sumSq += d * d;
    count++;
  }
  if (count === 0) return 0;
  return Math.sqrt(sumSq / count);
}

/**
 * Apply LookParams to a source image. Returns new ImageData (non-mutating).
 * When toneCurve is used, applies reference curve SHAPE while preserving source L range (relative contrast).
 */
export function applyLook(source: ImageData, params: LookParams): ImageData {
  const out = new ImageData(source.width, source.height);
  const d = source.data;
  const o = out.data;
  const width = source.width;
  const height = source.height;
  const nPix = width * height;
  const {
    tone,
    saturation,
    warmth,
    tint = 0,
    shadowTint,
    highlightTint,
    shadowContrast,
    toneCurve,
    tintByL,
    saturationByL,
    refSaturation,
    colorDensity = 1,
    microContrastMid = 0,
    lumaStrength = 1,
    colorStrength = 1,
    refMidL = 0.5,
    exposureStrength = 1,
  } = params;
  const { lift, gamma, gain } = tone;
  const {
    shadowRolloff,
    highlightRolloff,
    shadowColorDensity,
    highlightColorDensity,
  } = saturation;

  const useToneCurve = toneCurve && toneCurve.L_in.length > 0 && toneCurve.L_out.length > 0;
  const useTintByL = tintByL && tintByL.L_anchors.length > 0;
  const useSaturationByL =
    saturationByL && saturationByL.L_anchors.length > 0 && saturationByL.scale.length > 0;
  const overallSat = refSaturation ?? 1;

  // Source mid-L for exposure matching (median over opaque pixels).
  const srcMidL = sourceMidL(d);
  const clampedRefMidL = Math.max(0, Math.min(1, refMidL));
  const clampedExposureStrength = Math.max(0, Math.min(2, exposureStrength));
  const exposureDelta = clampedExposureStrength * (clampedRefMidL - srcMidL);


  // No scene-based scaling – same behaviour for day and night; reference drives everything
  const sceneDensityScale = 1;
  // Stage A: tone mapping on L only (no color changes yet).
  const L_src = new Float32Array(nPix);
  const L_tone = new Float32Array(nPix);
  const aBuf = new Float32Array(nPix);
  const bBuf = new Float32Array(nPix);
  const alphaBuf = new Uint8ClampedArray(nPix);
  const mask = new Uint8Array(nPix);

  for (let i = 0, pix = 0; i < d.length; i += 4, pix++) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const a = d[i + 3];

    alphaBuf[pix] = a;
    if (a < 128) {
      L_tone[pix] = 0;
      L_src[pix] = 0;
      aBuf[pix] = 0;
      bBuf[pix] = 0;
      mask[pix] = 0;
      continue;
    }

    const lab = srgb8ToOklab(r, g, b);
    let { L, a: oa, b: ob } = lab;

    // Stage A0: global exposure match (shift L towards reference mid-L before tone curve / LGG).
    let L_exposed = L + exposureDelta;
    if (L_exposed < 0) L_exposed = 0;
    else if (L_exposed > 1) L_exposed = 1;
    const L0 = L_exposed;

    if (useToneCurve) {
      const L_curved = piecewiseLinear(L_exposed, toneCurve!.L_in, toneCurve!.L_out);
      // 100% reference curve in absolute L space (shape from reference) applied after exposure.
      L = Math.max(0, Math.min(1, L_curved));
    } else {
      L = applyShadowContrast(L_exposed, shadowContrast);
      L = applyLGG(L, lift, gamma, gain);
    }

    L_tone[pix] = L;
    L_src[pix] = L0;
    aBuf[pix] = oa;
    bBuf[pix] = ob;
    mask[pix] = 1;
  }

  // Optional Stage A2: micro-contrast on L in midtones, matching reference's mid-detail RMS.
  const L_final = new Float32Array(nPix);
  if (microContrastMid > 0) {
    const blurred = gaussianBlur5(L_tone, width, height);
    let sumSq = 0;
    let count = 0;
    for (let idx = 0; idx < nPix; idx++) {
      if (!mask[idx]) continue;
      const L = L_tone[idx];
      if (L < 0.25 || L > 0.75) continue;
      const dL = L - blurred[idx];
      sumSq += dL * dL;
      count++;
    }
    const srcRms = count > 0 ? Math.sqrt(sumSq / count) : 0;
    let gain = 1;
    if (srcRms > 1e-6) {
      gain = microContrastMid / srcRms;
      // Clamp to avoid over-sharpening or crushing local contrast.
      gain = Math.max(0.5, Math.min(2, gain));
    }
    for (let idx = 0; idx < nPix; idx++) {
      if (!mask[idx]) {
        L_final[idx] = 0;
        continue;
      }
      const base = blurred[idx];
      const dL = L_tone[idx] - base;
      let L = base + gain * dL;
      if (L < 0) L = 0;
      else if (L > 1) L = 1;
      L_final[idx] = L;
    }
  } else {
    // No reference micro-contrast info: use tone-mapped L as-is.
    for (let idx = 0; idx < nPix; idx++) {
      L_final[idx] = L_tone[idx];
    }
  }

  // Stage A3: blend luma between source and matched using lumaStrength (0..2).
  const lumaS = Math.max(0, Math.min(2, lumaStrength));
  const lumaBlend = lumaS <= 1 ? lumaS : 1 + 0.5 * (lumaS - 1);
  if (Math.abs(lumaBlend - 1) > 1e-3) {
    for (let idx = 0; idx < nPix; idx++) {
      const Ls = L_src[idx];
      const Lg = L_final[idx];
      // Linear extrapolation with gentle overshoot: 0 = source, 1 = reference, >1 = softened overshoot.
      let L = Ls + lumaBlend * (Lg - Ls);
      if (L < 0) L = 0;
      else if (L > 1) L = 1;
      L_final[idx] = L;
    }
  }

  // Stage B: color mapping (chroma + tint) using final L.
  const colorS = Math.max(0, Math.min(2, colorStrength));
  for (let pix = 0, i = 0; pix < nPix; pix++, i += 4) {
    const a = alphaBuf[pix];
    if (a < 128) {
      o[i] = 0;
      o[i + 1] = 0;
      o[i + 2] = 0;
      o[i + 3] = a;
      continue;
    }

    let L = L_final[pix];
    const aSrc = aBuf[pix];
    const bSrc = bBuf[pix];
    let oa = aSrc;
    let ob = bSrc;

    const C = chroma(oa, ob);
    const s = satScale(L, shadowRolloff, highlightRolloff);
    const dScale = colorDensityScale(L, shadowColorDensity, highlightColorDensity);
    let bandScale = useSaturationByL ? interpolateSaturationByL(L, saturationByL!) : 1;
    if (overallSat < 1 && bandScale > 1) bandScale = 1; // desaturated ref: don't boost any band
    const scale =
      C > 1e-8
        ? s * dScale * colorDensity * sceneDensityScale * bandScale * overallSat
        : 0;
    oa *= scale;
    ob *= scale;

    if (useTintByL) {
      const t = interpolateTintByL(L, tintByL);
      const localContrast = 1 + 0.25 * Math.min(1, C / 0.08);
      const highlightFade = 1 - 0.15 * L * L;
      const shadowMidBoost = 1 + 0.75 * (1 - L) ** 0.585;
      oa += t.a * localContrast * highlightFade * shadowMidBoost;
      ob += t.b * localContrast * highlightFade * shadowMidBoost;
      oa += tint * 0.35;
      ob += warmth * 0.35;
    } else {
      oa += tint;
      ob += warmth;
      const shadowW = (1 - L) ** 2;
      const highlightW = L ** 2;
      oa += shadowTint.a * shadowW + highlightTint.a * highlightW;
      ob += shadowTint.b * shadowW + highlightTint.b * highlightW;
    }

    // Final Stage B2: blend color between source and matched using colorStrength (0..2).
    if (Math.abs(colorS - 1) > 1e-3) {
      oa = aSrc + colorS * (oa - aSrc);
      ob = bSrc + colorS * (ob - bSrc);
    }

    const rgb = oklabToSrgb8(L, oa, ob);
    o[i] = rgb.r;
    o[i + 1] = rgb.g;
    o[i + 2] = rgb.b;
    o[i + 3] = a;
  }

  return out;
}
