import type {
  LookParams as EngineLookParams,
  ToneCurveParams,
  TintByLParams,
  SaturationByLParams,
} from "@/src/lib/pipeline/stages/match";

/**
 * Look parameters for the grading pipeline.
 * Single object used by all lab sliders; shape is future-proof for new stages.
 */

/** Six colour nodes. Order: red, yellow, green, teal, blue, purple. */
export interface RefractionNode {
  /** Hue in degrees (0–360). Where this colour is remapped to. Red=0, Yellow=60, Green=120, Teal=180, Blue=240, Purple=300. */
  hue: number;
  /** Saturation multiplier: 0 = no saturation, 1 = normal, 3 = 3× saturation. */
  sat: number;
}
export type RefractionWheel = [RefractionNode, RefractionNode, RefractionNode, RefractionNode, RefractionNode, RefractionNode];

/** Default refraction wheel: canonical positions (0°, 60°, …, 300°), sat 1. */
export function defaultRefractionWheel(): RefractionWheel {
  return [
    { hue: 0, sat: 1 },
    { hue: 60, sat: 1 },
    { hue: 120, sat: 1 },
    { hue: 180, sat: 1 },
    { hue: 240, sat: 1 },
    { hue: 300, sat: 1 },
  ];
}

/** Default 7-handle identity curve: L_in and L_out [0, 1/6, 2/6, 3/6, 4/6, 5/6, 1]. */
export function default7HandleIdentity(): { L_in: number[]; L_out: number[] } {
  const L = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1];
  return { L_in: [...L], L_out: [...L] };
}

/**
 * Default 7-handle exposure curve:
 * - L_in: fixed tonal anchors [0, 1/6, 2/6, 3/6, 4/6, 5/6, 1]
 * - L_out: per-handle exposure multipliers, all 1 (neutral).
 */
export function defaultExposureCurve(): { L_in: number[]; L_out: number[] } {
  const anchors = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1];
  return {
    L_in: [...anchors],
    // Exposure multipliers (0..2), 1 = neutral per handle.
    L_out: [1, 1, 1, 1, 1, 1, 1],
  };
}

/** Default 7-handle color density: same L anchors, scale all 1. */
export function defaultColorDensityCurve(): { L_anchors: number[]; scale: number[] } {
  const L = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1];
  return { L_anchors: [...L], scale: [1, 1, 1, 1, 1, 1, 1] };
}

/**
 * Default 7-handle filmic contrast curve (unedited = no change).
 * L_anchors: [0, 1/6, ..., 1]; values: H1..H7 in [-5, +5].
 */
export function defaultContrastCurve(): { L_anchors: number[]; values: number[] } {
  const L_anchors = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1];
  const values = [-5, -3.5, -1.75, 0, 1.75, 3.5, 5];
  return { L_anchors: [...L_anchors], values: [...values] };
}

