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
//
// Film-style highlight rolloff in OKLab (lightness untouched):
//
//   1. Desaturation ramp: the scene's own chroma fades out first. Hues that
//      oppose the tint (blue sky vs a warm tint) fade completely; hues already
//      aligned with it keep most of their colour.
//   2. Tint ramp (lags the desaturation): the wheel colour fades in on top of
//      the nearly neutral result, so blue → pale blue → grey-white → warm white
//      and the tint never mixes with an opposing colour (no purple).
//   3. Gamut: chroma is shrunk (never channel-clamped) when a channel would go
//      negative, so there is no hue jump at the gamut edge.
//
// Both ramps are centred on the pivot c = 1 − threshold ("Top X%") with a
// half-width set by softness.
// ---------------------------------------------------------------------------

/** Max OKLab chroma shift at amount = 1. */
export const WARMTH_MAX_CHROMA = 0.05;
/** Amount response curve exponent (finer control near the wheel centre). */
export const WARMTH_AMOUNT_EXPONENT = 1.5;
export const WARMTH_THRESHOLD_MIN = 0.01;
export const WARMTH_THRESHOLD_MAX = 0.5;
export const WARMTH_SOFTNESS_DEFAULT = 0.5;
/** Rolloff half-width as a multiple of the threshold, at softness 0 and 1. */
export const WARMTH_SPAN_SCALE = [0.25, 1.0] as const;
/** Threshold floor used for the half-width so small thresholds still fade smoothly. */
export const WARMTH_MIN_SPAN = 0.1;
/** Desaturation completes, and the tint starts, this fraction of the half-width from the pivot. */
export const WARMTH_RAMP_OVERLAP = 0.2;
/** Amount at which highlight desaturation reaches full strength. */
export const WARMTH_DESAT_FULL_AT = 0.5;
/** Desaturation kept for hues aligned with the tint (opposite hues get 1). */
export const WARMTH_ALIGNED_DESAT = 0.35;
/** Bisection steps when shrinking chroma back into gamut. */
export const WARMTH_GAMUT_STEPS = 4;

