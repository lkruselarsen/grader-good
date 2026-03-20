/**
 * Shared delta application for grading params.
 * Used by client-side train loop and server openai-loop.
 */

import type { LookParams, LookParamsMatch } from "@/lib/look-params";
import {
  DEFAULT_LOOK_PARAMS,
  defaultRefractionWheel,
  defaultExposureCurve,
  defaultContrastCurve,
  defaultColorDensityCurve,
  default7HandleIdentity,
} from "@/lib/look-params";

export const CLAMP_MAP: Record<string, [number, number]> = {
  exposureStrength: [0, 1.5],
  lumaStrength: [0, 0.5],
  colorStrength: [0, 2],
  blackStrength: [0.5, 8],
  blackRange: [0.2, 1.8],
  colorDensity: [0.5, 2],
  bandLowerShadow: [0, 2],
  bandUpperShadow: [0, 2],
  bandMid: [0, 2],
  bandLowerHigh: [0, 2],
  bandUpperHigh: [0, 2],
  highlightFillStrength: [0, 2],
  highlightFillWarmth: [-1, 1],
  halationTailGamma: [2, 6],
  halationContrastGate: [0, 1],
  halationRimStrength: [0, 1],
  halationBloomStrength: [0, 1],
  halationRimRadius: [0, 0.75],
  halationBloomRadius: [0, 2.5],
  halationThreshold: [0.9, 0.9999],
  actuanceStrength: [0, 3],
  actuanceRadius: [0.5, 5],
  actuanceHighlightGuard: [0.5, 0.9],
  actuanceHighlightGuardFloor: [0.2, 0.75],
  actuanceHighlightMinSize: [0.002, 0.02],
  bandLowerShadowHue: [-0.35, 0.35],
  bandUpperShadowHue: [-0.35, 0.35],
  bandMidHue: [-1, 1],
  bandLowerHighHue: [-0.35, 0.35],
  bandUpperHighHue: [-0.35, 0.35],
  bandLowerShadowSat: [0, 2],
  bandUpperShadowSat: [0, 2],
  bandMidSat: [0, 2],
  bandLowerHighSat: [0, 2],
  bandUpperHighSat: [0, 2],
  bandLowerShadowLuma: [-0.2, 0],
  bandUpperShadowLuma: [-0.2, 0.2],
  bandMidLuma: [-0.2, 0.2],
  bandLowerHighLuma: [-0.2, 0.2],
  bandUpperHighLuma: [-0.2, 0.2],
  refractionSplitL: [0, 1],
  bandLowerShadowTemp: [-0.35, 0.35],
  bandUpperShadowTemp: [-0.35, 0.35],
  bandMidTemp: [-1, 1],
  bandLowerHighTemp: [-0.35, 0.35],
  bandUpperHighTemp: [-0.35, 0.35],
};

export const HALATION_KEYS = new Set([
  "highlightFillStrength",
  "highlightFillWarmth",
  "halationTailGamma",
  "halationContrastGate",
  "halationRimStrength",
  "halationBloomStrength",
  "halationRimRadius",
  "halationBloomRadius",
  "halationThreshold",
]);

