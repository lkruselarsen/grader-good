/**
 * Color engine: applies OKLab-based grading to pixel data.
 * Delegates to stages/match (fitLookParamsFromReference, applyLook).
 * When reference exists: fits params from it. Blends by strength 0..1.
 */

import {
  applyLook,
  defaultLookParams,
  fitLookParamsFromReference,
  type LookParams,
} from "./stages/match";
import type { PixelFrameRGBA, PipelineParams } from "./types";

/** Convert PixelFrameRGBA to ImageData (same layout: width, height, RGBA). */
function frameToImageData(frame: PixelFrameRGBA): ImageData {
  return new ImageData(
    new Uint8ClampedArray(frame.data),
    frame.width,
    frame.height
  );
}

/** Blend source and graded by strength (0 = source, 1 = graded). Per-channel in sRGB. */
function blend(
  src: Uint8ClampedArray,
  graded: Uint8ClampedArray,
  strength: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const s = Math.max(0, Math.min(1, strength));
  for (let i = 0; i < src.length; i++) {
    out[i] = Math.round((1 - s) * src[i] + s * graded[i]);
  }
  return out;
}

/**
 * Apply OKLab color grading: fit params from reference (if provided),
 * apply look, blend by strength. Returns new PixelFrameRGBA.
 * When params.grading is provided, uses it (optionally as override on fitted).
 * Otherwise fits from reference or uses defaults.
 */
export function apply(
  source: PixelFrameRGBA,
  reference: PixelFrameRGBA | null,
  params: PipelineParams
): PixelFrameRGBA {
  const strength = params.strength ?? 1;
  const sourceImageData = frameToImageData(source);

  const lookParams: LookParams =
    params.grading ??
    (reference
      ? fitLookParamsFromReference(frameToImageData(reference))
      : defaultLookParams());

  const gradedImageData = applyLook(sourceImageData, lookParams);
  const blended = blend(source.data, gradedImageData.data, strength);

  return {
    width: source.width,
    height: source.height,
    data: blended,
  };
}
