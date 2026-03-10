/**
 * Grain stage. Stub – do not implement grain logic here.
 * Passthrough: returns input unchanged.
 */

import type { PixelFrameF32, PixelFrameRGBA, PipelineParams } from "./types";

export function grain(
  frame: PixelFrameRGBA,
  _params: PipelineParams // eslint-disable-line @typescript-eslint/no-unused-vars
): PixelFrameRGBA {
  return frame;
}

/**
 * Grain stage for linear float. Passthrough.
 */
export function grainFloat(
  frame: PixelFrameF32,
  _params: PipelineParams // eslint-disable-line @typescript-eslint/no-unused-vars
): PixelFrameF32 {
  return frame;
}
