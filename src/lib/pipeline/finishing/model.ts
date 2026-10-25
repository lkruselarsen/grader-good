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
// ---------------------------------------------------------------------------

/** Base Gaussian sigmas (fraction of short edge) of the 3-lobe scatter PSF. */
export const HALATION_SIGMAS = [0.0015, 0.006, 0.018] as const;
/** Per-channel weights of the 3 lobes. Red spreads widest, green stays close. */
export const HALATION_LOBE_WEIGHTS = {
  r: [0.45, 0.33, 0.22],
  g: [0.62, 0.28, 0.1],
  b: [0.8, 0.2, 0.0],
} as const;
/** Channel tint (linear RGB). Orange near the source, redder in the tail. */
export const HALATION_TINT = { r: 1.0, g: 0.47, b: 0.13 } as const;
/** Max added light at strength = 1 (≈14% effect). */
export const HALATION_MAX_OPACITY = 0.14;
/** Gain applied to the scattered energy before the soft clip. */
export const HALATION_ENERGY_GAIN = 2.2;
/** Fill (inside highlights) relative to edge (shadow side of boundaries). */
export const HALATION_FILL_RATIO = 0.3;
/** Low-frequency noise: two octaves, cycles per short edge. */
export const HALATION_NOISE_FREQ = [5.0, 11.0] as const;
export const HALATION_NOISE_OCTAVE_WEIGHTS = [0.65, 0.35] as const;
/** ±amplitude modulation and ±green (warmth) modulation from the noise. */
export const HALATION_NOISE_AMP = 0.2;
export const HALATION_NOISE_WARMTH = 0.08;
export const HALATION_NOISE_SEED = 0x5f3759df;
/** Headroom cap for highlight energy. */
export const HALATION_ENERGY_CAP = 4;

export type HalationUniforms = {
  strength: number;
  /** Highlight zone: knee = smoothstep(kneeLo, kneeHi, cbrt(Y)). */
  kneeLo: number;
  kneeHi: number;
  /** Lobe sigmas as a fraction of the short edge. */
  sigmas: [number, number, number];
  edgeGain: number;
  fillGain: number;
};

export function computeHalationUniforms(
  p: HalationParams | undefined | null
): HalationUniforms | null {
  if (!p) return null;
  const strength = clamp(p.strength ?? 0, 0, 1);
  if (strength <= 1e-4) return null;
  const edge = clamp(p.edge ?? 0.5, 0, 1);
  const zone = 0.06 + (0.2 - 0.06) * edge;
  const L0 = 1 - zone;
  const radiusScale = 0.6 + (1.6 - 0.6) * edge;
  const edgeGain = 0.7 + 0.3 * edge;
  return {
    strength,
    kneeLo: L0 - 0.25 * zone,
    kneeHi: L0 + 0.5 * zone,
    sigmas: [
      HALATION_SIGMAS[0] * radiusScale,
      HALATION_SIGMAS[1] * radiusScale,
      HALATION_SIGMAS[2] * radiusScale,
    ],
    edgeGain,
    fillGain: edgeGain * HALATION_FILL_RATIO,
  };
}

/** Rec.709 luminance of linear RGB. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Highlight energy emitted by a pixel (linear light, gated to the highlight zone). */
export function halationEnergy(
  r: number,
  g: number,
  b: number,
  u: HalationUniforms
): number {
  const Y = Math.max(0, luminance(r, g, b));
  if (Y <= 0) return 0;
  const knee = smoothstep(u.kneeLo, u.kneeHi, Math.cbrt(Y));
  return knee * Math.min(Y, HALATION_ENERGY_CAP);
}

/**
 * 32-bit integer lattice hash → [0, 1). Uses only multiply/xor/shift so the
 * GLSL ES 3.0 `uint` version produces identical values.
 */
export function hash2(ix: number, iy: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ HALATION_NOISE_SEED;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Two-octave value noise in [0, 1] at normalised coords (u, v) = pixel / shortEdge. */
export function halationNoise(u: number, v: number): number {
  return (
    HALATION_NOISE_OCTAVE_WEIGHTS[0] *
      valueNoise(u * HALATION_NOISE_FREQ[0], v * HALATION_NOISE_FREQ[0]) +
    HALATION_NOISE_OCTAVE_WEIGHTS[1] *
      valueNoise(u * HALATION_NOISE_FREQ[1] + 17.3, v * HALATION_NOISE_FREQ[1] + 9.1)
  );
}

/** True when either finishing stage would modify pixels. */
export function hasActiveFinishing(p: FinishParams | null | undefined): boolean {
  return !!(computeWarmthUniforms(p?.highlightWarmth) || computeHalationUniforms(p?.halation));
}
