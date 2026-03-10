/**
 * Match stage: color engine (agent 1). Delegates to colorEngine.
 */

import { apply, applyFloat } from "./colorEngine";
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
  return applyFloat(source, reference, params);
}
