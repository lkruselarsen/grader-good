import {
  DEFAULT_LOOK_PARAMS,
  defaultExposureCurve,
  type LookParams as LookParamsT,
} from "@/lib/look-params";

export const LAB2_DEFAULTS_STORAGE_KEY = "grader-good:lab2-defaults";
export const BULK_ITEM_SETTINGS_PREFIX = "grader-good:bulk-item:";
export const PREVIEW_MAX_EDGE = 1600;
export const LAB2_AUTO_DENSITY_ENABLED = false;

const LAB2_DEFAULT_EXPOSURE_CURVE = defaultExposureCurve();

export const LAB2_DEFAULT_LOOK_PARAMS: LookParamsT = {
  ...DEFAULT_LOOK_PARAMS,
  match: {
    ...DEFAULT_LOOK_PARAMS.match,
    colorDensityCurveMasterMul: 1.0,
    exposureCurve: {
      ...LAB2_DEFAULT_EXPOSURE_CURVE,
      L_out: [
        0.35,
        0.5,
        0.65,
        ...LAB2_DEFAULT_EXPOSURE_CURVE.L_out.slice(3),
      ],
    },
    devignette: {
      ...(DEFAULT_LOOK_PARAMS.match.devignette ?? {
        innerDiameterNorm: 0.65,
        strengthStops: 0,
      }),
      strengthStops: 1.88,
    },
  },
};

export const REFRACTION_HUE_NAMES = [
  "deep red",
  "red-orange",
  "amber orange",
  "golden yellow",
  "yellow-green",
  "emerald green",
  "aqua cyan",
  "azure blue",
  "deep cobalt",
  "violet purple",
  "magenta pink",
  "rose crimson",
] as const;

export function deepMergeLab2(
  base: LookParamsT,
  saved: Partial<LookParamsT>
): LookParamsT {
  return {
    ...base,
    ...saved,
    match: { ...base.match, ...saved.match },
    grading: { ...base.grading, ...saved.grading },
    halation: saved.halation
      ? { ...base.halation, ...saved.halation }
      : base.halation,
    grain: saved.grain ? { ...base.grain, ...saved.grain } : base.grain,
  };
}

export function cloneLab2LookParams(params: LookParamsT): LookParamsT {
  return JSON.parse(JSON.stringify(params)) as LookParamsT;
}
