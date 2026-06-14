import type { PixelFrameF32 } from "@/src/lib/pipeline/types";

/** Long edge cap for Lab2 live post–M2 preview (matches canvas PREVIEW_MAX_EDGE). */
export const PREVIEW_LIVE_MAX_EDGE = 1600;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Nearest-neighbor downscale by uniform scale factor (no upscale). */
export function downscaleLinearFloatByScale(
  frame: PixelFrameF32,
  scale: number
): PixelFrameF32 {
  const s = clamp(scale, 0.1, 1);
  if (s >= 0.999) {
    return {
      width: frame.width,
      height: frame.height,
      data: new Float32Array(frame.data),
    };
  }
  const dstW = Math.max(1, Math.round(frame.width * s));
  const dstH = Math.max(1, Math.round(frame.height * s));
  const dst = new Float32Array(dstW * dstH * 4);
  const sx = frame.width / dstW;
  const sy = frame.height / dstH;
  for (let y = 0; y < dstH; y++) {
    const srcY = Math.min(frame.height - 1, Math.floor(y * sy));
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(frame.width - 1, Math.floor(x * sx));
      const si = (srcY * frame.width + srcX) * 4;
      const di = (y * dstW + x) * 4;
      dst[di] = frame.data[si] ?? 0;
      dst[di + 1] = frame.data[si + 1] ?? 0;
      dst[di + 2] = frame.data[si + 2] ?? 0;
      dst[di + 3] = frame.data[si + 3] ?? 1;
    }
  }
  return { width: dstW, height: dstH, data: dst };
}

/** Downscale so max(width, height) ≤ maxLongEdge; returns a copy when already small enough. */
export function downscaleLinearFloatMaxEdge(
  frame: PixelFrameF32,
  maxLongEdge: number
): PixelFrameF32 {
  const longEdge = Math.max(frame.width, frame.height);
  if (longEdge <= maxLongEdge) {
    return {
      width: frame.width,
      height: frame.height,
      data: new Float32Array(frame.data),
    };
  }
  return downscaleLinearFloatByScale(frame, maxLongEdge / longEdge);
}
