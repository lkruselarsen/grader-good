/**
 * Server-safe pipeline: match → halation → grain only.
 * No decode step, no dependency on ./decode or libraw-wasm.
 *
 * Use in API routes (e.g. /api/train/openai-loop) where frames are already
 * decoded via decodeBuffer/decodeBufferLinear. Import from this file or from
 * the pipeline barrel so that processOne.ts (and its dynamic import of ./decode)
 * is never loaded in the server bundle — avoiding the V8 crash
 * "Fatal JavaScript invalid size error 169220804" during webpack chunk processing.
 */

import { grain } from "./grain";
import { halation } from "./halation";
import { match } from "./match";
import type { PipelineParams, PixelFrameRGBA } from "./types";

export function processFrames(
  source: PixelFrameRGBA,
  reference: PixelFrameRGBA | null,
  params: PipelineParams
): PixelFrameRGBA {
  const afterMatch = match(source, reference, params);
  const afterHalation = halation(afterMatch, params);
  const afterGrain = grain(afterHalation, params);
  return afterGrain;
}
