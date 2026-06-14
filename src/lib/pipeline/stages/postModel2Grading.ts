/**
 * Post-Model2 grading stages.
 * When matchModel === 2, the Reinhard transfer ignores grading params.
 * These stages apply color density curve and 5-band hue/temp after the match.
 */

import { linearRgbToOklab, oklabToLinearRgb } from "./oklab";
import type { PixelFrameF32 } from "../types";
import { allocPixelFrameF32 } from "../types";
import type { ColorBandOverrides, ColorBandStrengths } from "./match";

/** Piecewise linear interpolation: map L to scale from (L_anchors, scale). */
function interpolateColorDensityCurve(
  L: number,
  curve: { L_anchors: number[]; scale: number[] }
): number {
  const { L_anchors, scale } = curve;
  const n = Math.min(L_anchors.length, scale.length);
  if (n === 0) return 1;
  if (L <= L_anchors[0]!) return scale[0] ?? 1;
  if (L >= L_anchors[n - 1]!) return scale[n - 1] ?? 1;
  for (let i = 0; i < n - 1; i++) {
    if (L >= L_anchors[i]! && L <= L_anchors[i + 1]!) {
      const t = (L - L_anchors[i]!) / (L_anchors[i + 1]! - L_anchors[i]!);
      return (scale[i] ?? 1) + t * ((scale[i + 1] ?? 1) - (scale[i] ?? 1));
    }
  }
  return scale[n - 1] ?? 1;
}

/**
 * Apply the 7-handle color density curve as chroma scaling in OKLab.
 * scale(a,b) by interpolated factor; preserve hue.
 * Default scale [1,1,1,1,1,1,1] = identity.
 */
export function applyColorDensityCurveFloat(
  frame: PixelFrameF32,
  curve: { L_anchors: number[]; scale: number[] }
): PixelFrameF32 {
  const { width, height, data } = frame;
  const n = Math.min(curve.L_anchors.length, curve.scale.length);
  if (n === 0) return frame;

  const out = allocPixelFrameF32(width, height);
  const outData = out.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3];

    const lab = linearRgbToOklab(r, g, b);
    const L = lab.L;
    let aLab = lab.a;
    let bLab = lab.b;

    const chromaScale = interpolateColorDensityCurve(L, curve);
    const scaleClamped = Number.isFinite(chromaScale)
      ? Math.max(0.2, Math.min(2.5, chromaScale))
      : 1;
    aLab *= scaleClamped;
    bLab *= scaleClamped;

    const rgb = oklabToLinearRgb(L, aLab, bLab);

    outData[i] = rgb.r;
    outData[i + 1] = rgb.g;
    outData[i + 2] = rgb.b;
    outData[i + 3] = Number.isFinite(a) ? a : 1;
  }

  return out;
}

const DEFAULT_COLOR_BAND_ANCHORS = [0.08, 0.25, 0.5, 0.7, 0.9];

function bandValue(id: number, values: ColorBandStrengths | undefined): number {
  if (!values) return 0;
  switch (id) {
    case 0:
      return values.lowerShadow;
    case 1:
      return values.upperShadow;
    case 2:
      return values.mid;
    case 3:
      return values.lowerHigh;
    default:
      return values.upperHigh;
  }
}

/**
 * Apply 5-band hue and temp overrides in OKLab.
 * Hue: rotate a,b by theta = hueControl * 30° (maxHueRad).
 * Temp: ob += tempControl * 0.18 (b-axis = blue-yellow).
 * Skip if all hue and temp are 0 (identity).
 */
