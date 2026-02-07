/**
 * Pipeline internal formats and parameters.
 * Row-major RGBA, same layout as ImageData.data.
 */

export interface PixelFrameRGBA {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Optional float frame for future math-heavy stages (e.g. match in OKLab).
 * Not required for V1; use when a stage needs linear/float workflow.
 */
export interface PixelFrameF32 {
  width: number;
  height: number;
  data: Float32Array;
}

/** Allocate a new F32 frame (e.g. for convert then process). */
export function allocPixelFrameF32(
  width: number,
  height: number
): PixelFrameF32 {
  return {
    width,
    height,
    data: new Float32Array(width * height * 4),
  };
}

/**
 * Input to decode stage: either a File (JPG/PNG) or already-decoded frame.
 * Pass PixelFrameRGBA when re-running with new params to skip re-decode.
 * DNG/RAW: extend with a stub type later; decode will branch and throw "not implemented".
 */
export type DecodeInput = File | PixelFrameRGBA;

import type { LookParams as GradingParams } from "./stages/match";
export type { GradingParams };

export interface PipelineParams {
  strength?: number;
  /** Optional grading params from UI; when present, used instead of fitting from reference. */
  grading?: GradingParams;
  // Extensible; no UI-specific fields.
}
