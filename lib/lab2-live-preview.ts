/**
 * Lab2: linear-float live preview chain after Model 2 match.
 * Canvas scaling is display-only; all ops run on full-resolution Float32Array RGB.
 */

import type { PixelFrameF32 } from "@/src/lib/pipeline/types";
import type { PipelineParams } from "@/src/lib/pipeline/types";
import type { LookParams as GradingParams } from "@/src/lib/pipeline/stages/match";
import { matchFloat } from "@/src/lib/pipeline/match";
import { linearRgbToOklab, oklabToLinearRgb } from "@/src/lib/pipeline/stages/oklab";

export function clonePixelFrameF32(frame: PixelFrameF32): PixelFrameF32 {
  return {
    width: frame.width,
    height: frame.height,
    data: new Float32Array(frame.data),
  };
}

/** Output of Model 2 only (linear float, full res). */
export function buildPostModel2BaseFrame(
  source: PixelFrameF32,
  reference: PixelFrameF32 | null,
  params: PipelineParams
): PixelFrameF32 {
  return matchFloat(source, reference, params);
}

export interface Lab2LiveWorkState {
  width: number;
  height: number;
  workA: Float32Array;
  workB: Float32Array;
  halationMaskA: Float32Array;
  halationMaskB: Float32Array;
}

export interface Lab2LivePreviewOptions {
  halationPreview?: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function piecewiseLinear(L: number, L_in: number[], L_out: number[]): number {
  const n = Math.min(L_in.length, L_out.length);
  if (n === 0) return 1;
  if (L <= (L_in[0] ?? 0)) return L_out[0] ?? 1;
  if (L >= (L_in[n - 1] ?? 1)) return L_out[n - 1] ?? 1;
  for (let i = 0; i < n - 1; i++) {
    const x0 = L_in[i] ?? 0;
    const x1 = L_in[i + 1] ?? 1;
    if (L >= x0 && L <= x1) {
      const t = (L - x0) / Math.max(1e-6, x1 - x0);
      const y0 = L_out[i] ?? 1;
      const y1 = L_out[i + 1] ?? 1;
      return y0 + (y1 - y0) * t;
    }
  }
  return L_out[n - 1] ?? 1;
}

function interpolateDensity(
  L: number,
  curve: { L_anchors: number[]; scale: number[] } | undefined
): number {
  if (!curve) return 1;
  const n = Math.min(curve.L_anchors.length, curve.scale.length);
  if (n === 0) return 1;
  if (L <= (curve.L_anchors[0] ?? 0)) return curve.scale[0] ?? 1;
  if (L >= (curve.L_anchors[n - 1] ?? 1)) return curve.scale[n - 1] ?? 1;
  for (let i = 0; i < n - 1; i++) {
    const x0 = curve.L_anchors[i] ?? 0;
    const x1 = curve.L_anchors[i + 1] ?? 1;
    if (L >= x0 && L <= x1) {
      const t = (L - x0) / Math.max(1e-6, x1 - x0);
      const y0 = curve.scale[i] ?? 1;
      const y1 = curve.scale[i + 1] ?? 1;
      return y0 + (y1 - y0) * t;
    }
  }
  return curve.scale[n - 1] ?? 1;
}

function refractionSatScale12(a: number, b: number, saturations: readonly number[]): number {
  const C = Math.sqrt(a * a + b * b);
  if (C < 1e-7 || saturations.length !== 12) return 1;
  const hueRad = Math.atan2(b, a);
  const hueDeg = ((hueRad + Math.PI) / (2 * Math.PI)) * 360;
  const hueDegForSeg = (hueDeg + 180) % 360;
  const seg = hueDegForSeg / 30;
  const i0 = Math.floor(seg) % 12;
  const i1 = (i0 + 1) % 12;
  const t = seg - Math.floor(seg);
  const s0 = saturations[i0] ?? 1;
  const s1 = saturations[i1] ?? 1;
  return clamp(s0 * (1 - t) + s1 * t, 0, 3);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function applyDevignetteInPlace(
  data: Float32Array,
  width: number,
  height: number,
  params: GradingParams["devignette"]
) {
  if (!params) return;
  const strength = clamp(params.strengthStops ?? 0, 0, 3);
  if (strength <= 1e-6) return;
  const innerD = clamp(params.innerDiameterNorm ?? 0.65, 0, 1);
  const innerRadiusPx = (innerD * Math.min(width, height)) / 2;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const cornerDist = Math.sqrt(cx * cx + cy * cy) || 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let weight = 0;
      if (dist > innerRadiusPx) {
        weight = smoothstep(innerRadiusPx, cornerDist, dist);
        weight *= weight;
      }
      const mult = 2 ** (strength * weight);
      data[i] = (data[i] ?? 0) * mult;
      data[i + 1] = (data[i + 1] ?? 0) * mult;
      data[i + 2] = (data[i + 2] ?? 0) * mult;
    }
  }
}

function hasNonIdentityRefraction12(sats: readonly number[] | undefined): boolean {
  if (!sats || sats.length !== 12) return false;
  for (let i = 0; i < 12; i++) {
    if (Math.abs((sats[i] ?? 1) - 1) > 1e-4) return true;
  }
  return false;
}

export function createLab2LiveWorkState(width: number, height: number): Lab2LiveWorkState {
  const n = width * height * 4;
  return {
    width,
    height,
    workA: new Float32Array(n),
    workB: new Float32Array(n),
    halationMaskA: new Float32Array(width * height),
    halationMaskB: new Float32Array(width * height),
  };
}