export function applyBandHueTempFloat(
  frame: PixelFrameF32,
  overrides: { hue: ColorBandStrengths; temp?: ColorBandStrengths },
  colorBandAnchors?: number[]
): PixelFrameF32 {
  const anchors =
    colorBandAnchors && colorBandAnchors.length === 5
      ? colorBandAnchors
      : DEFAULT_COLOR_BAND_ANCHORS;
  const bandCount = anchors.length;
  const wBuf = new Float32Array(bandCount);

  // Check if identity (all zero)
  let hasHue = false;
  let hasTemp = false;
  for (let k = 0; k < bandCount; k++) {
    if (Math.abs(bandValue(k, overrides.hue)) > 1e-6) hasHue = true;
    if (overrides.temp && Math.abs(bandValue(k, overrides.temp)) > 1e-6) hasTemp = true;
  }
  if (!hasHue && !hasTemp) return frame;

  function bandWeights(L: number): Float32Array {
    for (let k = 0; k < bandCount; k++) {
      const center = anchors[k]!;
      const left = k === 0 ? 0 : anchors[k - 1]!;
      const right = k === bandCount - 1 ? 1 : anchors[k + 1]!;
      const wd = Math.max(1e-3, Math.max(center - left, right - center));
      const tL = 1 - Math.abs(L - center) / wd;
      wBuf[k] = tL > 0 ? tL : 0;
    }
    let sum = 0;
    for (let k = 0; k < bandCount; k++) sum += wBuf[k]!;
    if (sum > 1e-6) for (let k = 0; k < bandCount; k++) wBuf[k]! /= sum;
    return wBuf;
  }

  const { width, height, data } = frame;
  const out = allocPixelFrameF32(width, height);
  const outData = out.data;
  const maxHueRad = (Math.PI / 180) * 30;
  const maxTempShift = 0.18;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3];

    const lab = linearRgbToOklab(r, g, b);
    let L = lab.L;
    let oa = lab.a;
    let ob = lab.b;

    const w = bandWeights(L);
    let hueControl = 0;
    let tempControl = 0;
    for (let k = 0; k < bandCount; k++) {
      const wk = w[k] ?? 0;
      if (wk <= 0) continue;
      hueControl += wk * bandValue(k, overrides.hue);
      if (overrides.temp) tempControl += wk * bandValue(k, overrides.temp);
    }

    const theta = Math.max(-1, Math.min(1, hueControl)) * maxHueRad;
    if (Math.abs(theta) > 1e-4) {
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const aRot = oa * cosT - ob * sinT;
      const bRot = oa * sinT + ob * cosT;
      oa = aRot;
      ob = bRot;
    }

    if (Math.abs(tempControl) > 1e-4) {
      ob += Math.max(-1, Math.min(1, tempControl)) * maxTempShift;
    }

    const rgb = oklabToLinearRgb(L, oa, ob);

    outData[i] = rgb.r;
    outData[i + 1] = rgb.g;
    outData[i + 2] = rgb.b;
    outData[i + 3] = Number.isFinite(a) ? a : 1;
  }

  return out;
}

/** Simple separable 5-tap Gaussian blur on a luminance grid. */
function gaussianBlur5(
  src: Float32Array,
  width: number,
  height: number
): Float32Array {
  const n = width * height;
  const tmp = new Float32Array(n);
  const out = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const xm2 = Math.max(0, x - 2);
      const xm1 = Math.max(0, x - 1);
      const xp1 = Math.min(width - 1, x + 1);
      const xp2 = Math.min(width - 1, x + 2);
      const v =
        (src[rowOffset + xm2] ?? 0) * 1 +
        (src[rowOffset + xm1] ?? 0) * 4 +
        (src[rowOffset + x] ?? 0) * 6 +
        (src[rowOffset + xp1] ?? 0) * 4 +
        (src[rowOffset + xp2] ?? 0) * 1;
      tmp[rowOffset + x] = v / 16;
    }
  }
  for (let y = 0; y < height; y++) {
    const ym2 = Math.max(0, y - 2);
    const ym1 = Math.max(0, y - 1);
    const yp1 = Math.min(height - 1, y + 1);
    const yp2 = Math.min(height - 1, y + 2);
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const v =
        (tmp[ym2 * width + x] ?? 0) * 1 +
        (tmp[ym1 * width + x] ?? 0) * 4 +
        (tmp[y * width + x] ?? 0) * 6 +
        (tmp[yp1 * width + x] ?? 0) * 4 +
        (tmp[yp2 * width + x] ?? 0) * 1;
      out[idx] = v / 16;
    }
  }
  return out;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function percentileFromHistogram(
  hist: Uint32Array,
  total: number,
  p: number
): number {
  if (total <= 0) return 1;
  const target = Math.max(0, Math.min(total - 1, Math.floor(total * p)));
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i] ?? 0;
    if (acc > target) {
      return i / (hist.length - 1);
    }
  }
  return 1;
}