export interface LookParamsMatch {
  /** Luma match strength (0..2, 1 = match reference). */
  lumaStrength: number;
  /** Color match strength (0..2, 1 = match reference). */
  colorStrength: number;
  /** Global chroma multiplier (1 = neutral, >1 = richer). */
  colorDensity: number;
  /** Exposure match strength (0..2, 1 = match reference). */
  exposureStrength: number;
  /** How strongly to apply black/shadow alignment (0..4, 1 = normal). */
  blackStrength: number;
  /**
   * Upper luminance bound for the black/shadow pull (0..1).
   * Pixels with L <= blackRange are affected; higher = extends into midtones.
   */
  blackRange: number;
  /** Black point anchor (0..0.15). Overrides fitted refBlackL when set. */
  blackPoint?: number;
  /** Per-band color match strength: deepest shadows. */
  bandLowerShadow: number;
  /** Per-band color match strength: upper shadows / low mids. */
  bandUpperShadow: number;
  /** Per-band color match strength: true midtones. */
  bandMid: number;
  /** Per-band color match strength: lower highlights. */
  bandLowerHigh: number;
  /** Per-band color match strength: brightest highlights. */
  bandUpperHigh: number;
  /**
   * Per-band manual hue overrides (-1..1, 0 = neutral). Applied on top of the
   * automatic 5-band match; interpreted as a small hue rotation per band.
   */
  bandLowerShadowHue: number;
  bandUpperShadowHue: number;
  bandMidHue: number;
  bandLowerHighHue: number;
  bandUpperHighHue: number;
  /**
   * Per-band manual saturation multipliers (0..2, 1 = neutral). Applied after
   * automatic chroma match so you can locally push/pull saturation.
   */
  bandLowerShadowSat: number;
  bandUpperShadowSat: number;
  bandMidSat: number;
  bandLowerHighSat: number;
  bandUpperHighSat: number;
  /**
   * Per-band manual luma offsets (-0.2..0.2, 0 = neutral). Applied late in the
   * pipeline to nudge tone per band without fighting the main tone curve.
   */
  bandLowerShadowLuma: number;
  bandUpperShadowLuma: number;
  bandMidLuma: number;
  bandLowerHighLuma: number;
  bandUpperHighLuma: number;
  /** Highlight fill (bloom/density) strength (0..1). Gated to top L percentiles and specular texture. */
  highlightFillStrength: number;
  /** Optional highlight fill warmth (-1..1). Small warm tint in affected highlights. */
  highlightFillWarmth?: number;
  /** Halation tail gamma (2–6). Steeper = stronger in ultra-highlights (99.99%) vs lower (98%). */
  halationTailGamma?: number;
  /** Halation contrast gate (0–1). Dark-neighbor gating: highlight vs shadow, not upper vs lower highlight. */
  halationContrastGate?: number;
  /** Halation rim strength (0–1). Thin red edge component. */
  halationRimStrength?: number;
  /** Halation bloom strength (0–1). Soft halo component. */
  halationBloomStrength?: number;
  /** Halation rim radius (% of image short edge, 0–2). Resolution-independent. */
  halationRimRadius?: number;
  /** Halation bloom radius (% of image short edge, 0–10). Resolution-independent. */
  halationBloomRadius?: number;
  /** Halation interior guard (0–1). Attenuate halation in highlight cores; 0=off, 0.5=default. */
  halationInteriorGuard?: number;
  /** Refraction: shadow wheel (6 nodes: red, yellow, green, teal, blue, purple). Each node { hue: 0..360°, sat: 0..3 }. */
  refractionShadow?: RefractionWheel;
  /** Refraction: highlight wheel. Same shape. */
  refractionHighlight?: RefractionWheel;
  /** Refraction: L value where shadow/highlight split occurs (0..1), or blend factor. */
  refractionSplitL?: number;
  /** 7-handle exposure curve: L_in[], L_out[] (optional). */
  exposureCurve?: { L_in: number[]; L_out: number[] };
  /** 7-handle color density curve: L_anchors[], scale[] (optional). */
  colorDensityCurve?: { L_anchors: number[]; scale: number[] };
  /** 7-handle filmic contrast curve: L_anchors[], values[] (-5..+5 per handle). Default = no change. */
  contrastCurve?: { L_anchors: number[]; values: number[] };
  /** Actuance (local contrast) strength (0..2, 0 = off). */
  actuanceStrength?: number;
  /** Actuance radius (relative or pixels). */
  actuanceRadius?: number;
  /**
   * Per-band colour temperature (cold ↔ warm) controls (-1..1, 0 = neutral).
   * Negative values push the band cooler (towards blue/cyan), positive values
   * push warmer (towards yellow/orange) along the OKLab b-axis.
   */
  bandLowerShadowTemp?: number;
  bandUpperShadowTemp?: number;
  bandMidTemp?: number;
  bandLowerHighTemp?: number;
  bandUpperHighTemp?: number;
}

/** Flat grading params for UI; converted to EngineLookParams for pipeline. */
export interface LookParamsGrading {
  lift: number;
  gamma: number;
  gain: number;
  shadowRolloff: number;
  highlightRolloff: number;
  shadowColorDensity: number;
  highlightColorDensity: number;
  warmth: number;
  tint: number;
  shadowTintA: number;
  shadowTintB: number;
  highlightTintA: number;
  highlightTintB: number;
  shadowContrast: number;
  toneCurve?: ToneCurveParams;
  tintByL?: TintByLParams;
  saturationByL?: SaturationByLParams;
  /** Overall reference saturation (1 = neutral). Fitted from reference; applied to source. */
  refSaturation?: number;
  /** Reference midtone micro-contrast scalar (RMS of detail on L in mids). */
  microContrastMid?: number;
  /** Reference median L (exposure match target). Fitted from reference. */
  refMidL?: number;
  /** Reference 5th percentile L (black/shadow match target). Fitted from reference. */
  refBlackL?: number;
  /** Optional per-band reference stats for 5-band colour matching. */
  colorMatchBands?: {
    refA: number[];
    refB: number[];
    refC: number[];
  };
}

