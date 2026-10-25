/**
 * Server-safe pipeline: match → post-grade stages → finishing → grain.
 * No decode step, no dependency on ./decode or libraw-wasm.
 *
 * Use in API routes (e.g. /api/train/openai-loop) where frames are already
 * decoded via decodeBuffer/decodeBufferLinear. Import from this file or from
 * the pipeline barrel so that processOne.ts (and its dynamic import of ./decode)
 * is never loaded in the server bundle — avoiding the V8 crash
 * "Fatal JavaScript invalid size error 169220804" during webpack chunk processing.
 */

import { grain, grainFloat } from "./grain";
import { applyHalationFloat } from "./finishing/halation";
import { applyHighlightWarmthFloat } from "./finishing/highlight-warmth";
import { match, matchFloat } from "./match";
import { applyExposureCurveFloat } from "./stages/exposureCurvePost";
import { applyDevignetteFloat } from "./stages/devignette";
import { applyRefractionPostModel2Float } from "./stages/refractionPostModel2";
import {
  applyColorDensityCurveFloat,
  applyBandHueTempFloat,
  applyActuanceFloat,
  applyHighlightSmoothingFloat,
} from "./stages/postModel2Grading";
import type { PipelineParams, PixelFrameF32, PixelFrameRGBA } from "./types";
import type { ColorBandOverrides } from "./stages/match";

function hasNonZeroHueOrTemp(overrides: ColorBandOverrides): boolean {
  const check = (v: number) => Math.abs(v) > 1e-6;
  const h = overrides.hue;
  const t = overrides.temp;
  if (h && (check(h.lowerShadow) || check(h.upperShadow) || check(h.mid) || check(h.lowerHigh) || check(h.upperHigh)))
    return true;
  if (t && (check(t.lowerShadow) || check(t.upperShadow) || check(t.mid) || check(t.lowerHigh) || check(t.upperHigh)))
    return true;
  return false;
}

export function processFrames(
  source: PixelFrameRGBA,
  reference: PixelFrameRGBA | null,
  params: PipelineParams
): PixelFrameRGBA {
  const afterMatch = match(source, reference, params);
  return grain(afterMatch, params);
}

/**
 * Run pipeline in linear float space. Same stages as processFrames.
 * Quantize to 8-bit only at export (pixelFrameF32ToPixelFrameRGBA).
 */
export function processFramesFloat(
  source: PixelFrameF32,
  reference: PixelFrameF32 | null,
  params: PipelineParams
): PixelFrameF32 {
  let afterMatch = matchFloat(source, reference, params);
  if (params.matchModel === 2 && params.grading) {
    if (
      params.grading.exposureCurve?.L_in?.length &&
      params.grading.exposureCurve.L_out?.length
    ) {
      afterMatch = applyExposureCurveFloat(
        afterMatch,
        params.grading.exposureCurve
      );
    }
    if (
      params.grading.colorDensityCurve?.L_anchors?.length &&
      params.grading.colorDensityCurve.scale?.length
    ) {
      afterMatch = applyColorDensityCurveFloat(
        afterMatch,
        params.grading.colorDensityCurve
      );
    }
    const r12 = params.grading.refractionPostModel2;
    if (r12?.length === 12) {
      afterMatch = applyRefractionPostModel2Float(afterMatch, r12);
    }
    const dev = params.grading.devignette;
    if (
      dev &&
      typeof dev.strengthStops === "number" &&
      dev.strengthStops > 1e-6
    ) {
      afterMatch = applyDevignetteFloat(afterMatch, dev);
    }
    const overrides = params.grading.colorBandOverrides;
    if (overrides?.hue && hasNonZeroHueOrTemp(overrides)) {
      afterMatch = applyBandHueTempFloat(
        afterMatch,
        { hue: overrides.hue, temp: overrides.temp },
        params.colorBandAnchors
      );
    }
    if ((params.grading.highlightSmoothing ?? 0) > 1e-4) {
      afterMatch = applyHighlightSmoothingFloat(
        afterMatch,
        params.grading.highlightSmoothing
      );
    }
    afterMatch = applyHighlightWarmthFloat(afterMatch, params.grading.highlightWarmth, {
      inPlace: afterMatch.data !== source.data,
    });
    const actuanceS = params.grading.actuanceStrength;
    if (actuanceS != null && actuanceS > 1e-3) {
      afterMatch = applyActuanceFloat(
        afterMatch,
        actuanceS,
        params.grading.actuanceRadius,
        params.grading.actuanceHighlightGuard,
        params.grading.actuanceHighlightGuardFloor,
        params.grading.actuanceHighlightMinSize
      );
    }
  }
  if (params.matchModel !== 2) {
    afterMatch = applyHighlightWarmthFloat(afterMatch, params.grading?.highlightWarmth, {
      inPlace: afterMatch.data !== source.data,
    });
  }
  const afterHalation = applyHalationFloat(afterMatch, params.grading?.halation, {
    inPlace: afterMatch.data !== source.data,
  });
  return grainFloat(afterHalation, params);
}
