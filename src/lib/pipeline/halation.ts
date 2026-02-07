/**
 * Halation stage. Stub – halation will be implemented later.
 * Passthrough: returns input unchanged.
 */

import type { PixelFrameRGBA, PipelineParams } from "./types";

export function halation(
  frame: PixelFrameRGBA,
  _params: PipelineParams
): PixelFrameRGBA {
  return frame;
}