export interface LookParams {
  match: LookParamsMatch;
  grading: LookParamsGrading;
  halation?: Record<string, number>;
  grain?: Record<string, number>;
}

function defaultGrading(): LookParamsGrading {
  return {
    lift: 0,
    gamma: 1,
    gain: 1,
    shadowRolloff: 0,
    highlightRolloff: 0,
    shadowColorDensity: 1,
    highlightColorDensity: 1,
    warmth: 0,
    tint: 0,
    shadowTintA: 0,
    shadowTintB: 0,
    highlightTintA: 0,
    highlightTintB: 0,
    shadowContrast: 1,
    toneCurve: undefined,
    tintByL: undefined,
    saturationByL: undefined,
    refSaturation: undefined,
    microContrastMid: undefined,
    refMidL: undefined,
    refBlackL: undefined,
  };
}

export const DEFAULT_LOOK_PARAMS: LookParams = {
  match: {
    lumaStrength: 0.21,
    colorStrength: 0.35,
    colorDensity: 1,
    exposureStrength: 1.11,
    // Film-like defaults: slightly lifted but deep blacks so training and
    // heuristics start closer to typical references.
    blackStrength: 5.5,
    blackRange: 0.6,
    blackPoint: 0.01,
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
    highlightFillStrength: 0.5,
    highlightFillWarmth: 0,
    halationTailGamma: 4,
    halationContrastGate: 1,
    halationRimStrength: 0.6,
    halationBloomStrength: 0.8,
    halationRimRadius: 0.1,
    halationBloomRadius: 1.0,
    halationInteriorGuard: 0.5,
    // Default actuance is slightly on so local contrast is visible by default.
    actuanceStrength: 1,
    actuanceRadius: 2,
    bandLowerShadowTemp: 0,
    bandUpperShadowTemp: 0,
    bandMidTemp: 0,
    bandLowerHighTemp: 0,
    bandUpperHighTemp: 0,
  },
  grading: defaultGrading(),
};

/** Convert flat UI grading to engine LookParams. */
export function gradingToEngine(g: LookParamsGrading): EngineLookParams {
  return {
    tone: { lift: g.lift, gamma: g.gamma, gain: g.gain },
    saturation: {
      shadowRolloff: g.shadowRolloff,
      highlightRolloff: g.highlightRolloff,
      shadowColorDensity: g.shadowColorDensity,
      highlightColorDensity: g.highlightColorDensity,
    },
    warmth: g.warmth,
    tint: g.tint,
    shadowTint: { a: g.shadowTintA, b: g.shadowTintB },
    highlightTint: { a: g.highlightTintA, b: g.highlightTintB },
    shadowContrast: g.shadowContrast,
    toneCurve: g.toneCurve,
    tintByL: g.tintByL,
    saturationByL: g.saturationByL,
    refSaturation: g.refSaturation,
    microContrastMid: g.microContrastMid,
    refMidL: g.refMidL,
    refBlackL: g.refBlackL,
    colorMatchBands: g.colorMatchBands,
  };
}

/** Convert engine LookParams to flat UI grading. */
export function engineToGrading(e: EngineLookParams): LookParamsGrading {
  return {
    lift: e.tone.lift,
    gamma: e.tone.gamma,
    gain: e.tone.gain,
    shadowRolloff: e.saturation.shadowRolloff,
    highlightRolloff: e.saturation.highlightRolloff,
    shadowColorDensity: e.saturation.shadowColorDensity,
    highlightColorDensity: e.saturation.highlightColorDensity,
    warmth: e.warmth,
    tint: e.tint ?? 0,
    shadowTintA: e.shadowTint.a,
    shadowTintB: e.shadowTint.b,
    highlightTintA: e.highlightTint.a,
    highlightTintB: e.highlightTint.b,
    shadowContrast: e.shadowContrast,
    toneCurve: e.toneCurve,
    tintByL: e.tintByL,
    saturationByL: e.saturationByL,
    refSaturation: e.refSaturation,
    microContrastMid: e.microContrastMid,
    refMidL: e.refMidL,
    refBlackL: e.refBlackL,
    colorMatchBands: e.colorMatchBands,
  };
}
