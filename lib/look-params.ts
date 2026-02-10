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
  };
}

export const DEFAULT_LOOK_PARAMS: LookParams = {
  // Default UI match controls, tuned to designer-selected slider positions.
  // Ranges are 0..2, so percentages map directly: e.g. 10.5% ≈ 0.21.
  match: {
    lumaStrength: 0.21, // ~10.5% thumb position
    colorStrength: 0.35, // ~17.5% thumb position (aria-valuenow=0.35)
    colorDensity: 1,
    exposureStrength: 1.11, // ~55.5% track fill → 1.11 on 0..2
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
  };
}
