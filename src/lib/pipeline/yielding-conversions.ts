import { yieldToMain } from "@/lib/yield-to-main";
import { linearRgbToSrgb8 } from "./stages/oklab";
import type { PixelFrameF32, PixelFrameRGBA } from "./types";

const DEFAULT_PIXELS_PER_CHUNK = 256 * 1024;

/**
 * Same output as pixelFrameF32ToPixelFrameRGBA, but yields between chunks so
 * the main thread can paint and run timers during large-frame conversion.
 */
export async function pixelFrameF32ToPixelFrameRGBAAsync(
  frame: PixelFrameF32,
  pixelsPerChunk: number = DEFAULT_PIXELS_PER_CHUNK
): Promise<PixelFrameRGBA> {
  const { width, height, data } = frame;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const stride = 4;
  const chunkBytes = Math.max(stride, pixelsPerChunk * stride);

  for (let start = 0; start < data.length; start += chunkBytes) {
    const end = Math.min(data.length, start + chunkBytes);
    for (let i = start; i < end; i += stride) {
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
      rgba[i + 3] = Number.isFinite(a)
        ? Math.round(Math.max(0, Math.min(255, a * 255)))
        : 255;
    }
    if (end < data.length) {
      await yieldToMain();
    }
  }

  return { width, height, data: rgba };
}