/** Phase 1–8 parameter keys for phased approach. Phase 6 uses prefix match for refraction. */
export const PHASE_KEYS: Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, Set<string>> = {
  1: new Set([
    "exposureStrength",
    "blackPoint",
    "blackRange",
    "blackStrength",
    "exposureCurve.L_out_0",
    "exposureCurve.L_out_1",
    "exposureCurve.L_out_2",
    "exposureCurve.L_out_3",
    "exposureCurve.L_out_4",
    "exposureCurve.L_out_5",
    "exposureCurve.L_out_6",
    "bandLowerShadowLuma",
    "bandUpperShadowLuma",
    "bandMidLuma",
    "bandLowerHighLuma",
    "bandUpperHighLuma",
  ]),
  2: new Set([
    "contrastCurve.values_0",
    "contrastCurve.values_1",
    "contrastCurve.values_2",
    "contrastCurve.values_3",
    "contrastCurve.values_4",
    "contrastCurve.values_5",
    "contrastCurve.values_6",
    "bandLowerShadowLuma",
    "exposureCurve.L_out_0",
    "blackStrength",
  ]),
  3: new Set([
    "colorDensityCurve.scale_0",
    "colorDensityCurve.scale_1",
    "colorDensityCurve.scale_2",
    "colorDensityCurve.scale_3",
    "colorDensityCurve.scale_4",
    "colorDensityCurve.scale_5",
    "colorDensityCurve.scale_6",
  ]),
  4: new Set(["colorStrength", "bandMidTemp", "bandMidHue", "bandMidSat"]),
  5: new Set([
    "bandLowerShadow",
    "bandUpperShadow",
    "bandLowerHigh",
    "bandUpperHigh",
    "bandLowerShadowHue",
    "bandUpperShadowHue",
    "bandLowerHighHue",
    "bandUpperHighHue",
    "bandLowerShadowSat",
    "bandUpperShadowSat",
    "bandLowerHighSat",
    "bandUpperHighSat",
    "bandLowerShadowTemp",
    "bandUpperShadowTemp",
    "bandLowerHighTemp",
    "bandUpperHighTemp",
  ]),
  6: new Set(["refractionSplitL"]),
  7: new Set(["actuanceStrength", "actuanceRadius", "actuanceHighlightGuard", "actuanceHighlightGuardFloor", "actuanceHighlightMinSize"]),
  8: new Set([...HALATION_KEYS]),
};

/** Model 2: 3 phases. Only params that work post-Model2. Phase 1 = exposure+color density+actuance; 2 = per-band hue/temp; 3 = halation. */
export const PHASE_KEYS_MODEL2: Record<1 | 2 | 3, Set<string>> = {
  1: new Set([
    "exposureCurve.L_out_0",
    "exposureCurve.L_out_1",
    "exposureCurve.L_out_2",
    "exposureCurve.L_out_3",
    "exposureCurve.L_out_4",
    "exposureCurve.L_out_5",
    "exposureCurve.L_out_6",
    "colorDensityCurve.scale_0",
    "colorDensityCurve.scale_1",
    "colorDensityCurve.scale_2",
    "colorDensityCurve.scale_3",
    "colorDensityCurve.scale_4",
    "colorDensityCurve.scale_5",
    "colorDensityCurve.scale_6",
    "actuanceStrength",
    "actuanceRadius",
    "actuanceHighlightGuard",
    "actuanceHighlightGuardFloor",
    "actuanceHighlightMinSize",
  ]),
  2: new Set([
    "bandLowerShadowHue",
    "bandUpperShadowHue",
    "bandMidHue",
    "bandLowerHighHue",
    "bandUpperHighHue",
    "bandLowerShadowTemp",
    "bandUpperShadowTemp",
    "bandMidTemp",
    "bandLowerHighTemp",
    "bandUpperHighTemp",
  ]),
  3: new Set([...HALATION_KEYS]),
};

function keyBelongsToPhase(phase: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, key: string): boolean {
  const allowed = PHASE_KEYS[phase];
  if (allowed.has(key)) return true;
  if (phase === 6 && (key.startsWith("refractionShadow.") || key.startsWith("refractionHighlight.")))
    return true;
  return false;
}

export function filterPhaseDeltas(
  phase: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
  deltas: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(deltas)) {
    if (keyBelongsToPhase(phase, k)) out[k] = v;
  }
  return out;
}

function keyBelongsToPhaseModel2(phase: 1 | 2 | 3, key: string): boolean {
  const allowed = PHASE_KEYS_MODEL2[phase];
  if (allowed.has(key)) return true;
  return false;
}

export function filterPhaseDeltasModel2(
  phase: 1 | 2 | 3,
  deltas: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(deltas)) {
    if (keyBelongsToPhaseModel2(phase, k)) out[k] = v;
  }
  return out;
}

