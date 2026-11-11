import {
  DEFAULT_LOOK_PARAMS,
  defaultExposureCurve,
  type LookParams as LookParamsT,
} from "@/lib/look-params";

export const LAB2_DEFAULTS_STORAGE_KEY = "grader-good:lab2-defaults";
export const BULK_ITEM_SETTINGS_PREFIX = "grader-good:bulk-item:";
export const PREVIEW_MAX_EDGE = 1600;
export const LAB2_AUTO_DENSITY_ENABLED = false;

/** Lab2's extra exposure handle, between the two lowest of the shared 7. */
export const LAB2_EXPOSURE_SHADOW_ANCHOR = 1 / 12;

/**
 * Insert the Lab2 shadow handle at 1/12 when the curve lacks one. Its value is
 * interpolated from the neighbours, and every consumer interpolates linearly,
 * so the rendered curve is unchanged.
 */
export function withLab2ShadowHandle(curve: { L_in: number[]; L_out: number[] }): {
  L_in: number[];
  L_out: number[];
} {
  const n = Math.min(curve.L_in.length, curve.L_out.length);
  const x = LAB2_EXPOSURE_SHADOW_ANCHOR;
  if (n < 2 || curve.L_in.slice(0, n).some((v) => Math.abs(v - x) < 1e-4)) return curve;
  const k = curve.L_in.findIndex((v, i) => i < n && v > x);
  if (k <= 0) return curve;
  const x0 = curve.L_in[k - 1]!;
  const x1 = curve.L_in[k]!;
  const y0 = curve.L_out[k - 1] ?? 1;
  const y1 = curve.L_out[k] ?? 1;
  const y = y0 + ((x - x0) / Math.max(1e-9, x1 - x0)) * (y1 - y0);
  return {
    L_in: [...curve.L_in.slice(0, k), x, ...curve.L_in.slice(k, n)],
    L_out: [...curve.L_out.slice(0, k), y, ...curve.L_out.slice(k, n)],
  };
}

const LAB2_DEFAULT_EXPOSURE_CURVE = defaultExposureCurve();

export const LAB2_DEFAULT_LOOK_PARAMS: LookParamsT = {
  ...DEFAULT_LOOK_PARAMS,
  match: {
    ...DEFAULT_LOOK_PARAMS.match,
    colorDensityCurveMasterMul: 1.0,
    exposureCurve: withLab2ShadowHandle({
      ...LAB2_DEFAULT_EXPOSURE_CURVE,
      L_out: [
        0.35,
        0.5,
        0.65,
        ...LAB2_DEFAULT_EXPOSURE_CURVE.L_out.slice(3),
      ],
    }),
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
