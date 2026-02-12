/**
 * Parametric color grading: fit LookParams from reference, apply to source.
 * Pure math, deterministic, OKLab-based. No LUT, ML, or external libs.
 */

import { oklabToSrgb8, srgb8ToOklab } from "./oklab";
import {
  bucketForRefColor,
  bucketForRefExposure,
  bucketForSourceExposure,
} from "@/src/lib/pipeline/heuristicsBuckets";
import { applyHeuristicsToMatch } from "@/src/lib/pipeline/heuristicsAdapter";
import { LEARNED_HEURISTICS } from "@/src/config/learnedHeuristics";

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

export type ColorBandId =
  | "lowerShadow"
  | "upperShadow"
  | "mid"
  | "lowerHigh"
  | "upperHigh";

export interface ColorBandStrengths {
  lowerShadow: number;
  upperShadow: number;
  mid: number;
  lowerHigh: number;
  upperHigh: number;
}

/**
 * Optional manual per-band overrides applied *after* the automatic 5-band
 * colour match. These let the UI nudge hue/saturation/luma per band without
 * changing how the core matcher derives deltas from the reference.
 */
export interface ColorBandOverrides {
  /** Per-band hue shift control (-1..1, mapped to a small hue rotation). */
  hue: ColorBandStrengths;
  /** Per-band saturation multiplier (0..2, 1 = neutral). */
  sat: ColorBandStrengths;
  /** Per-band luma offset (-0.2..0.2, 0 = neutral). */
  luma: ColorBandStrengths;
}

/**
 * Optional reference-side statistics for 5-band colour matching.
 * Each array has one entry per band, in the order:
 *   [lowerShadow, upperShadow, mid, lowerHigh, upperHigh]
 */
export interface ColorMatchBandStats {
  /** Mean OKLab a per band in the reference. */
  refA: number[];
  /** Mean OKLab b per band in the reference. */
  refB: number[];
  /** Mean chroma per band in the reference. */
  refC: number[];
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
  /** Reference "black" level (e.g. 5th percentile L) used for shadow / black matching. */
  refBlackL?: number;
  /** UI-driven exposure match strength (0..2, 1 = match reference; <1 lean to source; >1 overshoot). */
  exposureStrength?: number;
  /** UI-driven black match strength (0..4, 1 = normal, >1 = stronger pull). */
  blackStrength?: number;
  /**
   * Upper luminance bound for black/shadow pull (0..1). Pixels with L below this
   * are affected by Stage A4; higher values extend the pull into midtones.
   */
  blackRange?: number;
  /**
   * Per-luminance-band color match strengths. These modulate how strongly
   * reference tint/grade is applied in:
   *  - lowerShadow   (deepest shadows)
   *  - upperShadow   (toe / low-mids)
   *  - mid           (true midtones)
   *  - lowerHigh     (lower highlights)
   *  - upperHigh     (brightest highlights)
   *
   * 1 = use fitted reference grade as-is, 0 = disable band, >1 exaggerates.
   */
  colorBandStrengths?: ColorBandStrengths;
  /**
   * Optional per-band reference colour stats for true 5-band matching.
   * When present, used together with source band stats to compute Δa/Δb
   * per band in Stage B.
   */
  colorMatchBands?: ColorMatchBandStats;
  /**
   * Optional manual per-band overrides (hue/sat/luma) layered on top of the
   * automatic 5-band match. These are designed to be driven directly from the
   * Lab UI sliders.
   */
  colorBandOverrides?: ColorBandOverrides;
  /**
   * Optional highlight fill (bloom/density) for the halation stage. Not fitted
   * from reference; driven from match UI and corrections.
   */
  highlightFill?: { strength: number; warmth?: number };
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
    refBlackL: 0.05,
    exposureStrength: 1,
    blackStrength: 1,
    blackRange: 0.6,
    colorBandStrengths: {
      lowerShadow: 1,
      upperShadow: 1,
      mid: 1,
      lowerHigh: 1,
      upperHigh: 1,
    },
    colorMatchBands: undefined,
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
  // Use 2nd percentile for a truer black anchor (5th percentile often lands too high).
  const p02 = Lsorted[Math.floor(m * 0.02)] ?? 0.02;
  const p05 = Lsorted[Math.floor(m * 0.05)] ?? 0.05;
  const refBlackL = Math.min(p02, p05);

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
  // Stronger local tint: deviation from global mean, scaled up.
  // We keep this general-purpose but add a few safeguards so warm bands
  // (skin, bricks, warm highlights) don't flip toward green/magenta due to
  // small local deviations or a few outlier pixels.
  const localScale = 1.1;
  const maxDelta = 0.22; // max per-band deviation in any direction

