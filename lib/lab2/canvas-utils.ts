import {
  frameToImageData,
  pixelFrameF32ToPixelFrameRGBA,
  type PixelFrameF32,
} from "@/src/lib/pipeline";
import type { RgbaFrame } from "./types";

export function isValidPixelFrameF32(
  frame: PixelFrameF32 | null | undefined
): frame is PixelFrameF32 {
  if (!frame) return false;
  const { width, height, data } = frame;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width <= 0 || height <= 0) return false;
  const n = width * height * 4;
  if (!Number.isFinite(n) || n <= 0 || n > 0x7fffffff) return false;
  return data instanceof Float32Array && data.length >= n;
}

export function isValidRgbaFrame(
  frame: { width: number; height: number; data: Uint8ClampedArray } | null | undefined
): frame is RgbaFrame {
  if (!frame) return false;
  const { width, height, data } = frame;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width <= 0 || height <= 0) return false;
  const n = width * height * 4;
  if (!Number.isFinite(n) || n <= 0 || n > 0x7fffffff) return false;
  return data instanceof Uint8ClampedArray && data.length >= n;
}

export function cloneRgbaFrame(frame: RgbaFrame): RgbaFrame {
  return {
    width: frame.width,
    height: frame.height,
    data: new Uint8ClampedArray(frame.data),
  };
}

export function drawFloatToCanvasPreview(
  floatFrame: PixelFrameF32,
  canvas: HTMLCanvasElement | null,
  maxEdge: number,
  drawCache: {
    tempCanvas: HTMLCanvasElement | null;
    imageData: ImageData | null;
    width: number;
    height: number;
  }
) {
  if (!canvas) return;
  const rgba = pixelFrameF32ToPixelFrameRGBA(floatFrame);
  drawRgbaToCanvasPreview(rgba, canvas, maxEdge, drawCache);
}

export function drawRgbaToCanvasPreview(
  rgba: { width: number; height: number; data: Uint8ClampedArray },
  canvas: HTMLCanvasElement | null,
  maxEdge: number,
  drawCache: {
    tempCanvas: HTMLCanvasElement | null;
    imageData: ImageData | null;
    width: number;
    height: number;
  }
) {
  if (!canvas || !isValidRgbaFrame(rgba)) return;
  const { width, height } = rgba;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  let temp = drawCache.tempCanvas;
  if (!temp) {
    temp = document.createElement("canvas");
    drawCache.tempCanvas = temp;
  }
  temp.width = width;
  temp.height = height;
  const tctx = temp.getContext("2d");
  if (!tctx) return;
  if (
    !drawCache.imageData ||
    drawCache.width !== width ||
    drawCache.height !== height
  ) {
    drawCache.imageData = new ImageData(
      new Uint8ClampedArray(width * height * 4),
      width,
      height
    );
    drawCache.width = width;
    drawCache.height = height;
  }
  drawCache.imageData.data.set(rgba.data);
  tctx.putImageData(drawCache.imageData, 0, 0);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(temp, 0, 0, width, height, 0, 0, w, h);
}

export async function buildThumbUrlFromFloatFrame(
  floatFrame: PixelFrameF32
): Promise<string> {
  const rgba = pixelFrameF32ToPixelFrameRGBA(floatFrame);
  const maxEdge = 250;
  const scale = Math.min(1, maxEdge / Math.max(rgba.width, rgba.height));
  const targetWidth = Math.max(1, Math.round(rgba.width * scale));
  const targetHeight = Math.max(1, Math.round(rgba.height * scale));
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = rgba.width;
  srcCanvas.height = rgba.height;
  const srcCtx = srcCanvas.getContext("2d");
  if (!srcCtx) throw new Error("No 2D context");
  srcCtx.putImageData(frameToImageData(rgba), 0, 0);
  const dstCanvas = document.createElement("canvas");
  dstCanvas.width = targetWidth;
  dstCanvas.height = targetHeight;
  const dstCtx = dstCanvas.getContext("2d");
  if (!dstCtx) throw new Error("No 2D context");
  dstCtx.imageSmoothingEnabled = true;
  dstCtx.imageSmoothingQuality = "high";
  dstCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);
  return dstCanvas.toDataURL("image/jpeg", 0.88);
}

export function makeSafeFilenamePart(name: string): string {
  const trimmed = name.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
  return safe.replace(/^-+|-+$/g, "") || "image";
}

export const defaultDrawCache = (): {
  tempCanvas: HTMLCanvasElement | null;
  imageData: ImageData | null;
  width: number;
  height: number;
} => ({ tempCanvas: null, imageData: null, width: 0, height: 0 });
