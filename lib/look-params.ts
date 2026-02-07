import type { LookParams as EngineLookParams } from "@/src/lib/pipeline/stages/match";

/**
 * Look parameters for the grading pipeline.
 * Single object used by all lab sliders; shape is future-proof for new stages.
 */

export interface LookParamsMatch {
  strength: number;
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
  shadowTintA: number;
  shadowTintB: number;
  highlightTintA: number;
  highlightTintB: number;
  shadowContrast: number;
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
    shadowTintA: 0,
    shadowTintB: 0,
    highlightTintA: 0,
    highlightTintB: 0,
    shadowContrast: 1,
  };
}

export const DEFAULT_LOOK_PARAMS: LookParams = {
  match: { strength: 1 },
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
    shadowTint: { a: g.shadowTintA, b: g.shadowTintB },
    highlightTint: { a: g.highlightTintA, b: g.highlightTintB },
    shadowContrast: g.shadowContrast,
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
    shadowTintA: e.shadowTint.a,
    shadowTintB: e.shadowTint.b,
    highlightTintA: e.highlightTint.a,
    highlightTintB: e.highlightTint.b,
    shadowContrast: e.shadowContrast,
  };
}