  const tintA: number[] = [];
  const tintB: number[] = [];
  for (let k = 0; k < rawA.length; k++) {
    const vA = rawA[k];
    const vB = rawB[k];
    let dA = vA - meanA;
    let dB = vB - meanB;

    // If global reference is clearly warm (meanB > 0) and this band is also
    // warm (vB > 0), avoid flipping the sign of warmth just because this band
    // is *slightly* less warm than the global mean.
    if (meanB > 0.03 && vB > 0.01 && dB * meanB < 0) {
      dB *= 0.25;
    }
    // Same for cool refs but mirrored.
    if (meanB < -0.03 && vB < -0.01 && dB * meanB < 0) {
      dB *= 0.25;
    }

    // Global clamp on per-band tint distance so no band can run away and
    // create wild colour shifts (e.g. green bricks from a few pixels).
    const len = Math.hypot(dA, dB);
    if (len > maxDelta && len > 1e-6) {
      const s = maxDelta / len;
      dA *= s;
      dB *= s;
    }

    const aBand = Math.max(-0.35, Math.min(0.35, dA * localScale));
    const bBand = Math.max(-0.45, Math.min(0.45, dB * localScale));
    tintA.push(aBand);
    tintB.push(bBand);
  }
  const tintByL: TintByLParams = {
    L_anchors: tintAnchors,
    a: tintA,
    b: tintB,
  };

  // Five-band reference stats for true 5-band colour matching.
  // Anchors roughly span: deep shadows, upper shadows, mids, lower highs, upper highs.
  const COLOR_BAND_ANCHORS = [0.08, 0.25, 0.5, 0.7, 0.9];
  const bandCount = COLOR_BAND_ANCHORS.length;
  const refSumA = new Array<number>(bandCount).fill(0);
  const refSumB = new Array<number>(bandCount).fill(0);
  const refSumC = new Array<number>(bandCount).fill(0);
  const refSumW = new Array<number>(bandCount).fill(0);

  function bandWeights(L: number): number[] {
    const w: number[] = new Array(bandCount).fill(0);
    const anchors = COLOR_BAND_ANCHORS;
    // Triangular kernels around each anchor, with soft overlap.
    for (let k = 0; k < bandCount; k++) {
      const center = anchors[k];
      const left = k === 0 ? 0 : anchors[k - 1];
      const right = k === bandCount - 1 ? 1 : anchors[k + 1];
      const width = Math.max(1e-3, Math.max(center - left, right - center));
      const t = 1 - Math.abs(L - center) / width;
      w[k] = t > 0 ? t : 0;
    }
    let sum = 0;
    for (let k = 0; k < bandCount; k++) sum += w[k];
    if (sum > 1e-6) {
      for (let k = 0; k < bandCount; k++) w[k] /= sum;
    }
    return w;
  }

  for (let i = 0; i < m; i++) {
    const L = Ls[i];
    const C = Cs[i];
    const aVal = oas[i];
    const bVal = bs[i];
    const w = bandWeights(L);
    for (let k = 0; k < bandCount; k++) {
      const wk = w[k];
      if (wk <= 0) continue;
      refSumA[k] += wk * aVal;
      refSumB[k] += wk * bVal;
      refSumC[k] += wk * C;
      refSumW[k] += wk;
    }
  }

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

