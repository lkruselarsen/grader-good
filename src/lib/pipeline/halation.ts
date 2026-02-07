/**
 * Halation stage. Stub – halation will be implemented later.
 * Passthrough: returns input unchanged.
 */

import type { PixelFrameRGBA, PipelineParams } from "./types";

export function halation(
  frame: PixelFrameRGBA,
  _params: PipelineParams // eslint-disable-line @typescript-eslint/no-unused-vars
): PixelFrameRGBA {
  return frame;
}
