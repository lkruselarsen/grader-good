/**
 * Grain stage. Stub – do not implement grain logic here.
 * Passthrough: returns input unchanged.
 */

import type { PixelFrameRGBA, PipelineParams } from "./types";

export function grain(
  frame: PixelFrameRGBA,
  _params: PipelineParams // eslint-disable-line @typescript-eslint/no-unused-vars
): PixelFrameRGBA {
  return frame;
}
