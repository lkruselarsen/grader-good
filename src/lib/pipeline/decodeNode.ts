/**
 * Node-only image decode/encode using sharp.
 * RAW/DNG: when sharp fails (e.g. vips_colourspace), we decode with dcraw to TIFF then sharp.
 * Use from API routes only; do not import in client or browser code.
 */

import type { PixelFrameRGBA } from "./types";

/** Polyfill ImageData in Node so pipeline code (frameToImageData, applyLook, computeImageStats) works. */
if (typeof globalThis.ImageData === "undefined") {
  (globalThis as unknown as { ImageData: typeof ImageData }).ImageData = class ImageData {
    width: number;
    height: number;
    data: Uint8ClampedArray;
    constructor(
      dataOrWidth: Uint8ClampedArray | number,
      widthOrHeight?: number,
      height?: number
    ) {
      if (typeof dataOrWidth === "number") {
        this.width = dataOrWidth;
        this.height = widthOrHeight ?? 0;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      } else {
        this.data = dataOrWidth;
        this.width = widthOrHeight ?? 0;
        this.height = height ?? 0;
      }
    }
  } as unknown as typeof ImageData;
}

/** Normalize buffer-like input to a Node Buffer (for sharp and dcraw). */
function toBuffer(input: Buffer | ArrayBuffer | ArrayBufferView | Record<string, unknown>): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer)
    return Buffer.from(input);
  if (ArrayBuffer.isView(input))
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const obj = input as Record<string, unknown>;
  const inner = obj.buffer ?? obj.data;
  if (inner != null) return toBuffer(inner as Buffer | ArrayBuffer | ArrayBufferView);
  if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
    const first = Object.values(obj).find(
      (v) => v != null && (Buffer.isBuffer(v) || v instanceof ArrayBuffer || ArrayBuffer.isView(v))
    );
    if (first != null) return toBuffer(first as Buffer | ArrayBuffer | ArrayBufferView);
  }
  throw new Error("Expected Buffer, ArrayBuffer, ArrayBufferView, or object with .buffer/.data or buffer-like values");
}

/** Decode a buffer that sharp can handle (PNG, JPEG, TIFF, etc.) into PixelFrameRGBA. */
async function decodeWithSharp(buffer: Buffer): Promise<PixelFrameRGBA> {
  const sharp = (await import("sharp")).default;
  const buf = toBuffer(buffer);
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const arr = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  return { width, height, data: arr };
}

/**
 * Decode a PNG, JPEG, TIFF, or RAW/DNG buffer into a PixelFrameRGBA (row-major RGBA).
 * For RAW/DNG, uses dcraw to produce sRGB TIFF then sharp (when sharp fails with
 * vips_colourspace/multiband). Ensures 4 channels (adds alpha 255 if input is RGB).
 */
export async function decodeBuffer(buffer: Buffer | ArrayBuffer | ArrayBufferView): Promise<PixelFrameRGBA> {
  const buf = toBuffer(buffer);
  try {
    return await decodeWithSharp(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isRawError =
      msg.includes("vips_colourspace") ||
      msg.includes("multiband") ||
      msg.includes("no known route");
    if (!isRawError) throw err;

    // Node-side RAW path: dcraw -> sRGB TIFF -> sharp
    // dcraw has a bug (const args reassigned); the error throws when *calling* dcraw(), not on require()
    function runDcraw(): Buffer | Uint8Array | Record<string, unknown> {
      const dcraw = require("dcraw") as (
        buf: Buffer,
        opts: { exportAsTiff?: boolean; setColorSpace?: number }
      ) => Buffer | Uint8Array | Record<string, unknown>;
      return dcraw(buf, { exportAsTiff: true, setColorSpace: 1 });
    }
    let tiffBuf: Buffer | Uint8Array | Record<string, unknown>;
    try {
      tiffBuf = runDcraw();
    } catch (callErr) {
      const errMsg = callErr instanceof Error ? callErr.message : String(callErr);
      if (!errMsg.includes("Assignment to constant variable")) throw callErr;
      const { execSync } = require("child_process");
      const pathMod = require("path");
      const patchScript = pathMod.join(process.cwd(), "scripts", "patch-dcraw.js");
      execSync(`node "${patchScript}"`, { stdio: "inherit" });
      // Clear every cached module under node_modules/dcraw so patched files are reloaded.
      const dcrawResolved = require.resolve("dcraw");
      for (const key of Object.keys(require.cache)) {
        if (key.includes("node_modules") && key.includes("dcraw")) delete require.cache[key];
      }
      if (require.cache[dcrawResolved]) delete require.cache[dcrawResolved];
      tiffBuf = runDcraw();
    }
    if (!tiffBuf || typeof tiffBuf !== "object") {
      throw new Error("dcraw did not return a buffer");
    }
    const tiffBuffer = toBuffer(tiffBuf as Buffer | ArrayBuffer | ArrayBufferView | Record<string, unknown>);
    return await decodeWithSharp(tiffBuffer);
  }
}

/**
 * Resize a frame so its longest edge equals maxEdge. Uses sharp; Node-only.
 * If the frame is already smaller, returns a copy with same dimensions.
 */
export async function resizeFrame(
  frame: PixelFrameRGBA,
  maxEdge: number
): Promise<PixelFrameRGBA> {
  const sharp = (await import("sharp")).default;
  const { width, height, data } = frame;
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return { width, height, data: new Uint8ClampedArray(data) };
  }
  const scale = maxEdge / longest;
  const newW = Math.max(1, Math.round(width * scale));
  const newH = Math.max(1, Math.round(height * scale));
  const buf = Buffer.from(data);
  const { data: outBuf, info } = await sharp(buf, {
    raw: { width, height, channels: 4 },
  })
    .resize(newW, newH)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const outArr = new Uint8ClampedArray(
    outBuf.buffer,
    outBuf.byteOffset,
    outBuf.byteLength
  );
  return { width: info.width, height: info.height, data: outArr };
}

/**
 * Encode a PixelFrameRGBA to PNG buffer.
 * Optionally resize so the result stays under a target max dimension (e.g. longest edge 1536).
 * Does not guarantee a specific file size; use maxEdge to cap dimensions for API payloads.
 */
export async function frameToPngBuffer(
  frame: PixelFrameRGBA,
  options?: { maxEdge?: number; quality?: number }
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const { width, height, data } = frame;
  const buf = Buffer.from(data);
  let pipeline = sharp(buf, { raw: { width, height, channels: 4 } });
  if (options?.maxEdge && Math.max(width, height) > options.maxEdge) {
    const scale = options.maxEdge / Math.max(width, height);
    pipeline = pipeline.resize(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale))
    );
  }
  return pipeline.png().toBuffer();
}
