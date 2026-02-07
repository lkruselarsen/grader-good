/**
 * Decode stage: file or existing frame → PixelFrameRGBA.
 * JPG/PNG only. DNG/RAW: hook in place, not implemented.
 * Main-thread only (Image + canvas) for iPhone Safari; no workers, OffscreenCanvas, or WASM.
 */

import type { DecodeInput, PixelFrameRGBA } from "./types";

const JPG_PNG = ["image/jpeg", "image/png"];

function isJpegOrPng(file: File): boolean {
  if (file.type && JPG_PNG.includes(file.type)) return true;
  const name = (file.name || "").toLowerCase();
  return name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png");
}

/**
 * Load a File (JPG/PNG) into a bitmap then read RGBA via 2D canvas.
 * DNG/RAW: when DecodeInput is extended (e.g. RawFile), branch here and throw "DNG/RAW not implemented".
 */
async function decodeFile(file: File): Promise<PixelFrameRGBA> {
  if (!isJpegOrPng(file)) {
    throw new Error(`Unsupported format: ${file.type || file.name}. Only JPG and PNG are supported.`);
  }

  const url = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });

  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);
  return {
    width: w,
    height: h,
    data: imageData.data,
  };
}

/**
 * Decode input to PixelFrameRGBA.
 * - PixelFrameRGBA: returned as-is (downstream stages that mutate must copy when needed for safe re-run).
 * - File: must be JPG or PNG; decoded on main thread.
 * - DNG/RAW: not implemented; extend DecodeInput and branch in decodeFile to throw.
 */
export async function decode(input: DecodeInput): Promise<PixelFrameRGBA> {
  if (typeof (input as PixelFrameRGBA).width === "number" && (input as PixelFrameRGBA).data instanceof Uint8ClampedArray) {
    return input as PixelFrameRGBA;
  }
  if (input instanceof File) {
    return decodeFile(input);
  }
  throw new Error("Invalid DecodeInput: expected File or PixelFrameRGBA");
}
