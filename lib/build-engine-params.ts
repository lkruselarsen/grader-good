/**
 * Build pipeline engine params from UI LookParams and final grading.
 * Shared by run-pipeline (browser) and OpenAI training route (Node).
 */

import type { LookParams, LookParamsGrading } from "./look-params";
import { gradingToEngine, DEFAULT_LOOK_PARAMS } from "./look-params";
import type { GradingParams } from "@/src/lib/pipeline/types";

export function buildEngineParamsFromLookParams(
  params: LookParams,
  finalGrading: LookParamsGrading
): GradingParams & Record<string, unknown> {
  const m = params?.match ?? DEFAULT_LOOK_PARAMS.match;
  const engine = gradingToEngine(finalGrading) as GradingParams & Record<string, unknown>;
  engine.colorDensity = m.colorDensity ?? 1;
  engine.lumaStrength = m.lumaStrength ?? 1;
  engine.colorStrength = m.colorStrength ?? 1;
  engine.exposureStrength = m.exposureStrength ?? 1;
  engine.refBlackL = m.blackPoint ?? finalGrading?.refBlackL ?? 0.05;
  if (typeof m.blackStrength === "number") engine.blackStrength = m.blackStrength;
  if (typeof m.blackRange === "number") engine.blackRange = m.blackRange;
  engine.colorBandStrengths = {
    lowerShadow: m.bandLowerShadow ?? 1,
    upperShadow: m.bandUpperShadow ?? 1,
    mid: m.bandMid ?? 1,
    lowerHigh: m.bandLowerHigh ?? 1,
    upperHigh: m.bandUpperHigh ?? 1,
  };
  engine.colorBandOverrides = {
    hue: {
      lowerShadow: m.bandLowerShadowHue ?? 0,
      upperShadow: m.bandUpperShadowHue ?? 0,
      mid: m.bandMidHue ?? 0,
      lowerHigh: m.bandLowerHighHue ?? 0,
      upperHigh: m.bandUpperHighHue ?? 0,
    },
    sat: {
      lowerShadow: m.bandLowerShadowSat ?? 1,
      upperShadow: m.bandUpperShadowSat ?? 1,
      mid: m.bandMidSat ?? 1,
      lowerHigh: m.bandLowerHighSat ?? 1,
      upperHigh: m.bandUpperHighSat ?? 1,
    },
    luma: {
      lowerShadow: m.bandLowerShadowLuma ?? 0,
      upperShadow: m.bandUpperShadowLuma ?? 0,
      mid: m.bandMidLuma ?? 0,
      lowerHigh: m.bandLowerHighLuma ?? 0,
      upperHigh: m.bandUpperHighLuma ?? 0,
    },
  };
  engine.highlightFill = {
    strength: m.highlightFillStrength ?? 0,
    warmth: m.highlightFillWarmth ?? 0,
  };
  if (m.refractionShadow != null) engine.refractionShadow = m.refractionShadow as typeof engine.refractionShadow;
  if (m.refractionHighlight != null) engine.refractionHighlight = m.refractionHighlight as typeof engine.refractionHighlight;
  if (m.refractionSplitL != null) engine.refractionSplitL = m.refractionSplitL;
  if (m.exposureCurve != null) engine.exposureCurve = m.exposureCurve;
  if (m.colorDensityCurve != null) engine.colorDensityCurve = m.colorDensityCurve;
  if (m.actuanceStrength != null) engine.actuanceStrength = m.actuanceStrength;
  if (m.actuanceRadius != null) engine.actuanceRadius = m.actuanceRadius;
  return engine;
}
