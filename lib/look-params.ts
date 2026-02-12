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
    blackStrength: 1,
    blackRange: 0.6,
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