export type WarmthUniforms = {
  /** Unit OKLab (a, b) direction of the tint. */
  dirA: number;
  dirB: number;
  /** Tint chroma at full weight. */
  k: number;
  /** Desaturation strength at full weight (0..1). */
  desat: number;
  /** smoothstep(desatLo, desatHi, L): highlight desaturation weight. */
  desatLo: number;
  desatHi: number;
  /** smoothstep(tintLo, tintHi, L): tint weight. */
  tintLo: number;
  tintHi: number;
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
  const softness = clamp(p.softness ?? WARMTH_SOFTNESS_DEFAULT, 0, 1);
  const k = WARMTH_MAX_CHROMA * Math.pow(amount, WARMTH_AMOUNT_EXPONENT);
  const dir = wheelHueToOklabDirection(p.hue ?? 35);
  const c = 1 - T;
  const h = lerp(WARMTH_SPAN_SCALE[0], WARMTH_SPAN_SCALE[1], softness) * Math.max(T, WARMTH_MIN_SPAN);
  return {
    dirA: dir.a,
    dirB: dir.b,
    k,
    desat: smoothstep(0, WARMTH_DESAT_FULL_AT, amount),
    desatLo: Math.max(0, c - h),
    desatHi: c + WARMTH_RAMP_OVERLAP * h,
    tintLo: c - WARMTH_RAMP_OVERLAP * h,
    tintHi: c + h,
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
//      Warmth sets the layer balance: 0 = equal gains and shared lobes (a white
//      halo, no coloured edge), 0.5 = the film default, 1 = deep red.
//   7. Rolloff before the halo lands: the pixel's own colour fades toward its
//      luminance when it opposes the halo hue (blue sky under a red halo), so
//      it passes through neutral instead of mixing into purple. The fade
//      completes while the halo's chroma is still small next to the pixel's;
//      hues aligned with the halo keep their colour.
//   8. Differential film shoulder: out = E + F(E + h) − F(E). Added light shows
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
/** Film per-layer lobe weights (each sums to 1). Red spreads widest. */
export const HALATION_LAYER_LOBES = {
  r: [0.55, 0.32, 0.13],
  g: [0.7, 0.25, 0.05],
  b: [0.85, 0.15, 0.0],
} as const;
/** Lobe weights every layer shares at warmth 0, so the halo edge carries no colour. */
export const HALATION_NEUTRAL_LOBES = HALATION_LAYER_LOBES.g;
/** Fraction of the halo suppressed where the pixel itself fully emits. */
export const HALATION_SOURCE_SUPPRESSION = 0.6;
/** Ceiling of the self-limited halo exposure (linear). */
export const HALATION_LIMIT = 0.16;
/**
 * Exposure gain per film layer at warmth 0.5 (the default film halo). Below
 * 0.5 gains and lobes blend toward a neutral halo of equal luminance; above
 * it green drops toward HALATION_DEEP_RED_G.
 */
export const HALATION_LAYER_GAIN = { r: 1.0, g: 0.3, b: 0.04 } as const;
/** Green layer gain at warmth 1. */
export const HALATION_DEEP_RED_G = 0.18;
/** Equal per-layer gain at warmth 0: the Rec.709 luminance of the film gains. */
export const HALATION_NEUTRAL_GAIN =
  0.2126 * HALATION_LAYER_GAIN.r + 0.7152 * HALATION_LAYER_GAIN.g + 0.0722 * HALATION_LAYER_GAIN.b;
/** Exposure multiplier at amount = 1. */
export const HALATION_AMOUNT_SCALE = 1.33;
/** White point of the film shoulder F(E) = W·(1 − exp(−E / W)). */
export const HALATION_SHOULDER_WHITE = 1.0;
/**
 * Halo chroma / pixel chroma ratio at which an opposing colour has fully
 * faded (chroma = linear RGB offset from luminance).
 */
export const HALATION_DESAT_FULL_RATIO = 0.25;
/** Fade kept for hues aligned with the halo; hues 90° or more away get 1. */
export const HALATION_ALIGNED_DESAT = 0;

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
  /** Per-layer lobe weights (each sums to 1). */
  lobes: {
    r: [number, number, number];
    g: [number, number, number];
    b: [number, number, number];
  };
};

type Vec3 = [number, number, number];

function lerp3(a: readonly number[], b: readonly number[], t: number): Vec3 {
  return [lerp(a[0]!, b[0]!, t), lerp(a[1]!, b[1]!, t), lerp(a[2]!, b[2]!, t)];
}

/** Per-layer gain (before amount) and lobes for a warmth in [0, 1]. */
function halationLayers(warmth: number): { gain: Vec3; lobes: HalationUniforms["lobes"] } {
  const film: Vec3 = [HALATION_LAYER_GAIN.r, HALATION_LAYER_GAIN.g, HALATION_LAYER_GAIN.b];
  if (warmth >= 0.5) {
    const t = (warmth - 0.5) * 2;
    return {
      gain: [film[0], lerp(film[1], HALATION_DEEP_RED_G, t), film[2]],
      lobes: {
        r: [...HALATION_LAYER_LOBES.r],
        g: [...HALATION_LAYER_LOBES.g],
        b: [...HALATION_LAYER_LOBES.b],
      },
    };
  }
  const t = warmth * 2;
  const N = HALATION_NEUTRAL_GAIN;
  return {
    gain: lerp3([N, N, N], film, t),
    lobes: {
      r: lerp3(HALATION_NEUTRAL_LOBES, HALATION_LAYER_LOBES.r, t),
      g: lerp3(HALATION_NEUTRAL_LOBES, HALATION_LAYER_LOBES.g, t),
      b: lerp3(HALATION_NEUTRAL_LOBES, HALATION_LAYER_LOBES.b, t),
    },
  };
}

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
  const layers = halationLayers(warmth);
  return {
    amount,
    startEV,
    invSpanEV: 1 / HALATION_EV_SPAN,
    startY: HALATION_REF_GREY * 2 ** startEV,
    sigmas: [HALATION_SIGMAS[0] * rs, HALATION_SIGMAS[1] * rs, HALATION_SIGMAS[2] * rs],
    gain: [a * layers.gain[0], a * layers.gain[1], a * layers.gain[2]],
    lobes: layers.lobes,
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