export function buildHighlightZoneMasksFromCurrentL(
  Lgrid: Float32Array,
  width: number,
  height: number
): { microMask: Float32Array; bleedMask: Float32Array } {
  const nPix = width * height;
  const microMask = new Float32Array(nPix);
  const bleedMask = new Float32Array(nPix);
  const bins = 1024;
  const hist = new Uint32Array(bins);
  for (let i = 0; i < nPix; i++) {
    const L = Math.max(0, Math.min(1, Lgrid[i] ?? 0));
    const bi = Math.max(0, Math.min(bins - 1, Math.floor(L * (bins - 1))));
    hist[bi] = (hist[bi] ?? 0) + 1;
  }
  // Tight top-end zone (~top 0.5-2%).
  const p98 = percentileFromHistogram(hist, nPix, 0.98);
  const p995 = percentileFromHistogram(hist, nPix, 0.995);
  const microStart = Math.max(0.8, Math.min(0.99, p98));
  const microEnd = Math.max(microStart + 1e-4, Math.min(1, p995));
  const bleedStart = Math.max(0.72, microStart - 0.06);
  const bleedEnd = Math.max(bleedStart + 1e-4, microEnd);
  for (let i = 0; i < nPix; i++) {
    const L = Math.max(0, Math.min(1, Lgrid[i] ?? 0));
    microMask[i] = smoothstep(microStart, microEnd, L);
    bleedMask[i] = smoothstep(bleedStart, bleedEnd, L);
  }
  const bleedBlur = gaussianBlur5(bleedMask, width, height);
  for (let i = 0; i < nPix; i++) {
    bleedMask[i] = Math.max(0, Math.min(1, bleedBlur[i] ?? 0));
  }
  return { microMask, bleedMask };
}

export function applyHighlightSmoothingFloat(
  frame: PixelFrameF32,
  highlightSmoothing?: number
): PixelFrameF32 {
  const smoothing = Math.max(0, Math.min(1, highlightSmoothing ?? 0));
  if (smoothing < 1e-4) return frame;

  const { width, height, data } = frame;
  const nPix = width * height;
  const Lgrid = new Float32Array(nPix);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    Lgrid[p] = linearRgbToOklab(r, g, b).L;
  }
  const { microMask, bleedMask } = buildHighlightZoneMasksFromCurrentL(
    Lgrid,
    width,
    height
  );
  const localBase = gaussianBlur5(Lgrid, width, height);
  const out = allocPixelFrameF32(width, height);
  const outData = out.data;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3];
    const lab = linearRgbToOklab(r, g, b);
    const micro = (microMask[p] ?? 0) * smoothing;
    const bleed = (bleedMask[p] ?? 0) * smoothing;
    const baseL = localBase[p] ?? lab.L;
    const dL = lab.L - baseL;
    const suppressedDL = dL * (1 - 0.7 * micro);
    const shoulder = 1 - Math.exp(-2.4 * Math.max(0, lab.L));
    let Lnew =
      baseL + suppressedDL * (1 - 0.35 * micro) + shoulder * (0.35 * micro);
    Lnew += bleed * (1 - Lnew) * 0.05;
    Lnew = Math.max(0, Math.min(1, Lnew));
    const aLab = lab.a;
    const bLab = lab.b;
    const rgb = oklabToLinearRgb(Lnew, aLab, bLab);
    outData[i] = rgb.r;
    outData[i + 1] = rgb.g;
    outData[i + 2] = rgb.b;
    outData[i + 3] = Number.isFinite(a) ? a : 1;
  }
  return out;
}

function gaussianBlurFilm(
  src: Float32Array,
  width: number,
  height: number
): Float32Array {
  const once = gaussianBlur5(src, width, height);
  return gaussianBlur5(once, width, height);
}

/** Multiple passes of gaussianBlur5 for larger effective radius (~2px per pass). */
function gaussianBlurNPasses(
  src: Float32Array,
  width: number,
  height: number,
  passes: number
): Float32Array {
  let cur = src;
  for (let i = 0; i < passes; i++) {
    cur = gaussianBlur5(cur, width, height);
  }
  return cur;
}

/**
 * Apply actuance (local contrast) on L in OKLab.
 *
 * This variant is "film-shadow focused":
 * - It boosts local micro-contrast mainly inside lower shadows using a smooth shadow-zone mask.
 * - It biases darker-side detail to be stronger than lighter-side detail (asymmetric polarity).
 * - It fades out before normal midtones by blending between the original L and the boosted target.
 *
 * The existing highlight guard is preserved via `weight`:
 * - Below `actuanceHighlightGuardFloor`, actuance is fully eligible.
 * - Above `actuanceHighlightGuard`, actuance is suppressed (and output moves toward the blurred base).
 */