export function filterNonHalationDeltas(
  deltas: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(deltas)) {
    if (HALATION_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function filterHalationDeltas(
  deltas: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(deltas)) {
    if (HALATION_KEYS.has(k)) out[k] = v;
  }
  return out;
}

export function parseJsonDeltas(text: string): Record<string, number> {
  const trimmed = text.trim().replace(/^```json?\s*|\s*```$/g, "");
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export type ApplyGradingDeltasOptions = {
  model2?: boolean;
  model2Phase?: 1 | 2 | 3;
};

function applyScalarMatchDeltas(
  match: LookParamsMatch,
  deltas: Record<string, number>,
  refBlackL?: number,
  options?: ApplyGradingDeltasOptions
): LookParamsMatch {
  const next: LookParamsMatch = { ...match };
  const blackPointMax = refBlackL ?? 0.2;
  const model2 = options?.model2 ?? false;
  const model2Phase = options?.model2Phase;
  for (const [key, delta] of Object.entries(deltas)) {
    if (typeof delta !== "number" || !Number.isFinite(delta)) continue;
    if (
      key.startsWith("refractionShadow.") ||
      key.startsWith("refractionHighlight.") ||
      key.startsWith("exposureCurve.") ||
      key.startsWith("colorDensityCurve.") ||
      key.startsWith("toneCurve.") ||
      key.startsWith("contrastCurve.")
    ) {
      continue;
    }
    const current = (next as unknown as Record<string, unknown>)[key];
    const base =
      typeof current === "number"
        ? current
        : (DEFAULT_LOOK_PARAMS.match as unknown as Record<string, unknown>)[key];
    const numericBase = typeof base === "number" ? base : 0;
    let minMax: [number, number];
    if (key === "blackPoint") {
      minMax = [0, blackPointMax];
    } else if (model2 && model2Phase === 2 && (key.endsWith("Hue") || key.endsWith("Temp"))) {
      minMax = [-0.5, 0.5];
    } else {
      minMax = CLAMP_MAP[key] ?? [numericBase - 2, numericBase + 2];
    }
    const [min, max] = minMax;
    const value = numericBase + delta;
    (next as unknown as Record<string, number>)[key] = Math.max(
      min,
      Math.min(max, value)
    );
  }
  return next;
}

function applyRefractionAndCurveDeltas(
  params: LookParams,
  deltas: Record<string, number>,
  options?: ApplyGradingDeltasOptions
): LookParams {
  const model2 = options?.model2 ?? false;
  const next: LookParams = {
    match: { ...params.match },
    grading: { ...params.grading },
  };

  function ensureRefractionWheel(
    field: "refractionShadow" | "refractionHighlight"
  ) {
    if (!next.match[field]) {
      next.match[field] = defaultRefractionWheel();
    }
    return next.match[field]!;
  }

  function ensureExposureCurve() {
    if (!next.match.exposureCurve) {
      next.match.exposureCurve = defaultExposureCurve();
    }
    return next.match.exposureCurve!;
  }

  function ensureContrastCurve() {
    if (!next.match.contrastCurve) {
      next.match.contrastCurve = defaultContrastCurve();
    }
    return next.match.contrastCurve!;
  }

  function ensureColorDensityCurve() {
    if (!next.match.colorDensityCurve) {
      next.match.colorDensityCurve = defaultColorDensityCurve();
    }
    return next.match.colorDensityCurve!;
  }

  function ensureToneCurve() {
    if (!next.grading.toneCurve) {
      next.grading.toneCurve = default7HandleIdentity();
    }
    return next.grading.toneCurve!;
  }

  const colorIndex: Record<string, number> = {
    red: 0,
    yellow: 1,
    green: 2,
    teal: 3,
    blue: 4,
    purple: 5,
  };

  for (const [key, delta] of Object.entries(deltas)) {
    if (typeof delta !== "number" || !Number.isFinite(delta)) continue;

    const refractionMatch = key.match(
      /^refraction(Shadow|Highlight)\.(red|yellow|green|teal|blue|purple)\.(hue|sat)$/
    );
    if (refractionMatch) {
      const [, which, color, channel] = refractionMatch as [
        string,
        "Shadow" | "Highlight",
        keyof typeof colorIndex,
        "hue" | "sat"
      ];
      const wheelField =
        which === "Shadow" ? "refractionShadow" : "refractionHighlight";
      const wheel = ensureRefractionWheel(wheelField);
      const idx = colorIndex[color];
      const node = wheel[idx];
      if (channel === "hue") {
        node.hue = clamp(node.hue + delta, 0, 360);
      } else {
        node.sat = clamp(node.sat + delta, 0, 3);
      }
      continue;
    }

    const expCurveMatch = key.match(/^exposureCurve\.L_out_(\d+)$/);
    if (expCurveMatch) {
      const idx = parseInt(expCurveMatch[1]!, 10);
      const curve = ensureExposureCurve();
      if (idx >= 0 && idx < curve.L_out.length) {
        const base = curve.L_out[idx] ?? 1;
        let v = base + delta;
        if (idx === 0) {
          v = clamp(v, 0, 1);
        } else if (model2 && idx >= 1) {
          v = clamp(v, 0, 1.5);
        } else {
          v = clamp(v, 0, 2);
        }
        curve.L_out[idx] = v;
      }
      continue;
    }

    const contrastCurveMatch = key.match(/^contrastCurve\.values_(\d+)$/);
    if (contrastCurveMatch) {
      const idx = parseInt(contrastCurveMatch[1]!, 10);
      const curve = ensureContrastCurve();
      if (idx >= 0 && idx < curve.values.length) {
        const base = curve.values[idx] ?? 0;
        curve.values[idx] = clamp(base + delta, -5, 5);
      }
      continue;
    }

    const cdCurveMatch = key.match(/^colorDensityCurve\.scale_(\d+)$/);
    if (cdCurveMatch) {
      const idx = parseInt(cdCurveMatch[1]!, 10);
      const curve = ensureColorDensityCurve();
      if (idx >= 0 && idx < curve.scale.length) {
        const base = curve.scale[idx] ?? 1;
        const cdMin = model2 ? 0.8 : 0.2;
        curve.scale[idx] = clamp(base + delta, cdMin, 2.5);
      }
      continue;
    }

    const toneCurveMatch = key.match(/^toneCurve\.L_out_(\d+)$/);
    if (toneCurveMatch) {
      const idx = parseInt(toneCurveMatch[1]!, 10);
      const curve = ensureToneCurve();
      if (idx >= 0 && idx < curve.L_out.length) {
        const base = curve.L_out[idx] ?? curve.L_in[idx] ?? idx / 6;
        curve.L_out[idx] = clamp(base + delta, 0, 1);
      }
      continue;
    }
  }

  return next;
}

/**
 * Apply deltas to LookParams. Handles scalar match params and refraction/curve keys.
 * options.model2 / options.model2Phase enable Model 2 clamp overrides (L_out 1..6 max 1.5, colorDensity min 0.8, band Hue/Temp ±0.5 in phase 2).
 */
export function applyGradingDeltas(
  params: LookParams,
  deltas: Record<string, number>,
  options?: ApplyGradingDeltasOptions
): LookParams {
  const refBlackL = params.grading?.refBlackL;
  const scalarUpdatedMatch = applyScalarMatchDeltas(
    params.match,
    deltas,
    refBlackL,
    options
  );
  const withScalars: LookParams = {
    match: scalarUpdatedMatch,
    grading: params.grading,
  };
  return applyRefractionAndCurveDeltas(withScalars, deltas, options);
}

/**
 * Ensures match has all optional curve/refraction fields for corrections table.
 */
export function ensureFullMatch(match: LookParamsMatch): LookParamsMatch {
  const m = { ...match };
  if (!m.exposureCurve) m.exposureCurve = defaultExposureCurve();
  if (!m.contrastCurve) m.contrastCurve = defaultContrastCurve();
  if (!m.refractionShadow) m.refractionShadow = defaultRefractionWheel();
  if (!m.refractionHighlight) m.refractionHighlight = defaultRefractionWheel();
  if (m.refractionSplitL === undefined) m.refractionSplitL = 0.5;
  if (!m.colorDensityCurve) m.colorDensityCurve = defaultColorDensityCurve();
  return m;
}
