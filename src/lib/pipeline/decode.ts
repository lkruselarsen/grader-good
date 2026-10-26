/**
 * Decode stage: file or existing frame → PixelFrameRGBA.
 * - JPG/PNG: main-thread decode via Image + canvas.
 * - DNG/RAW: browser WASM via libraw-wasm (loaded at runtime from /libraw-wasm/).
 *
 * We load libraw-wasm via webpackIgnore from the public URL so webpack never
 * bundles it — avoiding the V8 "Fatal JavaScript invalid size error 169220804"
 * when webpack processes the libraw-wasm worker/WASM chunks.
 */

import type { DecodeInput, PixelFrameF32, PixelFrameRGBA } from "./types";
import { normalizeDngBaselineLinear } from "./dngBaselineLinear";
import { pixelFrameRgbaSrgb8ToLinearFloat } from "./srgb8ToLinearFloatFrame";

let librawPromise: Promise<{ default: new () => LibRawInstance }> | null = null;

/** Minimal libraw-wasm instance surface used by decodeDng. */
interface LibRawInstance {
  open(buf: Uint8Array, opts: Record<string, unknown>): Promise<void>;
  metadata(): Promise<unknown>;
  imageData(): Promise<unknown>;
}

/** Load LibRaw from public/libraw-wasm (not bundled by webpack). */
function loadLibRaw(): Promise<{ default: new () => LibRawInstance }> {
  if (librawPromise) return librawPromise;
  // Literal path so webpackIgnore applies; browser resolves against origin.
  // Not a Node-resolvable module; served from /public at runtime.
  librawPromise = import(
    /* webpackIgnore: true */
    // @ts-expect-error URL import — no TS project file at this path
    "/libraw-wasm/index.js"
  ) as Promise<{ default: new () => LibRawInstance }>;
  return librawPromise;
}

const JPG_PNG = ["image/jpeg", "image/png"];

function isJpegOrPng(file: File): boolean {
  if (file.type && JPG_PNG.includes(file.type)) return true;
  const name = (file.name || "").toLowerCase();
  return name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png");
}

function isDng(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "image/x-adobe-dng" || type === "image/dng") return true;
  const name = (file.name || "").toLowerCase();
  return name.endsWith(".dng");
}

function srgbToLinear(c8: number): number {
  const c = c8 / 255;
  if (c <= 0.04045) return c / 12.92;
  return ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(cLin: number): number {
  const c = Math.max(0, Math.min(1, cLin));
  if (c <= 0.0031308) return Math.round(c * 12.92 * 255);
  return Math.round((1.055 * c ** (1 / 2.4) - 0.055) * 255);
}

type LibRawMetadata = {
  width: number;
  height: number;
  make?: string;
  model?: string;
  cameraModel?: string;
};

/**
 * Normalize a DNG decode into a stable "baseline render" domain:
 * - Global exposure normalization so median luminance lands near a fixed target.
 * - Gentle, neutral tone mapping via standard sRGB transfer (no stylized look).
 *
 * Operates in-place on the provided PixelFrameRGBA.
 *
 * An optional gainBias can be used for per-camera tweaks (e.g. toning down
 * systematically bright RD1 exports) without changing the global heuristic.
 */
function normalizeDngBaseline(frame: PixelFrameRGBA, gainBias = 1): void {
  const { data } = frame;

  // Sample luminance over opaque pixels (subsample for speed).
  const sampleStep = 16 * 4; // every 16th pixel
  const maxSamples = Math.ceil(data.length / sampleStep) + 1;
  const ysBuf = new Float32Array(maxSamples);
  let ysCount = 0;

  for (let i = 0; i < data.length; i += sampleStep) {
    const a = data[i + 3];
    if (a < 128) continue;
    const rLin = srgbToLinear(data[i]);
    const gLin = srgbToLinear(data[i + 1]);
    const bLin = srgbToLinear(data[i + 2]);
    const y =
      0.2126 * rLin +
      0.7152 * gLin +
      0.0722 * bLin;
    ysBuf[ysCount++] = y;
  }

  if (ysCount === 0) return;

  const ys = ysBuf.subarray(0, ysCount);
  ys.sort();
  const midIdx = Math.floor(ysCount * 0.5);
  const yMid = ys[midIdx] ?? 0.18;

  // Aim the median slightly below "classic" 18% gray in display space to leave
  // more headroom for bright cameras (e.g. RD1) and avoid clipping.
  const targetMid = 0.19;
  const p90Idx = Math.floor(ysCount * 0.9);
  const yP90 = ys[p90Idx] ?? yMid;
  const targetP90 = 0.85; // keep bright detail comfortably below hard clip
  const eps = 1e-4;
  const gainMid = targetMid / Math.max(eps, yMid);
  const gainHiLimit = targetP90 / Math.max(eps, yP90);
  // Use the smaller of:
  // - gain to bring the median towards targetMid
  // - gain that keeps the 90th-percentile highlights under targetP90
  let gain = Math.min(gainMid, gainHiLimit);
  // Apply per-camera bias (e.g. dampen systematically bright RD1 exports).
  gain *= gainBias;
  // If highlights are already high, don't allow extra brightening.
  if (yP90 > targetP90) {
    gain = Math.min(gain, 1);
  }
  // Avoid extreme swings; very dark RAWs are still nudged into a common band,
  // but we cap brightening to keep baseline renders conservative.
  if (gain < 0.25) gain = 0.25;
  else if (gain > 1.3) gain = 1.3;

   // Global baseline: pull exposure down by ~1 stop universally so RAW
   // baselines sit comfortably under typical baked PNGs. This keeps plenty
   // of headroom for the matcher's exposure / luma stages.
   gain *= 0.5;

  // Apply global gain in linear space and re-encode to sRGB.
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) continue;
    const rLin = srgbToLinear(data[i]) * gain;
    const gLin = srgbToLinear(data[i + 1]) * gain;
    const bLin = srgbToLinear(data[i + 2]) * gain;
    data[i] = linearToSrgb(rLin);
    data[i + 1] = linearToSrgb(gLin);
    data[i + 2] = linearToSrgb(bLin);
  }
}