  const refA: number[] = [];
  const refB: number[] = [];
  const refC: number[] = [];
  for (let k = 0; k < bandCount; k++) {
    const w = refSumW[k];
    if (w > 1e-4) {
      refA[k] = refSumA[k] / w;
      refB[k] = refSumB[k] / w;
      refC[k] = refSumC[k] / w;
    } else {
      // Fall back to global means when band has almost no support.
      refA[k] = meanA;
      refB[k] = meanB;
      refC[k] = midChroma || 0.1;
    }
  }
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

  // Heuristic black match controls derived from reference shadows.
  // References are hand-picked and generally well-exposed, so we can lean
  // hard into them here. Deep, tight shadows → aggressive black pull; lifted
  // blacks → gentler.
  let blackStrength = 1;
  let blackRange = 0.6;

  const deepBlacks = refBlackL < 0.03;
  const veryDeepBlacks = refBlackL < 0.015;
  const tightShadows = shadowSpread < 0.12;
  const veryTightShadows = shadowSpread < 0.08;

  if (veryDeepBlacks && veryTightShadows) {
    // Hard, punchy blacks (crisp neg / slide) – push strongly and far up
    // into the lower mids so boring RAWs adopt the full reference depth.
    blackStrength = 4.5;
    blackRange = 0.9;
  } else if (deepBlacks && tightShadows) {
    blackStrength = 3.5;
    blackRange = 0.85;
  } else if (deepBlacks) {
    blackStrength = 2.5;
    blackRange = 0.8;
  } else if (refBlackL < 0.06) {
    blackStrength = 1.8;
    blackRange = 0.7;
  } else if (refBlackL > 0.09) {
    // Very lifted blacks: keep match gentle and more local to the toe.
    blackStrength = 0.7;
    blackRange = 0.45;
  }

  const colorBandStrengths: ColorBandStrengths = {
    lowerShadow: 1,
    upperShadow: 1,
    mid: 1,
    lowerHigh: 1,
    upperHigh: 1,
  };

  const base: LookParams = {
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
    refBlackL,
    blackStrength,
    blackRange,
    colorBandStrengths,
    colorMatchBands: {
      refA,
      refB,
      refC,
    },
    colorBandOverrides: undefined,
  };

  // Optionally apply learned heuristics as deltas on top of the analytic
  // defaults derived above. At this point we only know about the reference, so
  // we can populate reference-side buckets; source-side context is filled in
  // later once source stats are available.
  if (LEARNED_HEURISTICS) {
    const refExposureBucket = bucketForRefExposure({
      medianL: refMidL,
      p05L: p05,
      p95L: p95,
    });
    const refColorBucket = bucketForRefColor({
      meanA: meanA,
      meanB: meanB,
      meanC: Cs.length
        ? Cs.reduce((s, c) => s + c, 0) / Cs.length
        : 0,
      bands: [],
    });

    const adjustedMatch = applyHeuristicsToMatch(
      {
        // match.ts works with the engine-side LookParams; we only have grading
        // params here, so we apply heuristics later in the pipeline when
        // LookParamsMatch is available. This call is a no-op placeholder to
        // keep types aligned and will be wired to real match defaults in the
        // surrounding pipeline code.
        lumaStrength: 1,
        colorStrength: 1,
        colorDensity: 1,
        exposureStrength: 1,
        blackStrength: blackStrength,
        blackRange: blackRange,
        bandLowerShadow: 1,
        bandUpperShadow: 1,
        bandMid: 1,
        bandLowerHigh: 1,
        bandUpperHigh: 1,
        bandLowerShadowHue: 0,
        bandUpperShadowHue: 0,
        bandMidHue: 0,
        bandLowerHighHue: 0,
        bandUpperHighHue: 0,
        bandLowerShadowSat: 1,
        bandUpperShadowSat: 1,
        bandMidSat: 1,
        bandLowerHighSat: 1,
        bandUpperHighSat: 1,
        bandLowerShadowLuma: 0,
        bandUpperShadowLuma: 0,
        bandMidLuma: 0,
        bandLowerHighLuma: 0,
        bandUpperHighLuma: 0,
        highlightFillStrength: 0,
        highlightFillWarmth: 0,
      },
      LEARNED_HEURISTICS,
      {
        refExposureBucket,
        refColorBucket,
      }
    );
    // Currently we only care about black-strength related heuristics here;
    // the full match object is applied at the UI / run-pipeline layer.
    base.blackStrength = adjustedMatch.blackStrength;
    base.blackRange = adjustedMatch.blackRange;
  }

