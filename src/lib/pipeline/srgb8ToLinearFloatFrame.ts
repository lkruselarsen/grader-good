import type { PixelFrameF32, PixelFrameRGBA } from "./types";

/** One sRGB 8-bit channel (0–255) to linear 0–1. */
export function srgb8ChannelToLinear(c8: number): number {
  const c = c8 / 255;
  if (c <= 0.04045) return c / 12.92;
  return ((c + 0.055) / 1.055) ** 2.4;
}

/** 8-bit sRGB RGBA (same convention as sharp/libraw sRGB output) → linear float RGBA. */
export function pixelFrameRgbaSrgb8ToLinearFloat(
  frame: PixelFrameRGBA
): PixelFrameF32 {
  const { width, height, data } = frame;
  const floatData = new Float32Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    floatData[i] = srgb8ChannelToLinear(data[i] ?? 0);
    floatData[i + 1] = srgb8ChannelToLinear(data[i + 1] ?? 0);
    floatData[i + 2] = srgb8ChannelToLinear(data[i + 2] ?? 0);
    floatData[i + 3] = (data[i + 3] ?? 255) / 255;
  }
  return { width, height, data: floatData };
}