/**
 * Decode a DNG/RAW file to RGBA using libraw-wasm.
 *
 * LibRaw’s DNG pipeline already applies the DNG-spec camera color metadata:
 * - AsShotNeutral          → camera white balance
 * - ColorMatrix1/2         → camera → XYZ under Calibr. illuminants
 * - CameraCalibration1/2   → per-camera calibration
 * - ForwardMatrix1/2       → XYZ → working RGB (sRGB here)
 * - CalibrationIlluminant1/2
 *
 * By enabling camera WB + sRGB output and disabling auto-brightening / exposure
 * hacks, we get a look-neutral, camera-normalized rendering in (approximately)
 * linear sRGB suitable as the working space for the matching stage.
 */
async function decodeDng(file: File): Promise<PixelFrameRGBA> {
  try {
    const { default: LibRaw } = await loadLibRaw();
    const buf = await file.arrayBuffer();
    const raw = new LibRaw();

    // Use camera WB and sRGB output, driven only by DNG camera tags.
    // - useCameraWb: apply AsShotNeutral
    // - outputColor: 1 = sRGB using ColorMatrix/CameraCalibration/ForwardMatrix
    // - noAutoBright: true to avoid LibRaw’s auto-exposure "look"
    // - expCorrec: false to skip extra exposure correction
    //
    // This keeps the decode as a camera-normalized, look-neutral working image
    // (roughly linear sRGB prior to our OKLab-based grading).
    await raw.open(new Uint8Array(buf), {
      useCameraWb: true,
      useAutoWb: false,
      outputColor: 1, // sRGB
      outputBps: 8,
      noAutoBright: true,
      expCorrec: false,
    });

    const meta = (await raw.metadata()) as LibRawMetadata;
    const image = await raw.imageData();

    // libraw-wasm index.d.ts describes imageData() as returning RawImageData
    // with { width, height, data }. Some builds may instead return just the
    // Uint8Array, in which case we fall back to metadata() for dimensions.
    let width: number;
    let height: number;
    let rgbData: Uint8Array;

    if (
      image &&
      typeof (image as { width?: unknown }).width === "number" &&
      typeof (image as { height?: unknown }).height === "number" &&
      (image as { data?: unknown }).data instanceof Uint8Array
    ) {
      const img = image as { width: number; height: number; data: Uint8Array };
      width = img.width;
      height = img.height;
      rgbData = img.data;
    } else {
      width = meta.width;
      height = meta.height;
      rgbData = image as Uint8Array;
    }

    // Some DNG variants (e.g. certain re-exported files) may report width/height
    // that do not line up exactly with the packed RGB buffer length. Instead of
    // failing hard, we prefer a best-effort, visually reasonable preview.
    //
    // rgbData is expected to be RGB-packed (3 bytes per pixel). If the metadata
    // dimensions imply more pixels than we actually have data for, recompute a
    // consistent width/height using the original aspect ratio as a guide.
    let pixelCount = width * height;
    const expectedBytes = pixelCount * 3;
    if (rgbData.length < expectedBytes) {
      const totalPixelsFromData = Math.floor(rgbData.length / 3);
      if (totalPixelsFromData <= 0) {
        throw new Error("Unexpected DNG decode size");
      }

      const aspect = width > 0 && height > 0 ? width / height : 1;
      // Solve approximately:
      //   newWidth * newHeight ≈ totalPixelsFromData
      //   newWidth / newHeight ≈ aspect
      const newHeight = Math.max(
        1,
        Math.round(Math.sqrt(totalPixelsFromData / (aspect || 1)))
      );
      const newWidth = Math.max(
        1,
        Math.round(totalPixelsFromData / newHeight)
      );

      width = newWidth;
      height = newHeight;
      pixelCount = width * height;
    }

    const rgba = new Uint8ClampedArray(pixelCount * 4);
    let src = 0;
    for (let i = 0; i < pixelCount; i++) {
      const r = rgbData[src++];
      const g = rgbData[src++];
      const b = rgbData[src++];
      const dst = i * 4;
      rgba[dst] = r;
      rgba[dst + 1] = g;
      rgba[dst + 2] = b;
      rgba[dst + 3] = 255;
    }

    const frame: PixelFrameRGBA = {
      width,
      height,
      data: rgba,
    };

    // Derive a simple per-camera gain bias. RD1 Lightroom DNG exports tend to
    // come in quite hot even after global normalization, so we gently dampen
    // them while leaving other cameras unchanged.
    let gainBias = 1;
    const cameraModel =
      meta.cameraModel ?? meta.model ?? "";
    if (cameraModel.toLowerCase().includes("r-d1")) {
      // RD1 baselines tend to come in dark and a bit muddy compared to
      // Lightroom. Push the baseline gain up so, after the global 0.5 factor
      // in normalizeDngBaseline, we land closer to 1× overall exposure.
      gainBias = 1.6;
    }

    // Bring LibRaw's camera-normalized output into a stable baseline domain
    // (exposure-normalized, neutral tone) so downstream matching behaves
    // similarly to the PNG domain we originally tuned on.
    normalizeDngBaseline(frame, gainBias);

    return frame;
  } catch {
    // Normalize any libraw/worker/WASM failures into a single decode error.
    throw new Error("The source image could not be decoded.");
  }
}

