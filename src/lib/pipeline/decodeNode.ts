/**
 * Node-only image decode/encode using sharp.
 * RAW/DNG: when sharp fails (e.g. vips_colourspace), we decode with dcraw to TIFF then sharp.
 * Use from API routes only; do not import in client or browser code.
 */

import type { PixelFrameF32, PixelFrameRGBA } from "./types";

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

type LightdriftLibRaw = {
  loadBuffer(buf: Buffer): Promise<boolean>;
  setOutputParams(opts: Record<string, unknown>): Promise<void>;
  processImage(): Promise<void>;
  createTIFFBuffer(opts: {
    width?: number;
    height?: number;
  }): Promise<{ success?: boolean; buffer?: Buffer }>;
  close?(): Promise<void>;
};

/** Native addon typings are not a valid ES module under strict TS. */
async function importLightdriftLibraw(): Promise<{
  default?: new () => LightdriftLibRaw;
}> {
  // @ts-expect-error lightdrift-libraw .d.ts is ambient-only, not importable as a module
  return import("lightdrift-libraw");
}

/** Decode a buffer that sharp can handle (PNG, JPEG, TIFF, etc.) into PixelFrameRGBA.
 * If maxEdge is provided, resizes so the longest edge <= maxEdge before returning,
 * avoiding ever creating a full-resolution PixelFrameRGBA in JS heap.
 */
async function decodeWithSharp(
  buffer: Buffer,
  maxEdge?: number,
  options?: { limitInputPixels?: number }
): Promise<PixelFrameRGBA> {
  const buf = toBuffer(buffer);
  if (buf.length === 0) {
    throw new Error(
      "decodeWithSharp: input buffer is empty. Image may be corrupted or truncated."
    );
  }
  const sharp = (await import("sharp")).default;
  const sharpOpts: { limitInputPixels?: number } = {};
  if (options?.limitInputPixels != null) sharpOpts.limitInputPixels = options.limitInputPixels;
  let pipeline = sharp(buf, sharpOpts).ensureAlpha();
  if (maxEdge && maxEdge > 0) {
    pipeline = pipeline.resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true });
  }
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const arr = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  return { width, height, data: arr };
}

/** Detect image extension from magic bytes for temp file resize. */
function imageExtensionFromBuffer(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
    return ".png";
  if (
    (buf[0] === 0x49 && buf[1] === 0x49) ||
    (buf[0] === 0x4d && buf[1] === 0x4d)
  )
    return ".tiff";
  return ".jpg";
}

/**
 * Resize an image buffer on disk via subprocess so sharp never decodes a full-res image.
 * Avoids V8 "invalid size" crash when libvips allocates a huge internal buffer.
 * Uses sips on macOS, ImageMagick on Linux. Works for JPEG, PNG, TIFF.
 */