export function applyActuanceFloat(
  frame: PixelFrameF32,
  actuanceStrength: number,
  actuanceRadius?: number,
  actuanceHighlightGuard?: number,
  actuanceHighlightGuardFloor?: number,
  actuanceHighlightMinSize?: number
): PixelFrameF32 {
  const actuanceS = Math.max(0, Math.min(3, actuanceStrength ?? 0));
  if (actuanceS < 1e-3) return frame;

  const threshold = Math.max(0.5, Math.min(0.9, actuanceHighlightGuard ?? 0.65));
  const floor = Math.min(
    Math.max(0.2, Math.min(0.75, actuanceHighlightGuardFloor ?? 0.5)),
    threshold - 0.05
  );

  const { width, height, data } = frame;
  const nPix = width * height;
  const Lgrid = new Float32Array(nPix);

  for (let i = 0, idx = 0; i < data.length; i += 4, idx++) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const lab = linearRgbToOklab(r, g, b);
    Lgrid[idx] = lab.L;
  }

  const radius = Math.max(0.5, Math.min(5, actuanceRadius ?? 2));
  const radiusPasses = Math.max(1, Math.round(radius));
  const blurred = gaussianBlurNPasses(Lgrid, width, height, radiusPasses);
  const ACTUANCE_AMP = 1.8;

  const shortestEdge = Math.min(width, height);
  const regionalRadius = Math.max(3, Math.floor(shortestEdge * (actuanceHighlightMinSize ?? 0.005)));
  const passes = Math.max(2, Math.ceil(regionalRadius / 2));
  const regionalBlurredL = gaussianBlurNPasses(Lgrid, width, height, passes);

  const out = allocPixelFrameF32(width, height);
  const outData = out.data;

  // Shadow-zone parameters derived from the existing highlight guard controls,
  // so actuance tuning remains consistent without adding new UI knobs.
  //
  // Typical default (guardFloor ~0.35): center ~0.14, sigma ~0.12
  // which peaks in lower shadows and fades before midtones.
  const shadowCenter = Math.max(0.05, Math.min(0.22, floor * 0.4));
  const shadowSigma = Math.max(0.06, Math.min(0.12, floor * 0.33));
  const twoSigma2 = 2 * shadowSigma * shadowSigma;

  // Fine-to-medium detail mix (two different blur bases are already computed above).
  const detailFineWeight = 0.75;
  const detailMedWeight = 1 - detailFineWeight;

  // Asymmetric polarity gain: dark-side detail stronger than light-side detail.
  // These are intentionally conservative to avoid "clarity glow".
  const darkGain = 1.55;
  const lightGain = 0.85;

  // Optional deterministic "film irregularity" (low-frequency).
  // Kept intentionally small; only applied in the shadowMask zone.
  const stochasticAmount = 0.18; // relative multiplier (1.0 +- ~0.18)

  for (let i = 0, idx = 0; i < data.length; i += 4, idx++) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3];
    const lab = linearRgbToOklab(r, g, b);
    const L = Lgrid[idx]!;
    const baseFine = blurred[idx] ?? lab.L;
    const maxL = Math.max(L, baseFine);
    const baseMed = regionalBlurredL[idx] ?? L;
    let weight: number;

    // Preserve existing guard logic (which uses both pixel L and regional blur).
    if (baseMed <= floor) weight = 1;
    else if (maxL <= floor) weight = 1;
    else if (maxL >= threshold) weight = 0;
    else weight = (threshold - maxL) / (threshold - floor);

    const dFine = L - baseFine;
    const dMed = L - baseMed;
    const d = detailFineWeight * dFine + detailMedWeight * dMed;

    const polarityGain = d < 0 ? darkGain : lightGain;

    // Smooth bell-shaped shadow mask: peaks in deep shadows, fades out before midtones.
    const deltaC = L - shadowCenter;
    const shadowMask = Math.exp(-(deltaC * deltaC) / twoSigma2);

    // Blend factor:
    // - When weight is near 1, actuance is allowed, but only in the shadowMask zone.
    // - When weight is near 0 (highlight suppression), we still move toward the blurred base.
    const blend = (1 - weight) + weight * shadowMask;

    // Deterministic low-frequency irregularity. Only apply when we are actually in the
    // shadow-mask zone (keeps export stable and avoids extra work everywhere).
    let stochastic = 1;
    if (stochasticAmount > 1e-6 && shadowMask > 0.05 && actuanceS > 0.5) {
      const x = idx % width;
      const y = ((idx / width) | 0) as number;
      const f1 = 0.015;
      const f2 = 0.017;
      const n =
        0.5 * Math.sin((x * f1) + (y * f2)) +
        0.5 * Math.sin((x * f2) - (y * f1));
      stochastic = 1 + n * stochasticAmount;
    }

    const Ltarget = baseFine + weight * actuanceS * ACTUANCE_AMP * d * polarityGain * stochastic;
    const Lnew = Math.max(0, Math.min(1, L + blend * (Ltarget - L)));

    const rgb = oklabToLinearRgb(Lnew, lab.a, lab.b);
    outData[i] = rgb.r;
    outData[i + 1] = rgb.g;
    outData[i + 2] = rgb.b;
    outData[i + 3] = Number.isFinite(a) ? a : 1;
  }

  return out;
}
