/**
 * Match stage: color engine (agent 1). Delegates to colorEngine.
 */

import { apply } from "./colorEngine";
import type { PixelFrameRGBA, PipelineParams } from "./types";

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