type LibRawOpenOptions = {
  useCameraWb?: boolean;
  useAutoWb?: boolean;
  outputColor?: number;
  outputBps?: number;
  noAutoBright?: boolean;
  expCorrec?: boolean;
  gamm?: [number, number];
};

type LibRawRgb = {
  width: number;
  height: number;
  /** Packed RGB samples (3 per pixel). */
  samples: Uint16Array | Uint8Array;
  /** Multiply a sample by this to get 0..1. */
  scale: number;
};

/**
 * Normalise libraw-wasm imageData() output into packed RGB samples.
 * With outputBps: 16 the wasm build may return either a Uint16Array view or the
 * raw little-endian bytes as a Uint8Array; both are handled. 8-bit output is
 * rejected so a silent quantisation regression can never reach the pipeline.
 */
function extractLibRawRgb16(image: unknown, meta: LibRawMetadata): LibRawRgb | null {
  const obj = image as {
    width?: unknown;
    height?: unknown;
    bits?: unknown;
    data?: unknown;
  } | null;
  let width = meta.width;
  let height = meta.height;
  let raw: unknown = image;
  if (obj && typeof obj.width === "number" && typeof obj.height === "number" && obj.data) {
    width = obj.width;
    height = obj.height;
    raw = obj.data;
  }
  const declaredBits = obj && typeof obj.bits === "number" ? obj.bits : null;

  let samples: Uint16Array;
  if (raw instanceof Uint16Array) {
    samples = raw;
  } else if (raw instanceof Uint8Array || raw instanceof Uint8ClampedArray) {
    const bytes = raw as Uint8Array;
    const looksLike16 =
      declaredBits === 16 || (declaredBits == null && bytes.length >= width * height * 6);
    if (!looksLike16) {
      throw new Error("LibRaw returned 8-bit data; refusing to decode below 16-bit.");
    }
    const n = Math.floor(bytes.length / 2);
    if (bytes.byteOffset % 2 === 0) {
      samples = new Uint16Array(bytes.buffer, bytes.byteOffset, n);
    } else {
      samples = new Uint16Array(n);
      for (let i = 0; i < n; i++) {
        samples[i] = (bytes[2 * i] ?? 0) | ((bytes[2 * i + 1] ?? 0) << 8);
      }
    }
  } else {
    return null;
  }

  let pixelCount = width * height;
  if (samples.length < pixelCount * 3) {
    const totalPixelsFromData = Math.floor(samples.length / 3);
    if (totalPixelsFromData <= 0) return null;
    const aspect = width > 0 && height > 0 ? width / height : 1;
    height = Math.max(1, Math.round(Math.sqrt(totalPixelsFromData / (aspect || 1))));
    width = Math.max(1, Math.round(totalPixelsFromData / height));
    pixelCount = width * height;
    if (pixelCount * 3 > samples.length) {
      height = Math.max(1, Math.floor(totalPixelsFromData / width));
    }
  }
  return { width, height, samples, scale: 1 / 65535 };
}