  return base;
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

/** Approximate "black" level of source: low-percentile L over opaque pixels (e.g. 5th percentile). */
function sourceBlackL(d: Uint8ClampedArray): number {
  const Ls: number[] = [];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const { L } = srgb8ToOklab(d[i], d[i + 1], d[i + 2]);
    Ls.push(L);
  }
  if (Ls.length === 0) return 0.05;
  const sorted = [...Ls].sort((a, b) => a - b);
  const m = sorted.length;
  return sorted[Math.floor(m * 0.05)] ?? 0.05;
}

/** Percentile of L from a grid, restricted to opaque pixels by mask. */
function percentileFromLGrid(
  Lgrid: Float32Array,
  mask: Uint8Array,
  p: number
): number {
  const vals: number[] = [];
  const n = Lgrid.length;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    vals.push(Lgrid[i]);
  }
  if (vals.length === 0) return 0;
  vals.sort((a, b) => a - b);
  const idx = Math.floor(Math.max(0, Math.min(1, p)) * (vals.length - 1));
  return vals[idx] ?? 0;
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
 * Heavier blur for film-like microcontrast: captures medium-frequency, coarser
 * detail rather than sharp high-frequency. Two passes of 5-tap ≈ σ≈1.4.
 */
function gaussianBlurFilm(
  src: Float32Array,
  width: number,
  height: number
): Float32Array {
  const once = gaussianBlur5(src, width, height);
  return gaussianBlur5(once, width, height);
}

/**
 * RMS of a medium-frequency detail band on L, restricted to midtones.
 * Uses heavier blur for film-like, low-resolution microcontrast.
 */
