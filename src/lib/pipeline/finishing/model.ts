/**
 * Shared model for the finishing stages (Highlight Warmth + Halation).
 *
 * Single source of truth for the CPU export stages and the WebGL2 preview
 * shaders: every constant and helper here is either used directly by the CPU
 * code or injected into GLSL (see lib/lab2/gpu-finish/shaders.ts). All spatial
 * quantities are fractions of the image short edge so the look is identical at
 * any resolution.
 */

import { linearRgbToOklab } from "../stages/oklab";
import type { LookParams as GradingParams } from "../stages/match";

export type HighlightWarmthParams = NonNullable<GradingParams["highlightWarmth"]>;
export type HalationParams = NonNullable<GradingParams["halation"]>;

/** Finishing params carried by the preview / export paths. */
export type FinishParams = {
  highlightWarmth?: HighlightWarmthParams;
  halation?: HalationParams;
};

// ---------------------------------------------------------------------------
// Highlight Warmth
// ---------------------------------------------------------------------------

/** Max OKLab chroma shift at amount = 1. */
export const WARMTH_MAX_CHROMA = 0.05;
/** Amount response curve exponent (finer control near the wheel centre). */
export const WARMTH_AMOUNT_EXPONENT = 1.5;
export const WARMTH_THRESHOLD_MIN = 0.01;
export const WARMTH_THRESHOLD_MAX = 0.5;

