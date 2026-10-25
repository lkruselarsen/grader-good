/**
 * Build pipeline engine params from UI LookParams and final grading.
 * Shared by run-pipeline (browser) and OpenAI training route (Node).
 */

import type { LookParams, LookParamsGrading } from "./look-params";
import {
  gradingToEngine,
  DEFAULT_LOOK_PARAMS,
  defaultExposureCurve,
  defaultColorDensityCurve,
  defaultRefractionWheel,
  defaultContrastCurve,
} from "./look-params";
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
  engine.refBlackL =
    m.blackPoint !== undefined && m.blackPoint !== null
      ? m.blackPoint
      : (finalGrading?.refBlackL ?? 0.05);
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
    // Per-band colour temperature (cold ↔ warm) overrides; mapped to OKLab b-axis.
    temp: {
      lowerShadow: m.bandLowerShadowTemp ?? 0,
      upperShadow: m.bandUpperShadowTemp ?? 0,
      mid: m.bandMidTemp ?? 0,
      lowerHigh: m.bandLowerHighTemp ?? 0,
      upperHigh: m.bandUpperHighTemp ?? 0,
    },
  };
  const dm = DEFAULT_LOOK_PARAMS.match;
  engine.highlightWarmth = {
    hue: m.highlightWarmthHue ?? dm.highlightWarmthHue ?? 35,
    amount: m.highlightWarmthAmount ?? dm.highlightWarmthAmount ?? 0,
    threshold: m.highlightWarmthThreshold ?? dm.highlightWarmthThreshold ?? 0.25,
  };
  engine.halation = {
    edge: m.halationEdge ?? dm.halationEdge ?? 0.5,
    strength: m.halationStrength ?? dm.halationStrength ?? 0,
  };
  engine.refractionShadow = (m.refractionShadow ?? defaultRefractionWheel()) as typeof engine.refractionShadow;
  engine.refractionHighlight = (m.refractionHighlight ?? defaultRefractionWheel()) as typeof engine.refractionHighlight;
  engine.refractionSplitL = m.refractionSplitL ?? 0.5;
  const baseExp = m.exposureCurve ?? defaultExposureCurve();
  const expMul = Math.max(0.25, Math.min(4, m.exposureCurveMasterMul ?? 1));
  engine.exposureCurve = {
    L_in: [...baseExp.L_in],
    L_out: baseExp.L_out.map((v) =>
      Math.max(0, Math.min(2, v * expMul))
    ),
  };
  const baseDen = m.colorDensityCurve ?? defaultColorDensityCurve();
  const denMul = Math.max(0.25, Math.min(4, m.colorDensityCurveMasterMul ?? 1));
  engine.colorDensityCurve = {
    L_anchors: [...baseDen.L_anchors],
    scale: baseDen.scale.map((s) =>
      Math.max(0.2, Math.min(2.5, s * denMul))
    ),
  };
  engine.contrastCurve = m.contrastCurve ?? defaultContrastCurve();
  if (m.actuanceStrength != null) engine.actuanceStrength = m.actuanceStrength;
  if (m.actuanceRadius != null) engine.actuanceRadius = m.actuanceRadius;
  if (m.actuanceHighlightGuard != null) engine.actuanceHighlightGuard = m.actuanceHighlightGuard;
  if (m.actuanceHighlightGuardFloor != null) engine.actuanceHighlightGuardFloor = m.actuanceHighlightGuardFloor;
  if (m.actuanceHighlightMinSize != null) engine.actuanceHighlightMinSize = m.actuanceHighlightMinSize;
  if (m.highlightSmoothing != null) engine.highlightSmoothing = m.highlightSmoothing;
  engine.refractionPostModel2 =
    m.refractionPostModel2?.length === 12
      ? [...m.refractionPostModel2]
      : Array.from({ length: 12 }, () => 1);
  if (m.devignette) {
    engine.devignette = {
      innerDiameterNorm: m.devignette.innerDiameterNorm,
      strengthStops: m.devignette.strengthStops,
    };
  }
  return engine;
}

/**
 * Lab2 effects toggle: when disabled, the finishing stages (highlight warmth +
 * halation) become no-ops while the slider values themselves stay untouched.
 */
export function gateFinishingEffects<T extends GradingParams>(
  engine: T,
  effectsEnabled: boolean
): T {
  if (effectsEnabled) return engine;
  return {
    ...engine,
    highlightWarmth: engine.highlightWarmth
      ? { ...engine.highlightWarmth, amount: 0 }
      : undefined,
    halation: engine.halation ? { ...engine.halation, strength: 0 } : undefined,
  };
}
