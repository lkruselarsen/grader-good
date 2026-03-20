/**
 * Model 2: Reinhard-style color transfer in OKLab.
 * Per-channel mean/std matching. Robust sampling excludes near-clipped pixels.
 */

import { linearRgbToOklab, oklabToLinearRgb } from "./oklab";
import type { PixelFrameF32, PixelFrameRGBA, PipelineParams } from "../types";
import { allocPixelFrameF32, pixelFrameF32ToPixelFrameRGBA } from "../types";

function computeStats(
  data: Float32Array,
  robust: boolean
): { mean: [number, number, number]; std: [number, number, number]; count: number } {
  const n = data.length >> 2;
  const lArr: number[] = [];
  const aArr: number[] = [];
  const bArr: number[] = [];
  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const r = data[idx] ?? 0;
    const g = data[idx + 1] ?? 0;
    const b = data[idx + 2] ?? 0;
    const oklab = linearRgbToOklab(r, g, b);
    if (robust) {
      const L = oklab.L;
      if (L < 0.02 || L > 0.98) continue;
    }
    lArr.push(oklab.L);
    aArr.push(oklab.a);
    bArr.push(oklab.b);
  }
  const count = lArr.length;
  const meanL = count > 0 ? lArr.reduce((a, b) => a + b, 0) / count : 0;
  const meanA = count > 0 ? aArr.reduce((a, b) => a + b, 0) / count : 0;
  const meanB = count > 0 ? bArr.reduce((a, b) => a + b, 0) / count : 0;
  const stdL = count > 0
    ? Math.sqrt(lArr.reduce((s, v) => s + (v - meanL) ** 2, 0) / count) || 1e-6
    : 1;
  const stdA = count > 0
    ? Math.sqrt(aArr.reduce((s, v) => s + (v - meanA) ** 2, 0) / count) || 1e-6
    : 1;
  const stdB = count > 0
    ? Math.sqrt(bArr.reduce((s, v) => s + (v - meanB) ** 2, 0) / count) || 1e-6
    : 1;
  return { mean: [meanL, meanA, meanB], std: [stdL, stdA, stdB], count };
}

/**
 * Reinhard-style transfer: out = (src - mean_src) * (std_ref / std_src) + mean_ref.
 * Operates per-channel in OKLab.
 */
export function applyFloatModel2(
  source: PixelFrameF32,
  reference: PixelFrameF32 | null,
  params: PipelineParams
): PixelFrameF32 {
  const strength = params.model2Strength ?? 1;
  const robust = params.model2RobustSampling ?? true;

  if (!reference) {
    return source;
  }

  const srcStats = computeStats(source.data, robust);
  const refStats = computeStats(reference.data, robust);

  const [meanSrcL, meanSrcA, meanSrcB] = srcStats.mean;
  const [stdSrcL, stdSrcA, stdSrcB] = srcStats.std;
  const [meanRefL, meanRefA, meanRefB] = refStats.mean;
  const [stdRefL, stdRefA, stdRefB] = refStats.std;

  const ratioL = stdSrcL > 1e-8 ? stdRefL / stdSrcL : 1;
  const ratioA = stdSrcA > 1e-8 ? stdRefA / stdSrcA : 1;
  const ratioB = stdSrcB > 1e-8 ? stdRefB / stdSrcB : 1;

  const out = allocPixelFrameF32(source.width, source.height);
  const n = source.width * source.height;

  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const r = source.data[idx] ?? 0;
    const g = source.data[idx + 1] ?? 0;
    const b = source.data[idx + 2] ?? 0;
    const a = source.data[idx + 3];
    const oklab = linearRgbToOklab(r, g, b);

    const outL = (oklab.L - meanSrcL) * ratioL + meanRefL;
    const outA = (oklab.a - meanSrcA) * ratioA + meanRefA;
    const outB = (oklab.b - meanSrcB) * ratioB + meanRefB;

    const rgb = oklabToLinearRgb(outL, outA, outB);

    const s = Math.max(0, Math.min(1, strength));
    out.data[idx] = (1 - s) * r + s * rgb.r;
    out.data[idx + 1] = (1 - s) * g + s * rgb.g;
    out.data[idx + 2] = (1 - s) * b + s * rgb.b;
    out.data[idx + 3] = Number.isFinite(a) ? a : 1;
  }

  return out;
}

/** sRGB 0-255 to linear 0-1 */
function srgb8ToLinear(c: number): number {
  const c01 = c / 255;
  return c01 <= 0.04045 ? c01 / 12.92 : ((c01 + 0.055) / 1.055) ** 2.4;
}

/** Convert PixelFrameRGBA (sRGB) to PixelFrameF32 (linear) */
function rgbaToLinearFloat(rgba: PixelFrameRGBA): PixelFrameF32 {
  const { width, height, data } = rgba;
  const n = width * height * 4;
  const floatData = new Float32Array(n);
  for (let i = 0; i < data.length; i += 4) {
    floatData[i] = srgb8ToLinear(data[i] ?? 0);
    floatData[i + 1] = srgb8ToLinear(data[i + 1] ?? 0);
    floatData[i + 2] = srgb8ToLinear(data[i + 2] ?? 0);
    floatData[i + 3] = (data[i + 3] ?? 255) / 255;
  }
  return { width, height, data: floatData };
}

/**
 * 8-bit path: convert to linear float, run transfer, convert back.
 */
export function applyModel2(
  source: PixelFrameRGBA,
  reference: PixelFrameRGBA | null,
  params: PipelineParams
): PixelFrameRGBA {
  const srcFloat = rgbaToLinearFloat(source);
  const refFloat = reference ? rgbaToLinearFloat(reference) : null;
  const resultFloat = applyFloatModel2(srcFloat, refFloat, params);
  return pixelFrameF32ToPixelFrameRGBA(resultFloat);
}
