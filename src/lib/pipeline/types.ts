/**
 * Pipeline internal formats and parameters.
 * Row-major RGBA, same layout as ImageData.data.
 */

import { linearRgbToSrgb8 } from "./stages/oklab";

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

/** Quantize PixelFrameF32 (linear float) to PixelFrameRGBA (sRGB 8-bit) for export/canvas. */
export function pixelFrameF32ToPixelFrameRGBA(
  frame: PixelFrameF32
): PixelFrameRGBA {
  const { width, height, data } = frame;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3];
    const rgb = linearRgbToSrgb8(
      Math.max(0, Math.min(1, r)),
      Math.max(0, Math.min(1, g)),
      Math.max(0, Math.min(1, b))
    );
    rgba[i] = rgb.r;
    rgba[i + 1] = rgb.g;
    rgba[i + 2] = rgb.b;
    rgba[i + 3] = Number.isFinite(a) ? Math.round(Math.max(0, Math.min(255, a * 255))) : 255;
  }
  return { width, height, data: rgba };
}

/**
 * Input to decode stage: either a File (JPG/PNG) or already-decoded frame.
 * Pass PixelFrameRGBA when re-running with new params to skip re-decode.
 * DNG/RAW: extend with a stub type later; decode will branch and throw "not implemented".
 */
export type DecodeInput = File | PixelFrameRGBA;

import type { LookParams as GradingParams } from "./stages/match";
export type { GradingParams };

/** Optional context about match-stage exposure changes (for dampening halation in lifted regions). */
export interface MatchExposureContext {
  exposureStrength?: number;
  exposureCurve?: { L_in: number[]; L_out: number[] };
}

export interface PipelineParams {
  strength?: number;
  /** Optional grading params from UI; when present, used instead of fitting from reference. */
  grading?: GradingParams;
  /** Optional exposure map from RAW linear decode. Used exclusively for halation boundaries. */
  exposureMap?: import("./exposureMap").ExposureMap; // avoid circular import
  /** Optional match exposure context for dampening halation in lifted regions. */
  matchExposureContext?: MatchExposureContext;
  /**
   * Optional 5-band L anchors [lowerShadow, upperShadow, mid, lowerHigh, upperHigh].
   * When present, used instead of fixed [0.08, 0.25, 0.5, 0.7, 0.9] for band weights.
   * Set from post-exposure result percentiles in phased training.
   */
  colorBandAnchors?: number[];
  /**
   * Match model: 1 = OKLab color engine (default), 2 = Reinhard-style transfer.
   * When 2, model2Strength and model2RobustSampling are used.
   */
  matchModel?: 1 | 2;
  /** Model 2: blend strength 0–1. Default 1 (full transfer). */
  model2Strength?: number;
  /** Model 2: exclude L<0.02 or L>0.98 when computing mean/std. Default true. */
  model2RobustSampling?: boolean;
  // Extensible; no UI-specific fields.
}
