/**
 * Match stage: color engine (agent 1) or Model 2 Reinhard transfer.
 */

import { apply, applyFloat } from "./colorEngine";
import { applyModel2, applyFloatModel2 } from "./stages/matchModel2";
import type { PixelFrameF32, PixelFrameRGBA, PipelineParams } from "./types";

/**
 * Run color matching: source + optional reference + params → new PixelFrameRGBA.
 * Same dimensions as source.
 */
export function match(
  source: PixelFrameRGBA,
  reference: PixelFrameRGBA | null,
  params: PipelineParams
): PixelFrameRGBA {
  if (params.matchModel === 2) {
    return applyModel2(source, reference, params);
  }
  return apply(source, reference, params);
}

/**
 * Run color matching in linear float space.
 */
export function matchFloat(
  source: PixelFrameF32,
  reference: PixelFrameF32 | null,
  params: PipelineParams
): PixelFrameF32 {
  if (params.matchModel === 2) {
    return applyFloatModel2(source, reference, params);
  }
  return applyFloat(source, reference, params);
}