const LINEAR_16BIT_OPEN_OPTIONS: LibRawOpenOptions = {
  useCameraWb: true,
  useAutoWb: false,
  outputColor: 0,
  outputBps: 16,
  noAutoBright: true,
  expCorrec: false,
  gamm: [1, 1],
};

function libRawRgbToLinearFloat(rgb: LibRawRgb): PixelFrameF32 {
  const { width, height, samples, scale } = rgb;
  const pixelCount = width * height;
  const floatData = new Float32Array(pixelCount * 4);
  for (let i = 0, src = 0; i < pixelCount; i++, src += 3) {
    const dst = i * 4;
    floatData[dst] = (samples[src] ?? 0) * scale;
    floatData[dst + 1] = (samples[src + 1] ?? 0) * scale;
    floatData[dst + 2] = (samples[src + 2] ?? 0) * scale;
    floatData[dst + 3] = 1;
  }
  return { width, height, data: floatData };
}

/**
 * Decode a DNG file to un-normalised linear float (16-bit LibRaw output) for
 * exposure map extraction. Returns null for non-DNG files or decode failure.
 */
export async function decodeDngLinear(file: File): Promise<PixelFrameF32 | null> {
  if (!isDng(file)) return null;
  try {
    const { default: LibRaw } = await loadLibRaw();
    const buf = await file.arrayBuffer();
    const raw = new LibRaw();
    await raw.open(new Uint8Array(buf), LINEAR_16BIT_OPEN_OPTIONS);
    const meta = (await raw.metadata()) as LibRawMetadata;
    const image = await raw.imageData();
    const rgb = extractLibRawRgb16(image, meta);
    if (!rgb) return null;
    return libRawRgbToLinearFloat(rgb);
  } catch {
    return null;
  }
}

/**
 * Load a File (JPG/PNG/DNG) into a bitmap then read RGBA via 2D canvas or WASM.
 */
async function decodeFile(file: File): Promise<PixelFrameRGBA> {
  if (isDng(file)) {
    return decodeDng(file);
  }

  if (!isJpegOrPng(file)) {
    throw new Error(
      `Unsupported format: ${file.type || file.name}. Only JPG, PNG, and DNG are supported.`
    );
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

/**
 * Decode a DNG/RAW file to linear float (PixelFrameF32).
 * Uses outputColor: 0, gamma 1 and 16 bits per sample, then applies
 * normalizeDngBaseline in linear space. Returns null for non-DNG files.
 */
export async function decodeDngToLinearFloat(file: File): Promise<PixelFrameF32 | null> {
  if (!isDng(file)) return null;
  try {
    const { default: LibRaw } = await loadLibRaw();
    const buf = await file.arrayBuffer();
    const raw = new LibRaw();
    await raw.open(new Uint8Array(buf), LINEAR_16BIT_OPEN_OPTIONS);
    const meta = (await raw.metadata()) as LibRawMetadata;
    const image = await raw.imageData();
    const rgb = extractLibRawRgb16(image, meta);
    if (!rgb) return null;
    const frame = libRawRgbToLinearFloat(rgb);
    let gainBias = 1;
    const cameraModel = meta.cameraModel ?? meta.model ?? "";
    if (cameraModel.toLowerCase().includes("r-d1")) {
      gainBias = 1.6;
    }
    normalizeDngBaselineLinear(frame.data, frame.width, frame.height, gainBias);
    return frame;
  } catch (err) {
    console.error("[decodeDngToLinearFloat] 16-bit decode failed", err);
    return null;
  }
}

/**
 * Decode File to linear float (PixelFrameF32).
 * - DNG/RAW: decodeDngToLinearFloat
 * - JPG/PNG: decode to sRGB 8-bit, convert to linear float
 */
export async function decodeToLinearFloat(file: File): Promise<PixelFrameF32> {
  if (isDng(file)) {
    const frame = await decodeDngToLinearFloat(file);
    if (frame) return frame;
    throw new Error("DNG decode to linear float failed");
  }
  if (!isJpegOrPng(file)) {
    throw new Error(
      `Unsupported format: ${file.type || file.name}. Only JPG, PNG, and DNG are supported.`
    );
  }
  const rgba = await decodeFile(file);
  return pixelFrameRgbaSrgb8ToLinearFloat(rgba);
}