async function resizeImageBufferToMaxEdge(
  imageBuffer: Buffer,
  maxEdge: number,
  ext?: string
): Promise<Buffer> {
  const fs = require("fs") as typeof import("fs");
  const os = require("os") as typeof import("os");
  const path = require("path") as typeof import("path");
  const { execSync } = require("child_process") as typeof import("child_process");

  const suffix = ext ?? imageExtensionFromBuffer(imageBuffer);
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const inputPath = path.join(tmpDir, `decode-${ts}-in${suffix}`);
  const outputPath = path.join(tmpDir, `decode-${ts}-out${suffix}`);
  const pngPath = path.join(tmpDir, `decode-${ts}-out.png`);
  try {
    fs.writeFileSync(inputPath, imageBuffer);
    const platform = process.platform;
    if (platform === "darwin") {
      try {
        execSync(`sips -Z ${maxEdge} "${inputPath}" --out "${outputPath}"`, {
          stdio: "pipe",
          maxBuffer: 100 * 1024 * 1024,
        });
        const out = fs.readFileSync(outputPath);
        return Buffer.from(out);
      } catch (sipsErr) {
        // sips failed (e.g. Unsupported output format com.adobe.raw-image); use ImageMagick.
        execSync(`convert "${inputPath}" -resize ${maxEdge}x${maxEdge}\\> "${pngPath}"`, {
          stdio: "pipe",
          maxBuffer: 100 * 1024 * 1024,
        });
        const out = fs.readFileSync(pngPath);
        return Buffer.from(out);
      }
    } else {
      execSync(`convert "${inputPath}" -resize ${maxEdge}x${maxEdge}\\> "${outputPath}"`, {
        stdio: "pipe",
        maxBuffer: 100 * 1024 * 1024,
      });
      const out = fs.readFileSync(outputPath);
      return Buffer.from(out);
    }
  } finally {
    try {
      fs.unlinkSync(inputPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(outputPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(pngPath);
    } catch {
      /* ignore */
    }
  }
}

/** Resize a TIFF buffer (convenience wrapper). */
async function resizeTiffBufferToMaxEdge(tiffBuffer: Buffer, maxEdge: number): Promise<Buffer> {
  return resizeImageBufferToMaxEdge(tiffBuffer, maxEdge, ".tiff");
}

/**
 * Try dcraw_emu (LibRaw CLI) if installed. Returns TIFF buffer on success; throws on failure.
 * Fallback when decode-raw-worker fails; dcraw_emu may support some DNGs that the npm dcraw struggles with.
 */
function runDcrawEmu(buf: Buffer): Buffer | null {
  const fs = require("fs") as typeof import("fs");
  const os = require("os") as typeof import("os");
  const path = require("path") as typeof import("path");
  const { spawnSync } = require("child_process") as typeof import("child_process");

  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const inputPath = path.join(tmpDir, `dcraw_emu-${ts}-in.dng`);
  const outputPath = inputPath + ".tiff";
  try {
    fs.writeFileSync(inputPath, buf);
    const result = spawnSync("dcraw_emu", ["-T", "-w", inputPath], {
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
    });
    if (result.status !== 0 || !fs.existsSync(outputPath)) return null;
    const tiffBuffer = fs.readFileSync(outputPath);
    if (tiffBuffer.length === 0) return null;
    return tiffBuffer;
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(inputPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(outputPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Run dcraw in a child process to isolate V8 fatal crashes.
 * Returns TIFF buffer on success; throws on failure.
 */
function runDcrawViaWorker(
  buf: Buffer,
  linear: boolean
): Buffer {
  const fs = require("fs") as typeof import("fs");
  const os = require("os") as typeof import("os");
  const path = require("path") as typeof import("path");
  const { spawnSync } = require("child_process") as typeof import("child_process");

  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const inputPath = path.join(tmpDir, `dcraw-${ts}-in.dng`);
  const outputPath = path.join(tmpDir, `dcraw-${ts}-out.tiff`);
  try {
    fs.writeFileSync(inputPath, buf);
    const scriptPath = path.join(process.cwd(), "scripts", "decode-raw-worker.js");
    const result = spawnSync(
      process.execPath,
      [scriptPath, inputPath, outputPath, linear ? "1" : "0"],
      { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 }
    );
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? result.error?.message ?? "unknown";
      throw new Error(`decode-raw-worker exited ${result.status}: ${stderr}`);
    }
    if (!fs.existsSync(outputPath)) {
      throw new Error("decode-raw-worker did not produce output file");
    }
    const tiffBuffer = fs.readFileSync(outputPath);
    if (tiffBuffer.length === 0) {
      throw new Error("decode-raw-worker produced empty file");
    }
    return tiffBuffer;
  } finally {
    try {
      fs.unlinkSync(inputPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(outputPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Decode a PNG, JPEG, TIFF, or RAW/DNG buffer into a PixelFrameRGBA (row-major RGBA).
 * For RAW/DNG, uses dcraw to produce sRGB TIFF then sharp (when sharp fails with
 * vips_colourspace/multiband). Ensures 4 channels (adds alpha 255 if input is RGB).
 * If maxEdge is provided, the decoded frame is resized (longest edge <= maxEdge) before
 * the Uint8ClampedArray is ever created, preventing full-resolution JS heap allocations.
 */
/** Max pixels we allow sharp to decode; avoids V8 "invalid size" (plain-array limit). */
const SAFE_PIXEL_CAP = 268402689;

/** Stricter cap for RAW dcraw output (~80MB); avoids V8 GrowArrayElements crash 169220804. */
const RAW_TIFF_MAX_BYTES = 80 * 1024 * 1024;

/** Buffer size above which we pre-resize via subprocess before sharp to avoid V8 crash. */
const LARGE_BUFFER_THRESHOLD = 15 * 1024 * 1024;

export async function decodeBuffer(
  buffer: Buffer | ArrayBuffer | ArrayBufferView,
  maxEdge?: number
): Promise<PixelFrameRGBA> {
  const buf = toBuffer(buffer);
  const safePixelLimit =
    maxEdge != null ? Math.min(SAFE_PIXEL_CAP, maxEdge * maxEdge) : undefined;

  // JPEG and PNG: skip RAW path entirely; sharp handles them with limitInputPixels.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    if (buf.length > LARGE_BUFFER_THRESHOLD) {
      const resized = await resizeImageBufferToMaxEdge(buf, maxEdge ?? 1200, ".jpg");
      return await decodeWithSharp(resized, maxEdge);
    }
    try {
      return await decodeWithSharp(buf, maxEdge, {
        limitInputPixels: safePixelLimit,
      });
    } catch (jpegErr) {
      const msg = jpegErr instanceof Error ? jpegErr.message : String(jpegErr);
      const hitPixelLimit =
        msg.includes("pixel") ||
        msg.includes("limit") ||
        msg.includes("dimensions") ||
        msg.includes("too many");
      if (hitPixelLimit) {
        const resized = await resizeImageBufferToMaxEdge(buf, maxEdge ?? 1200, ".jpg");
        return await decodeWithSharp(resized, maxEdge);
      }
      throw jpegErr;
    }
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    if (buf.length > LARGE_BUFFER_THRESHOLD) {
      const resized = await resizeImageBufferToMaxEdge(buf, maxEdge ?? 1200, ".png");
      return await decodeWithSharp(resized, maxEdge);
    }
    try {
      return await decodeWithSharp(buf, maxEdge, {
        limitInputPixels: safePixelLimit,
      });
    } catch (pngErr) {
      const msg = pngErr instanceof Error ? pngErr.message : String(pngErr);
      const hitPixelLimit =
        msg.includes("pixel") ||
        msg.includes("limit") ||
        msg.includes("dimensions") ||
        msg.includes("too many");
      if (hitPixelLimit) {
        const resized = await resizeImageBufferToMaxEdge(buf, maxEdge ?? 1200, ".png");
        return await decodeWithSharp(resized, maxEdge);
      }
      throw pngErr;
    }
  }

  // TIFF-based RAW (DNG, CR2, NEF, etc.): skip sharp probe; go straight to dcraw.
  const skipSharpProbe = looksLikeTiffBasedRaw(buf);

  if (!skipSharpProbe) {
    if (buf.length > LARGE_BUFFER_THRESHOLD) {
      const resized = await resizeImageBufferToMaxEdge(buf, maxEdge ?? 1200);
      return await decodeWithSharp(resized, maxEdge);
    }
    try {
      const result = await decodeWithSharp(buf, maxEdge, {
        limitInputPixels: safePixelLimit,
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hitPixelLimit =
        msg.includes("pixel") ||
        msg.includes("limit") ||
        msg.includes("dimensions") ||
        msg.includes("too many");
      if (hitPixelLimit) {
        try {
          const resized = await resizeImageBufferToMaxEdge(buf, maxEdge ?? 1200);
          return await decodeWithSharp(resized, maxEdge);
        } catch (_resizeErr) {
          // Resize failed (e.g. sips doesn't support DNG/RAW); fall through to dcraw.
        }
      }
      const isRawError =
        msg.includes("vips_colourspace") ||
        msg.includes("multiband") ||
        msg.includes("no known route");
      const tryRawPath = isRawError || hitPixelLimit;
      if (!tryRawPath) throw err;
    }
  }

  // RAW path: dcraw in child process -> sRGB TIFF -> sharp. On dcraw failure, fall back.
  try {
    const tiffBuffer = runDcrawViaWorker(buf, false);
    if (tiffBuffer.length === 0) {
      throw new Error("dcraw returned empty buffer");
    }
    if (tiffBuffer.length > RAW_TIFF_MAX_BYTES) {
      throw new Error(`dcraw returned oversized TIFF (${(tiffBuffer.length / (1024 * 1024)).toFixed(1)}MB > ${RAW_TIFF_MAX_BYTES / (1024 * 1024)}MB cap)`);
    }
    // Always pre-resize dcraw TIFF so sharp never receives full-size; avoids V8 crash.
    const edge = maxEdge ?? 1200;
    const resized = await resizeTiffBufferToMaxEdge(tiffBuffer, edge);
    return await decodeWithSharp(resized, maxEdge);
  } catch (rawErr) {
    // dcraw worker failed. Try dcraw_emu (LibRaw CLI) if installed.
    const dcrawEmuResult = runDcrawEmu(buf);
    if (dcrawEmuResult != null && dcrawEmuResult.length > 0 && dcrawEmuResult.length <= RAW_TIFF_MAX_BYTES) {
      const edge = maxEdge ?? 1200;
      const resized = await resizeTiffBufferToMaxEdge(dcrawEmuResult, edge);
      return await decodeWithSharp(resized, maxEdge);
    }
    // dcraw/LibRaw failed. Pre-resize via subprocess so sharp never receives full-size buffer.
    const edge = maxEdge ?? 1200;
    try {
      const resized = await resizeImageBufferToMaxEdge(buf, edge);
      return await decodeWithSharp(resized, maxEdge);
    } catch (fallbackErr) {
      const rawMsg = rawErr instanceof Error ? rawErr.message : String(rawErr);
      const fromWorker = rawMsg.includes("decode-raw-worker");
      const hint =
        "For DNG: sips/ImageMagick may not support this RAW. Install LibRaw CLI (dcraw_emu) for broader support.";
      const parts = [
        fromWorker
          ? "RAW decode failed (decode-raw-worker)."
          : "RAW decode failed.",
        rawMsg,
        "Fallback (resize+sharp) also failed.",
        hint,
      ];
      throw new Error(parts.join(" "));
    }
  }
}

/**
 * Decode a RAW buffer to linear RGB (16-bit linear from dcraw, then sharp).
 * Use for exposure map extraction. Returns null if the buffer is not RAW (sharp succeeds).
 * When null, use buildExposureMapFromSrgb on the regular decode output instead.
 * If maxEdge is provided, the decoded frame is resized during decode (never a full-res JS array).
 */
/**
 * Decode a RAW buffer via lightdrift-libraw (LibRaw native addon).
 * Returns PixelFrameRGBA or null on failure (caller can fall back to dcraw).
 * Uses camera WB, sRGB output, no auto-brightening to match libraw-wasm.
 */
export async function decodeBufferViaLibRaw(
  buffer: Buffer | ArrayBuffer | ArrayBufferView,
  maxEdge?: number
): Promise<PixelFrameRGBA | null> {
  const buf = toBuffer(buffer);
  if (!looksLikeTiffBasedRaw(buf)) return null;

  try {
    const mod = await importLightdriftLibraw();
    const LibRaw = mod.default ?? mod;
    const libraw = new (LibRaw as new () => LightdriftLibRaw)();
    const ok = await libraw.loadBuffer(buf);
    if (!ok) return null;

    await libraw.setOutputParams({
      output_color: 1, // sRGB
      no_auto_bright: true,
      output_tiff: true,
    });
    await libraw.processImage();
    const result = await libraw.createTIFFBuffer({
      width: maxEdge && maxEdge > 0 ? maxEdge : undefined,
      height: maxEdge && maxEdge > 0 ? maxEdge : undefined,
    });
    await libraw.close?.();

    if (!result?.success || !result?.buffer || result.buffer.length === 0)
      return null;
    if (result.buffer.length > RAW_TIFF_MAX_BYTES) return null;

    const edge = maxEdge ?? 1200;
    const resized = await resizeTiffBufferToMaxEdge(
      Buffer.from(result.buffer),
      edge
    );
    return await decodeWithSharp(resized, maxEdge);
  } catch {
    return null;
  }
}

/**
 * Decode a RAW buffer to linear RGB via lightdrift-libraw.
 * Returns null for non-RAW or on failure.
 */
export async function decodeBufferLinearViaLibRaw(
  buffer: Buffer | ArrayBuffer | ArrayBufferView,
  maxEdge?: number
): Promise<PixelFrameRGBA | null> {
  const buf = toBuffer(buffer);
  if (!looksLikeTiffBasedRaw(buf)) return null;

  try {
    const mod = await importLightdriftLibraw();
    const LibRaw = mod.default ?? mod;
    const libraw = new (LibRaw as new () => LightdriftLibRaw)();
    const ok = await libraw.loadBuffer(buf);
    if (!ok) return null;

    await libraw.setOutputParams({
      output_color: 0, // raw/linear
      no_auto_bright: true,
      output_tiff: true,
    });
    await libraw.processImage();
    const result = await libraw.createTIFFBuffer({
      width: maxEdge && maxEdge > 0 ? maxEdge : undefined,
      height: maxEdge && maxEdge > 0 ? maxEdge : undefined,
    });
    await libraw.close?.();

    if (!result?.success || !result?.buffer || result.buffer.length === 0)
      return null;
    if (result.buffer.length > RAW_TIFF_MAX_BYTES) return null;

    const edge = maxEdge ?? 1200;
    const resized = await resizeTiffBufferToMaxEdge(
      Buffer.from(result.buffer),
      edge
    );
    return await decodeWithSharp(resized, maxEdge);
  } catch {
    return null;
  }
}

/** TIFF-based (II/MM + magic 42). DNG, CR2, NEF, etc. Skip sharp probe; go straight to dcraw. */
function looksLikeTiffBasedRaw(buf: Buffer): boolean {
  if (!buf || buf.length < 4) return false;
  const isTiff =
    (buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d);
  if (!isTiff) return false;
  const magic =
    buf[0] === 0x49 && buf[1] === 0x49
      ? buf.readUInt16LE(2)
      : buf.readUInt16BE(2);
  return magic === 42;
}

/** sRGB 0-255 to linear 0-1. */
function srgb8ToLinear(c8: number): number {
  const c = c8 / 255;
  if (c <= 0.04045) return c / 12.92;
  return ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Convert PixelFrameRGBA (8-bit sRGB) to PixelFrameF32 (linear float).
 */
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
 * Convert PixelFrameRGBA (8-bit linear, from RAW linear decode) to PixelFrameF32.
 */
function rgbaLinearToFloat(rgba: PixelFrameRGBA): PixelFrameF32 {
  const { width, height, data } = rgba;
  const n = width * height * 4;
  const floatData = new Float32Array(n);
  for (let i = 0; i < data.length; i += 4) {
    floatData[i] = (data[i] ?? 0) / 255;
    floatData[i + 1] = (data[i + 1] ?? 0) / 255;
    floatData[i + 2] = (data[i + 2] ?? 0) / 255;
    floatData[i + 3] = 1;
  }
  return { width, height, data: floatData };
}

/**
 * Decode buffer to linear float (PixelFrameF32).
 * - RAW: uses lightdrift-libraw ONLY. No dcraw, no Sharp. Throws on failure.
 * - Non-RAW: decodes to sRGB 8-bit via Sharp, converts to linear float.
 */
export async function decodeBufferToLinearFloat(
  buffer: Buffer | ArrayBuffer | ArrayBufferView,
  maxEdge?: number
): Promise<PixelFrameF32> {
  const buf = toBuffer(buffer);

  if (looksLikeTiffBasedRaw(buf)) {
    const linearRgba = await decodeBufferLinearViaLibRawStrict(buf, maxEdge);
    return rgbaLinearToFloat(linearRgba);
  }

  const rgba = await decodeBuffer(buf, maxEdge);
  return rgbaToLinearFloat(rgba);
}

/**
 * Decode RAW buffer to linear RGB via lightdrift-libraw. No fallbacks.
 * Throws on failure. Used by training loop so server matches Lab (full RAW only).
 */
export async function decodeBufferLinearViaLibRawStrict(
  buffer: Buffer | ArrayBuffer | ArrayBufferView,
  maxEdge?: number
): Promise<PixelFrameRGBA> {
  const buf = toBuffer(buffer);
  if (!looksLikeTiffBasedRaw(buf)) {
    throw new Error("decodeBufferLinearViaLibRawStrict: input is not TIFF-based RAW (DNG/CR2/NEF)");
  }

  try {
    const mod = await importLightdriftLibraw();
    const LibRaw = mod.default ?? mod;
    const libraw = new (LibRaw as new () => LightdriftLibRaw)();
    const ok = await libraw.loadBuffer(buf);
    if (!ok) {
      await libraw.close?.();
      throw new Error("lightdrift-libraw: loadBuffer failed. RAW file may be corrupted or unsupported.");
    }

    await libraw.setOutputParams({
      output_color: 0, // raw/linear
      no_auto_bright: true,
      output_tiff: true,
    });
    await libraw.processImage();
    const result = await libraw.createTIFFBuffer({
      width: maxEdge && maxEdge > 0 ? maxEdge : undefined,
      height: maxEdge && maxEdge > 0 ? maxEdge : undefined,
    });
    await libraw.close?.();

    if (!result?.success || !result?.buffer || result.buffer.length === 0) {
      throw new Error("lightdrift-libraw: createTIFFBuffer failed or returned empty. No fallback.");
    }
    if (result.buffer.length > RAW_TIFF_MAX_BYTES) {
      throw new Error(
        `lightdrift-libraw: TIFF too large (${(result.buffer.length / (1024 * 1024)).toFixed(1)}MB > ${RAW_TIFF_MAX_BYTES / (1024 * 1024)}MB cap)`
      );
    }

    const tiffBuf = Buffer.from(result.buffer);
    if (maxEdge != null && maxEdge > 0) {
      const resized = await resizeTiffBufferToMaxEdge(tiffBuf, maxEdge);
      return await decodeWithSharp(resized, maxEdge);
    }
    return await decodeWithSharp(tiffBuf, undefined);
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error(
      "lightdrift-libraw RAW decode failed. Install/verify lightdrift-libraw. No dcraw or Sharp fallback."
    );
  }
}

export async function decodeBufferLinear(
  buffer: Buffer | ArrayBuffer | ArrayBufferView,
  maxEdge?: number
): Promise<PixelFrameRGBA | null> {
  const buf = toBuffer(buffer);
  // JPEG and PNG are never RAW; return null without touching sharp.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return null;
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
    return null;
  // TIFF-based (DNG, CR2, NEF, etc.): skip probe entirely. Sharp never sees the
  // raw buffer — metadata() still triggers V8 crash on large DNG. Go straight to dcraw.
  if (!looksLikeTiffBasedRaw(buf)) {
    const probePixelLimit = Math.min(SAFE_PIXEL_CAP, 64 * 64);
    try {
      const sharp = (await import("sharp")).default;
      await sharp(buf, { limitInputPixels: probePixelLimit }).metadata();
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRawError =
        msg.includes("vips_colourspace") ||
        msg.includes("multiband") ||
        msg.includes("no known route");
      const hitPixelLimit =
        msg.includes("pixel") ||
        msg.includes("limit") ||
        msg.includes("dimensions") ||
        msg.includes("too many");
      if (!isRawError && !hitPixelLimit) throw err;
    }
  }

  try {
    const tiffBuffer = runDcrawViaWorker(buf, true);
    if (tiffBuffer.length === 0 || tiffBuffer.length > RAW_TIFF_MAX_BYTES) return null;
    const edge = maxEdge ?? 1200;
    const resized = await resizeTiffBufferToMaxEdge(tiffBuffer, edge);
    return await decodeWithSharp(resized, maxEdge);
  } catch {
    return null;
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
 * Crop a frame to a rectangular region and encode to PNG buffer.
 * Bounds are clamped to frame dimensions.
 */
export async function cropFrameToPngBuffer(
  frame: PixelFrameRGBA,
  x: number,
  y: number,
  w: number,
  h: number
): Promise<Buffer> {
  const { width, height, data } = frame;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const w0 = Math.min(width - x0, Math.max(1, Math.floor(w)));
  const h0 = Math.min(height - y0, Math.max(1, Math.floor(h)));

  const cropped = new Uint8ClampedArray(w0 * h0 * 4);
  for (let row = 0; row < h0; row++) {
    const srcRow = (y0 + row) * width;
    const dstRow = row * w0;
    for (let col = 0; col < w0; col++) {
      const srcIdx = (srcRow + (x0 + col)) * 4;
      const dstIdx = (dstRow + col) * 4;
      cropped[dstIdx] = data[srcIdx] ?? 0;
      cropped[dstIdx + 1] = data[srcIdx + 1] ?? 0;
      cropped[dstIdx + 2] = data[srcIdx + 2] ?? 0;
      cropped[dstIdx + 3] = data[srcIdx + 3] ?? 255;
    }
  }
  const cropFrame: PixelFrameRGBA = { width: w0, height: h0, data: cropped };
  return frameToPngBuffer(cropFrame);
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
  const { width, height, data } = frame;
  const expectedLen = width * height * 4;
  if (width <= 0 || height <= 0 || !data || data.length < expectedLen) {
    throw new Error(
      `frameToPngBuffer: invalid frame (width=${width} height=${height} data.length=${data?.length ?? 0} expected=${expectedLen})`
    );
  }
  // Make an explicit copy so sharp can't see a surprising backing store/view.
  // (Uint8ClampedArray views can sometimes have unexpected offsets/lengths.)
  const buf = Buffer.from(data.slice(0, expectedLen));
  if (buf.length === 0) {
    throw new Error(
      `frameToPngBuffer: Buffer.from(data) produced empty buffer (width=${width} height=${height})`
    );
  }
  const sharp = (await import("sharp")).default;
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