export function ensureLab2LiveWorkState(
  state: Lab2LiveWorkState | null | undefined,
  width: number,
  height: number
): Lab2LiveWorkState {
  if (!state || state.width !== width || state.height !== height) {
    return createLab2LiveWorkState(width, height);
  }
  return state;
}

/**
 * Fused post-Model2 live pass (single OKLab round-trip per pixel).
 * Writes into reusable buffer and returns frame backed by that buffer.
 */
export function applyLivePostModel2OnlyWithState(
  postM2Base: PixelFrameF32,
  grading: GradingParams,
  state: Lab2LiveWorkState,
  options?: Lab2LivePreviewOptions
): PixelFrameF32 {
  const width = postM2Base.width;
  const height = postM2Base.height;
  if (state.width !== width || state.height !== height) {
    throw new Error("Lab2LiveWorkState dimensions do not match base frame");
  }
  const src = postM2Base.data;
  const out = state.workA;
  out.set(src);

  const expCurve = grading.exposureCurve;
  const denCurve = grading.colorDensityCurve;
  const ref12 = grading.refractionPostModel2;
  const applyRef12 = hasNonIdentityRefraction12(ref12);
  const hasExp = !!(expCurve?.L_in?.length && expCurve?.L_out?.length);
  const hasDen = !!(denCurve?.L_anchors?.length && denCurve?.scale?.length);
  const doOklab = hasExp || hasDen || applyRef12;

  if (doOklab) {
    for (let i = 0; i < out.length; i += 4) {
      const r = out[i] ?? 0;
      const g = out[i + 1] ?? 0;
      const b = out[i + 2] ?? 0;
      const a = out[i + 3];

      const lab = linearRgbToOklab(r, g, b);
      let L = lab.L;
      let aLab = lab.a;
      let bLab = lab.b;

      if (hasExp && expCurve) {
        const expMul = clamp(piecewiseLinear(L, expCurve.L_in, expCurve.L_out), 0, 2);
        L = clamp(L * expMul, 0, 1.5);
      }
      if (hasDen && denCurve) {
        const denMul = clamp(interpolateDensity(L, denCurve), 0.2, 2.5);
        aLab *= denMul;
        bLab *= denMul;
      }
      if (applyRef12 && ref12) {
        const satMul = refractionSatScale12(aLab, bLab, ref12);
        aLab *= satMul;
        bLab *= satMul;
      }

      const rgb = oklabToLinearRgb(L, aLab, bLab);
      out[i] = rgb.r;
      out[i + 1] = rgb.g;
      out[i + 2] = rgb.b;
      out[i + 3] = Number.isFinite(a) ? a : 1;
    }
  }

  applyDevignetteInPlace(out, width, height, grading.devignette);
  if (options?.halationPreview) {
    applyApproxHalationPreviewInPlace(out, width, height, grading, state);
  }
  return { width, height, data: out };
}

/**
 * Live sliders: exposure → colour density → 12-node refraction → de-vignette.
 * Backward-compatible API for existing call sites.
 */
export function applyLivePostModel2Only(
  postM2Base: PixelFrameF32,
  grading: GradingParams,
  options?: Lab2LivePreviewOptions
): PixelFrameF32 {
  const state = createLab2LiveWorkState(postM2Base.width, postM2Base.height);
  return applyLivePostModel2OnlyWithState(postM2Base, grading, state, options);
}

function boxBlur3x3(src: Float32Array, dst: Float32Array, width: number, height: number) {
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - 1);
    const y2 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - 1);
      const x2 = Math.min(width - 1, x + 1);
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy <= y2; yy++) {
        for (let xx = x0; xx <= x2; xx++) {
          sum += src[yy * width + xx] ?? 0;
          count++;
        }
      }
      dst[y * width + x] = sum / Math.max(1, count);
    }
  }
}

/**
 * Preview-only approximation. This is intentionally non-canonical and must never
 * be used for export/apply/training outputs.
 */
function applyApproxHalationPreviewInPlace(
  data: Float32Array,
  width: number,
  height: number,
  grading: GradingParams,
  state: Lab2LiveWorkState
) {
  const threshold = clamp(grading.halationThreshold ?? 0.92, 0.8, 0.999);
  const strength = clamp(
    ((grading.halationRimStrength ?? 0.6) + (grading.halationBloomStrength ?? 0.8)) * 0.35,
    0,
    1.2
  );
  if (strength <= 1e-4) return;

  const n = width * height;
  const mask = state.halationMaskA;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const luma = 0.2627 * r + 0.678 * g + 0.0593 * b;
    mask[p] = Math.max(0, (luma - threshold) / Math.max(1e-5, 1 - threshold));
  }

  const blurA = state.halationMaskA;
  const blurB = state.halationMaskB;
  const passes = Math.max(2, Math.round((grading.halationBloomRadius ?? 1) * 2));
  for (let i = 0; i < passes; i++) {
    boxBlur3x3(blurA, blurB, width, height);
    blurA.set(blurB);
  }

  const warmth = clamp(grading.highlightFillWarmth ?? 0, -1, 1);
  const warmR = 1 + 0.2 * Math.max(0, warmth);
  const warmG = 1 + 0.07 * Math.max(0, warmth);
  const warmB = 1 - 0.1 * Math.max(0, warmth);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const glow = strength * (blurA[p] ?? 0);
    data[i] = (data[i] ?? 0) + glow * 0.28 * warmR;
    data[i + 1] = (data[i + 1] ?? 0) + glow * 0.16 * warmG;
    data[i + 2] = (data[i + 2] ?? 0) + glow * 0.08 * warmB;
  }
}