function computeMidDetailRms(
  Lgrid: Float32Array,
  mask: Uint8Array,
  width: number,
  height: number
): number {
  const n = width * height;
  if (n === 0) return 0;
  const blurred = gaussianBlurFilm(Lgrid, width, height);
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
    refBlackL = 0.05,
    exposureStrength = 1,
    blackStrength = 1,
    blackRange = 0.6,
    colorBandStrengths,
    colorMatchBands,
    colorBandOverrides,
  } = params;
  const { lift, gamma, gain } = tone;
  const {
    shadowRolloff,
    highlightRolloff,
    shadowColorDensity,
    highlightColorDensity,
  } = saturation;

  const useToneCurve =
    toneCurve && toneCurve.L_in.length > 0 && toneCurve.L_out.length > 0;
  const useTintByL = tintByL && tintByL.L_anchors.length > 0;
  const useSaturationByL =
    saturationByL && saturationByL.L_anchors.length > 0 && saturationByL.scale.length > 0;
  const overallSat = refSaturation ?? 1;

  // Source mid-L for exposure matching (median over opaque pixels).
  const srcMidL = sourceMidL(d);
  const clampedRefMidL = Math.max(0, Math.min(1, refMidL));
  const clampedExposureStrength = Math.max(0, Math.min(2, exposureStrength));
  // Ideal delta to align medians, with a mild clamp so extremely different
  // pairs don't blow up. We treat exposureStrength in [0,1] as interpolation
  // between 0 and this ideal delta; >1 only extends it gently.
  const idealDeltaRaw = clampedRefMidL - srcMidL;
  const idealDelta = Math.max(-0.6, Math.min(0.6, idealDeltaRaw));
  let exposureDelta = 0;
  if (clampedExposureStrength <= 1) {
    exposureDelta = clampedExposureStrength * idealDelta;
  } else {
    const extra = clampedExposureStrength - 1; // 0..1
    const maxOvershoot = 0.3; // up to 30% beyond ideal
    exposureDelta = idealDelta * (1 + maxOvershoot * extra);
  }

  // Source and reference "black" levels (low-percentile L) for shadow / black matching.
  const srcBlack = sourceBlackL(d);
  const clampedRefBlack = Math.max(0, Math.min(0.2, refBlackL));
  const clampedBlackStrength = Math.max(0, Math.min(8, blackStrength));
  const blackDelta = clampedBlackStrength * (clampedRefBlack - srcBlack);


  // No scene-based scaling – same behaviour for day and night; reference drives everything
  const sceneDensityScale = 1;
  // Stage A: tone mapping on L only (no color changes yet).
  const L_src = new Float32Array(nPix);
  const L_tone = new Float32Array(nPix);
  // L after exposure + tone + luma/black matching (before microcontrast).
  const L_luma = new Float32Array(nPix);
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
    let { L } = lab;
    const oa = lab.a;
    const ob = lab.b;

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

  // Optional Stage A2: micro-contrast on L in midtones, film-like (medium-frequency detail).
  // Start from tone-mapped L before microcontrast; this buffer will host
  // luma-strength blending and black/shadow alignment *before* actuance.
  for (let idx = 0; idx < nPix; idx++) {
    L_luma[idx] = L_tone[idx];
  }

  // Stage A3: blend luma between source and matched using lumaStrength (0..2).
  // Semantics:
  //   0   = keep exposed source luma
  //   1   = use reference tone curve shape (no overshoot)
  //   >1  = gently increase contrast beyond reference
  const lumaS = Math.max(0, Math.min(2, lumaStrength));
  let lumaBlend = 0;
  if (lumaS <= 1) {
    lumaBlend = lumaS;
  } else {
    const extra = lumaS - 1; // 0..1
    const maxOvershoot = 0.3; // allow up to 30% beyond reference
    lumaBlend = 1 + maxOvershoot * extra;
  }
  if (Math.abs(lumaBlend) > 1e-3) {
    for (let idx = 0; idx < nPix; idx++) {
      const Ls = L_src[idx];
      const Lg = L_luma[idx];
      // 0 = source, 1 = reference; no overshoot. Quadratic mapping keeps
      // low strengths subtle and encourages using the full slider travel.
      let L = Ls + lumaBlend * (Lg - Ls);
      if (L < 0) L = 0;
      else if (L > 1) L = 1;
      L_luma[idx] = L;
    }
  }

  // Stage A4: explicit black / shadow alignment with safety normalization.
  // Use low-percentile L from reference and source to gently pull shadows
  // toward the reference black while avoiding over-crushing.
  if (Math.abs(blackDelta) > 1e-3) {
    const L_beforeBlack = new Float32Array(L_luma);
    // When user sets black point to 0, use wider range and linear falloff so the pull is visible.
    const pullDown = blackDelta < 0;
    const baseShadowCeiling = Math.max(0.1, Math.min(0.95, blackRange));
    const useWideRange = pullDown && clampedRefBlack < 0.02;
    const shadowCeiling = useWideRange
      ? Math.min(0.95, baseShadowCeiling + 0.2)
      : baseShadowCeiling;
    const linearWeight = useWideRange; // (1-t) instead of (1-t)^2 for stronger pull

    // Soft shadow compression: affect L <= shadowCeiling, strongest near 0.
    for (let idx = 0; idx < nPix; idx++) {
      if (!mask[idx]) continue;
      let L = L_luma[idx];
      if (L <= shadowCeiling) {
        const tShadow = L / shadowCeiling;
        const weight = linearWeight ? 1 - tShadow : (1 - tShadow) * (1 - tShadow); // linear when pulling to 0 for visibility
        L += blackDelta * weight;
        if (L < 0) L = 0;
        else if (L > 1) L = 1;
        L_luma[idx] = L;
      }
    }

    // Normalization: ensure processed shadows aren't much darker than reference.
    const p5Ref = clampedRefBlack;
    const p5Before = percentileFromLGrid(L_beforeBlack, mask, 0.05);
    const p5After = percentileFromLGrid(L_luma, mask, 0.05);
    // Allow up to ~0.03 deeper blacks than reference.
    const minAllowed = Math.max(0, p5Ref - 0.03);
    if (p5After < minAllowed && p5Before > minAllowed) {
      const denom = p5After - p5Before;
      if (Math.abs(denom) > 1e-5) {
        let alpha = (minAllowed - p5Before) / denom;
        if (alpha < 0) alpha = 0;
        else if (alpha > 1) alpha = 1;
        for (let idx = 0; idx < nPix; idx++) {
          if (!mask[idx]) continue;
          const L0 = L_beforeBlack[idx];
          let L = L0 + alpha * (L_luma[idx] - L0);
          if (L < 0) L = 0;
          else if (L > 1) L = 1;
          L_luma[idx] = L;
        }
      }
    }
  }

  // Stage A5: actuance / microcontrast on the *final* luma (after exposure,
  // tone curve, luma-strength blend, and black alignment). This keeps local
  // contrast tied to the final tone structure instead of fighting later
  // luma/black stages.
  const L_final = new Float32Array(nPix);
  if (microContrastMid > 0) {
    const blurred = gaussianBlurFilm(L_luma, width, height);
    let sumSq = 0;
    let count = 0;
    for (let idx = 0; idx < nPix; idx++) {
      if (!mask[idx]) continue;
      const L = L_luma[idx];
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
      const dL = L_luma[idx] - base;
      let L = base + gain * dL;
      if (L < 0) L = 0;
      else if (L > 1) L = 1;
      L_final[idx] = L;
    }
  } else {
    for (let idx = 0; idx < nPix; idx++) {
      L_final[idx] = L_luma[idx];
    }
  }

  // Stage B: color mapping (chroma + tint) using final L.
  const colorS = Math.max(0, Math.min(2, colorStrength));
  const bands = colorBandStrengths;

  // Precompute 5-band source stats for true 5-band colour matching when we
  // have reference-side stats available.
  const useColorBands =
    !!colorMatchBands &&
    Array.isArray(colorMatchBands.refA) &&
    colorMatchBands.refA.length === 5 &&
    Array.isArray(colorMatchBands.refB) &&
    colorMatchBands.refB.length === 5 &&
    Array.isArray(colorMatchBands.refC) &&
    colorMatchBands.refC.length === 5;

  const COLOR_BAND_ANCHORS = [0.08, 0.25, 0.5, 0.7, 0.9];
  const bandCount = COLOR_BAND_ANCHORS.length;

  function bandWeights(L: number): number[] {
    const w = new Array<number>(bandCount).fill(0);
    const anchors = COLOR_BAND_ANCHORS;
    for (let k = 0; k < bandCount; k++) {
      const center = anchors[k];
      const left = k === 0 ? 0 : anchors[k - 1];
      const right = k === bandCount - 1 ? 1 : anchors[k + 1];
      const width = Math.max(1e-3, Math.max(center - left, right - center));
      const tL = 1 - Math.abs(L - center) / width;
      w[k] = tL > 0 ? tL : 0;
    }
    let sum = 0;
    for (let k = 0; k < bandCount; k++) sum += w[k];
    if (sum > 1e-6) {
      for (let k = 0; k < bandCount; k++) w[k] /= sum;
    }
    return w;
  }

  const srcSumA = new Array<number>(bandCount).fill(0);
  const srcSumB = new Array<number>(bandCount).fill(0);
  const srcSumC = new Array<number>(bandCount).fill(0);
  const srcSumW = new Array<number>(bandCount).fill(0);

  if (useColorBands) {
    for (let idx = 0; idx < nPix; idx++) {
      if (!mask[idx]) continue;
      const L = L_final[idx];
      const aVal = aBuf[idx];
      const bVal = bBuf[idx];
      const C = chroma(aVal, bVal);
      const w = bandWeights(L);
      for (let k = 0; k < bandCount; k++) {
        const wk = w[k];
        if (wk <= 0) continue;
        srcSumA[k] += wk * aVal;
        srcSumB[k] += wk * bVal;
        srcSumC[k] += wk * C;
        srcSumW[k] += wk;
      }
    }
  }

  const bandDeltaA = new Array<number>(bandCount).fill(0);
  const bandDeltaB = new Array<number>(bandCount).fill(0);
  const bandScaleC = new Array<number>(bandCount).fill(1);

  if (useColorBands) {
    const refA = colorMatchBands!.refA;
    const refB = colorMatchBands!.refB;
    const refC = colorMatchBands!.refC;
    for (let k = 0; k < bandCount; k++) {
      const w = srcSumW[k];
      if (w <= 1e-4) {
        bandDeltaA[k] = 0;
        bandDeltaB[k] = 0;
        bandScaleC[k] = 1;
        continue;
      }
      const aSrc = srcSumA[k] / w;
      const bSrc = srcSumB[k] / w;
      const cSrc = srcSumC[k] / w;
      const aRef = refA[k];
      const bRef = refB[k];
      const cRef = refC[k];

      let dA = aRef - aSrc;
      let dB = bRef - bSrc;

      // Clamp vector length (hue shift + saturation change) so no band can
      // run away and create wild colour shifts.
      const len = Math.hypot(dA, dB);
      const maxLen = 0.16;
      if (len > maxLen && len > 1e-6) {
        const s = maxLen / len;
        dA *= s;
        dB *= s;
      }

      // Avoid flipping warm bands toward green/cyan and vice versa.
      if (aSrc > -0.02 && bSrc > 0.02 && aRef > -0.02 && bRef > 0.02) {
        // Warm in both; dampen deltas that would strongly cross the a/b axes.
        if (dB < 0) dB *= 0.4;
      }

      bandDeltaA[k] = dA;
      bandDeltaB[k] = dB;

      if (cSrc > 1e-4 && cRef > 1e-4) {
        let kC = cRef / cSrc;
        if (kC < 0.5) kC = 0.5;
        else if (kC > 1.8) kC = 1.8;
        bandScaleC[k] = kC;
      } else {
        bandScaleC[k] = 1;
      }
    }
  }
  // Helpers to read per-band override values safely.
  function bandValue(
    id: number,
    values:
      | ColorBandStrengths
      | undefined
  ): number {
    if (!values) return id === 0 || id === 1 || id === 2 || id === 3 || id === 4
      ? (id === 0
          ? 0
          : 0)
      : 0;
    switch (id) {
      case 0:
        return values.lowerShadow;
      case 1:
        return values.upperShadow;
      case 2:
        return values.mid;
      case 3:
        return values.lowerHigh;
      case 4:
      default:
        return values.upperHigh;
    }
  }

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

    if (useColorBands) {
      // True 5-band Δa/Δb matching: blend per-band deltas and chroma scales
      // based on this pixel's luminance, then apply on top of the source.
      const w = bandWeights(L);
      let numA = 0;
      let numB = 0;
      let numCScale = 0;
      let den = 0;
      for (let k = 0; k < bandCount; k++) {
        let wk = w[k];
        if (wk <= 0) continue;
        if (bands) {
          const strength =
            k === 0
              ? bands.lowerShadow
              : k === 1
              ? bands.upperShadow
              : k === 2
              ? bands.mid
              : k === 3
              ? bands.lowerHigh
              : bands.upperHigh;
          wk *= strength;
        }
        numA += wk * bandDeltaA[k];
        numB += wk * bandDeltaB[k];
        numCScale += wk * bandScaleC[k];
        den += wk;
      }
      const baseA = aSrc;
      const baseB = bSrc;
      if (den > 1e-4) {
        const dA = numA / den;
        const dB = numB / den;
        const kC = numCScale / den;
        const baseC = chroma(baseA, baseB);
        let aMatch = baseA + dA;
        let bMatch = baseB + dB;
        // Apply chroma scaling along the matched hue direction.
        const cMatch = chroma(aMatch, bMatch);
        if (cMatch > 1e-5 && baseC > 1e-5) {
          const scaleToRef = (baseC * kC) / cMatch;
          const clampScale = Math.max(0.4, Math.min(2.2, scaleToRef));
          aMatch *= clampScale;
          bMatch *= clampScale;
        }
        oa = aMatch;
        ob = bMatch;
      }
      // Global tint/warmth still apply as gentle bias.
      oa += tint * 0.25;
      ob += warmth * 0.25;
      } else if (useTintByL) {
      const t = interpolateTintByL(L, tintByL);
      // Per-band color strength: modulate how strongly reference tint is applied
      // in shadows/mids/highlights. When not provided, falls back to 1.
      let bandFactor = 1;
      if (bands) {
        const ls = Math.max(0, Math.min(1, L));
        // Five overlapping triangular bands across L.
        const wLowerShadow = ls <= 0.3 ? (ls <= 0.15 ? 1 - ls / 0.15 : Math.max(0, (0.3 - ls) / 0.15)) : 0;
        const wUpperShadow =
          ls >= 0.1 && ls <= 0.45
            ? 1 - Math.abs(ls - 0.275) / 0.175
            : 0;
        const wMid =
          ls >= 0.3 && ls <= 0.7
            ? 1 - Math.abs(ls - 0.5) / 0.2
            : 0;
        const wLowerHigh =
          ls >= 0.5 && ls <= 0.85
            ? 1 - Math.abs(ls - 0.675) / 0.175
            : 0;
        const wUpperHigh =
          ls >= 0.7
            ? (ls <= 0.85 ? (ls - 0.7) / 0.15 : Math.max(0, (1 - ls) / 0.15))
            : 0;
        const num =
          wLowerShadow * bands.lowerShadow +
          wUpperShadow * bands.upperShadow +
          wMid * bands.mid +
          wLowerHigh * bands.lowerHigh +
          wUpperHigh * bands.upperHigh;
        const den =
          wLowerShadow +
          wUpperShadow +
          wMid +
          wLowerHigh +
          wUpperHigh;
        bandFactor = den > 1e-3 ? num / den : 1;
      }
      const localContrast = 1 + 0.25 * Math.min(1, C / 0.08);
      const highlightFade = 1 - 0.15 * L * L;
      const shadowMidBoost = 1 + 0.75 * (1 - L) ** 0.585;
      oa += bandFactor * t.a * localContrast * highlightFade * shadowMidBoost;
      ob += bandFactor * t.b * localContrast * highlightFade * shadowMidBoost;
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

    // Stage B3: apply manual per-band overrides (hue/sat/luma), if provided.
    if (colorBandOverrides) {
      const w = bandWeights(L);
      let hueControl = 0;
      let satControl = 0;
      let lumaControl = 0;
      for (let k = 0; k < bandCount; k++) {
        const wk = w[k];
        if (wk <= 0) continue;
        hueControl += wk * bandValue(k, colorBandOverrides.hue);
        // Saturation sliders are centred at 1; we aggregate their delta from 1.
        const satVal = bandValue(k, colorBandOverrides.sat);
        satControl += wk * (satVal - 1);
        lumaControl += wk * bandValue(k, colorBandOverrides.luma);
      }

      // Hue: map [-1,1] → [-30°,30°] and rotate in a/b plane.
      const maxHueRad = (Math.PI / 180) * 30;
      const theta = Math.max(-1, Math.min(1, hueControl)) * maxHueRad;
      if (Math.abs(theta) > 1e-4) {
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const aRot = oa * cosT - ob * sinT;
        const bRot = oa * sinT + ob * cosT;
        oa = aRot;
        ob = bRot;
      }

      // Saturation: aggregate delta from 1 and clamp to a sensible range.
      const satMulRaw = 1 + satControl;
      const satMul = Math.max(0.2, Math.min(2.5, satMulRaw));
      const Cafter = chroma(oa, ob);
      if (Cafter > 1e-6 && Math.abs(satMul - 1) > 1e-3) {
        const s = satMul;
        oa *= s;
        ob *= s;
      }

      // Luma: aggregate offsets and clamp.
      if (Math.abs(lumaControl) > 1e-4) {
        const maxLumaOffset = 0.2;
        const dL = Math.max(
          -maxLumaOffset,
          Math.min(maxLumaOffset, lumaControl)
        );
        L = Math.max(0, Math.min(1, L + dL));
      }
    }

    const rgb = oklabToSrgb8(L, oa, ob);
    o[i] = rgb.r;
    o[i + 1] = rgb.g;
    o[i + 2] = rgb.b;
    o[i + 3] = a;
  }

  return out;
}