export type WarmthUniforms = {
  /** OKLab a/b shift at full weight. */
  da: number;
  db: number;
  /** smoothstep(lo, hi, L) defines the affected tonal region. */
  lo: number;
  hi: number;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hsvToLinearRgb(hDeg: number): [number, number, number] {
  const h = (((hDeg % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 1) [r, g, b] = [1, x, 0];
  else if (h < 2) [r, g, b] = [x, 1, 0];
  else if (h < 3) [r, g, b] = [0, 1, x];
  else if (h < 4) [r, g, b] = [0, x, 1];
  else if (h < 5) [r, g, b] = [x, 0, 1];
  else [r, g, b] = [1, 0, x];
  const toLin = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return [toLin(r), toLin(g), toLin(b)];
}

/**
 * Unit OKLab (a, b) direction of the wheel hue. The wheel uses the HSV hue of
 * the displayed sRGB colour, so the applied tint matches the colour the user
 * sees under the handle.
 */
export function wheelHueToOklabDirection(hueDeg: number): { a: number; b: number } {
  const [r, g, b] = hsvToLinearRgb(hueDeg);
  const lab = linearRgbToOklab(r, g, b);
  const len = Math.hypot(lab.a, lab.b) || 1;
  return { a: lab.a / len, b: lab.b / len };
}

/** Returns null when the stage is a no-op. */
export function computeWarmthUniforms(
  p: HighlightWarmthParams | undefined | null
): WarmthUniforms | null {
  if (!p) return null;
  const amount = clamp(p.amount ?? 0, 0, 1);
  if (amount <= 1e-4) return null;
  const T = clamp(p.threshold ?? 0.25, WARMTH_THRESHOLD_MIN, WARMTH_THRESHOLD_MAX);
  const k = WARMTH_MAX_CHROMA * Math.pow(amount, WARMTH_AMOUNT_EXPONENT);
  const dir = wheelHueToOklabDirection(p.hue ?? 35);
  return {
    da: dir.a * k,
    db: dir.b * k,
    lo: 1 - 1.5 * T,
    hi: 1 - 0.5 * T,
  };
}

export function smoothstep(lo: number, hi: number, x: number): number {
  const t = clamp((x - lo) / Math.max(1e-9, hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Halation
//
// Film-inspired model operating on the graded scene-linear frame (values may
// exceed 1.0; the only display transform afterwards is clip + sRGB encode):
//
//   1. Activation in photographic stops above middle grey (no hard threshold).
//   2. Spectrally weighted, softly saturating source.
//   3. Scatter through a 3-lobe PSF whose per-layer weights sum to 1.
//   4. Conservative suppression inside the emitting region.
//   5. Self-limiting exposure: HMAX·(1 − exp(−x / HMAX)).
//   6. Extra exposure per film layer: red dominant, minority green, minimal blue.
//   7. Differential film shoulder: out = E + F(E + h) − F(E). Added light shows
//      in dark neighbours and barely moves dense highlights; h = 0 is identity.
// ---------------------------------------------------------------------------

/** Display middle grey in the graded linear frame (the EV reference). */
export const HALATION_REF_GREY = 0.18;
/** Activation start in stops above grey, at sensitivity 0 and 1. */
export const HALATION_START_EV = [1.75, 0.25] as const;
/** Stops from activation start to full activation. */
export const HALATION_EV_SPAN = 2.25;
/** Spectral weights of the halation source (linear RGB). */
export const HALATION_SPECTRAL = { r: 0.58, g: 0.36, b: 0.06 } as const;
/** Soft saturation ceiling of the spectral source. */
export const HALATION_SOURCE_MAX = 4;
/** Base Gaussian sigmas (fraction of short edge) of the 3-lobe scatter PSF. */
export const HALATION_SIGMAS = [0.0015, 0.006, 0.018] as const;
/** Sigma multiplier at radius 0 and 1. */
export const HALATION_RADIUS_SCALE = [0.5, 1.8] as const;
/** Per-layer lobe weights (each sums to 1). Red spreads widest. */
export const HALATION_LAYER_LOBES = {
  r: [0.55, 0.32, 0.13],
  g: [0.7, 0.25, 0.05],
  b: [0.85, 0.15, 0.0],
} as const;
/** Fraction of the halo suppressed where the pixel itself fully emits. */
export const HALATION_SOURCE_SUPPRESSION = 0.6;
/** Ceiling of the self-limited halo exposure (linear). */
export const HALATION_LIMIT = 0.16;
/** Exposure gain per film layer; green spans warmth 0 → 1. */
export const HALATION_LAYER_GAIN = { r: 1.0, gMin: 0.18, gMax: 0.42, b: 0.04 } as const;
/** Exposure multiplier at amount = 1. */
export const HALATION_AMOUNT_SCALE = 1.33;
/** White point of the film shoulder F(E) = W·(1 − exp(−E / W)). */
export const HALATION_SHOULDER_WHITE = 1.0;

export type HalationUniforms = {
  amount: number;
  /** Activation: smoothstep over t = (EV − startEV) · invSpanEV. */
  startEV: number;
  invSpanEV: number;
  /** Linear luminance where activation starts (H = 0 at or below it). */
  startY: number;
  /** Lobe sigmas as a fraction of the short edge. */
  sigmas: [number, number, number];
  /** amount · per-layer exposure gain. */
  gain: [number, number, number];
};

export function computeHalationUniforms(
  p: HalationParams | undefined | null
): HalationUniforms | null {
  if (!p) return null;
  const amount = clamp(p.amount ?? 0, 0, 1);
  if (amount <= 1e-4) return null;
  const sensitivity = clamp(p.sensitivity ?? 0.5, 0, 1);
  const radius = clamp(p.radius ?? 0.5, 0, 1);
  const warmth = clamp(p.warmth ?? 0.5, 0, 1);
  const rs = lerp(HALATION_RADIUS_SCALE[0], HALATION_RADIUS_SCALE[1], radius);
  const startEV = lerp(HALATION_START_EV[0], HALATION_START_EV[1], sensitivity);
  const a = amount * HALATION_AMOUNT_SCALE;
  return {
    amount,
    startEV,
    invSpanEV: 1 / HALATION_EV_SPAN,
    startY: HALATION_REF_GREY * 2 ** startEV,
    sigmas: [HALATION_SIGMAS[0] * rs, HALATION_SIGMAS[1] * rs, HALATION_SIGMAS[2] * rs],
    gain: [
      a * HALATION_LAYER_GAIN.r,
      a * lerp(HALATION_LAYER_GAIN.gMin, HALATION_LAYER_GAIN.gMax, warmth),
      a * HALATION_LAYER_GAIN.b,
    ],
  };
}

/** Rec.709 luminance of linear RGB. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Exposure activation H ∈ [0, 1] of a pixel with linear luminance Y. */
export function halationActivation(Y: number, u: HalationUniforms): number {
  if (Y <= u.startY) return 0;
  const ev = Math.log2(Math.max(Y, 1e-6) / HALATION_REF_GREY);
  const t = clamp((ev - u.startEV) * u.invSpanEV, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Halation source emitted by a pixel (activation × soft-saturated spectral exposure). */
export function halationSource(r: number, g: number, b: number, u: HalationUniforms): number {
  const H = halationActivation(luminance(r, g, b), u);
  if (H <= 0) return 0;
  const S = Math.max(
    0,
    HALATION_SPECTRAL.r * r + HALATION_SPECTRAL.g * g + HALATION_SPECTRAL.b * b
  );
  return H * HALATION_SOURCE_MAX * (1 - Math.exp(-S / HALATION_SOURCE_MAX));
}

/** True when either finishing stage would modify pixels. */
export function hasActiveFinishing(p: FinishParams | null | undefined): boolean {
  return !!(computeWarmthUniforms(p?.highlightWarmth) || computeHalationUniforms(p?.halation));
}
