/**
 * Export stage: write PixelFrameRGBA to canvas or produce ImageData.
 * No scaling; caller controls canvas element size for display.
 */

import type { PixelFrameRGBA } from "./types";

/**
 * Create ImageData from a frame (e.g. for putImageData or export blob).
 */
export function frameToImageData(frame: PixelFrameRGBA): ImageData {
  return new ImageData(
    new Uint8ClampedArray(frame.data),
    frame.width,
    frame.height
  );
}

/**
 * Draw frame to canvas. Sets canvas width/height to frame dimensions and puts pixel data.
 */
export function exportToCanvas(
  frame: PixelFrameRGBA,
  canvas: HTMLCanvasElement
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  canvas.width = frame.width;
  canvas.height = frame.height;
  const imageData = frameToImageData(frame);
  ctx.putImageData(imageData, 0, 0);
}
