/**
 * Single orchestrator: source + reference + params → final PixelFrameRGBA.
 * Uses linear float pipeline; quantizes to 8-bit only at the end.
 *
 * decode is imported dynamically so webpack does not statically pull libraw-wasm
 * into server-side bundles (which crashes V8 during chunk-graph processing).
 */

import { processFramesFloat } from "./processFrames";
import { srgb8ToLinear } from "./stages/oklab";
import type { DecodeInput, PipelineParams, PixelFrameF32, PixelFrameRGBA } from "./types";
import { allocPixelFrameF32, pixelFrameF32ToPixelFrameRGBA } from "./types";

function rgbaToLinearFloat(rgba: PixelFrameRGBA): PixelFrameF32 {
  const { width, height, data } = rgba;
  const out = allocPixelFrameF32(width, height);
  for (let i = 0; i < data.length; i += 4) {
    out.data[i] = srgb8ToLinear(data[i] ?? 0);
    out.data[i + 1] = srgb8ToLinear(data[i + 1] ?? 0);
    out.data[i + 2] = srgb8ToLinear(data[i + 2] ?? 0);
    out.data[i + 3] = (data[i + 3] ?? 255) / 255;
  }
  return out;
}

async function decodeInputToFloat(
  input: DecodeInput
): Promise<PixelFrameF32> {
  if (typeof (input as PixelFrameRGBA).width === "number" && (input as PixelFrameRGBA).data instanceof Uint8ClampedArray) {
    return rgbaToLinearFloat(input as PixelFrameRGBA);
  }
  if (input instanceof File) {
    const { decodeToLinearFloat } = await import("./decode");
    return decodeToLinearFloat(input);
  }
  throw new Error("Invalid DecodeInput: expected File or PixelFrameRGBA");
}

/**
 * Run the full pipeline and return the resulting RGBA frame.
 * Uses linear float pipeline internally; quantizes to 8-bit at the end.
 */
export async function processOne(
  source: DecodeInput,
  reference: DecodeInput | null,
  params: PipelineParams
): Promise<PixelFrameRGBA> {
  const decodedSource = await decodeInputToFloat(source);
  const decodedRef = reference ? await decodeInputToFloat(reference) : null;
  const resultFloat = processFramesFloat(decodedSource, decodedRef, params);
  return pixelFrameF32ToPixelFrameRGBA(resultFloat);
}

// processFrames lives in ./processFrames.ts so server routes can import it
// without loading this file (and its dynamic import of ./decode).
