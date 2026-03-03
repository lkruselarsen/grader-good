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
  exposureStrength: [0, 2],
  lumaStrength: [0, 0.5],
  colorStrength: [0, 2],
  blackStrength: [0, 8],
  blackRange: [0.2, 1.8],
  blackPoint: [0, 0.3],
  colorDensity: [0.5, 2],
  bandLowerShadow: [0, 2],
  bandUpperShadow: [0, 2],
  bandMid: [0, 2],
  bandLowerHigh: [0, 2],
  bandUpperHigh: [0, 2],
  highlightFillStrength: [0, 1],
  highlightFillWarmth: [-1, 1],
  halationTailGamma: [2, 6],
  halationContrastGate: [0, 1],
  halationRimStrength: [0, 1],
  halationBloomStrength: [0, 1],
  halationRimRadius: [0, 2],
  halationBloomRadius: [0, 10],
  actuanceStrength: [0, 3],
  actuanceRadius: [0.5, 5],
  bandLowerShadowHue: [-1, 1],
  bandUpperShadowHue: [-1, 1],
  bandMidHue: [-1, 1],
  bandLowerHighHue: [-1, 1],
  bandUpperHighHue: [-1, 1],
  bandLowerShadowSat: [0, 2],
  bandUpperShadowSat: [0, 2],
  bandMidSat: [0, 2],
  bandLowerHighSat: [0, 2],
  bandUpperHighSat: [0, 2],
  bandLowerShadowLuma: [-0.2, 0.2],
  bandUpperShadowLuma: [-0.2, 0.2],
  bandMidLuma: [-0.2, 0.2],
  bandLowerHighLuma: [-0.2, 0.2],
  bandUpperHighLuma: [-0.2, 0.2],
  refractionSplitL: [0, 1],
  bandLowerShadowTemp: [-1, 1],
  bandUpperShadowTemp: [-1, 1],
  bandMidTemp: [-1, 1],
  bandLowerHighTemp: [-1, 1],
  bandUpperHighTemp: [-1, 1],
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
]);

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

function applyScalarMatchDeltas(
  match: LookParamsMatch,
  deltas: Record<string, number>
): LookParamsMatch {
  const next: LookParamsMatch = { ...match };
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
    const [min, max] = CLAMP_MAP[key] ?? [numericBase - 2, numericBase + 2];
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
  deltas: Record<string, number>
): LookParams {
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
        curve.L_out[idx] = clamp(base + delta, 0, 2);
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
        curve.scale[idx] = clamp(base + delta, 0.2, 2.5);
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
 */
export function applyGradingDeltas(
  params: LookParams,
  deltas: Record<string, number>
): LookParams {
  const scalarUpdatedMatch = applyScalarMatchDeltas(params.match, deltas);
  const withScalars: LookParams = {
    match: scalarUpdatedMatch,
    grading: params.grading,
  };
  return applyRefractionAndCurveDeltas(withScalars, deltas);
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
