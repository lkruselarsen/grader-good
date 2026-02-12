/**
 * Decode stage: file or existing frame → PixelFrameRGBA.
 * - JPG/PNG: main-thread decode via Image + canvas.
 * - DNG/RAW: browser WASM via libraw-wasm (loaded dynamically).
 */

import type { DecodeInput, PixelFrameRGBA } from "./types";

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
  const ys: number[] = [];

  // Sample luminance over opaque pixels (subsample for speed).
  const sampleStep = 16 * 4; // every 16th pixel
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
    ys.push(y);
  }

  if (ys.length === 0) return;

  ys.sort((a, b) => a - b);
  const midIdx = Math.floor(ys.length * 0.5);
  const yMid = ys[midIdx] ?? 0.18;

  // Aim the median slightly below "classic" 18% gray in display space to leave
  // more headroom for bright cameras (e.g. RD1) and avoid clipping.
  const targetMid = 0.19;
  const p90Idx = Math.floor(ys.length * 0.9);
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
    // Load libraw-wasm lazily to keep the initial bundle light and avoid
    // Turbopack/Webpack analysis issues with top-level Worker/WASM imports.
    const { default: LibRaw } = await import("libraw-wasm");
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
