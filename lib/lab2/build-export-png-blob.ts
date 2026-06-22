import { buildEngineParamsFromLookParams } from "@/lib/build-engine-params";
import type { LookParams as LookParamsT } from "@/lib/look-params";
import {
  buildExposureMapFromFloat,
  frameToImageData,
  pixelFrameF32ToPixelFrameRGBA,
  processFramesFloat,
  type PixelFrameF32,
} from "@/src/lib/pipeline";

export type BuildExportPngBlobInput = {
  decodedSource: PixelFrameF32;
  decodedRef: PixelFrameF32 | null | undefined;
  lookParams: LookParamsT;
  finalGrading: LookParamsT["grading"];
  model2Strength: number;
  model2Robust: boolean;
  exportHalationActuance: boolean;
};

/** Canonical export path: full-resolution RAW-decoded linear float only. */
export async function buildExportPngBlobFromFrames(
  input: BuildExportPngBlobInput
): Promise<Blob> {
  const { decodedSource: src, decodedRef: ref, lookParams, finalGrading } = input;
  const engine = buildEngineParamsFromLookParams(lookParams, finalGrading);
  const grading = input.exportHalationActuance
    ? engine
    : {
        ...engine,
        actuanceStrength: 0,
        halationExposureTopographyLiftStops: 0,
        highlightFill: engine.highlightFill
          ? { ...engine.highlightFill, strength: 0 }
          : { strength: 0 },
      };
  const exposureMap = buildExposureMapFromFloat(src);
  const resultFloat = processFramesFloat(src, ref ?? null, {
    strength: input.model2Strength,
    grading,
    exposureMap,
    matchModel: 2,
    model2Strength: input.model2Strength,
    model2RobustSampling: input.model2Robust,
  });
  const rgba = pixelFrameF32ToPixelFrameRGBA(resultFloat);
  const canvas = document.createElement("canvas");
  canvas.width = rgba.width;
  canvas.height = rgba.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D context");
  ctx.putImageData(frameToImageData(rgba), 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png"
    );
  });
}

async function scalePngBlobToDimensions(
  blob: Blob,
  targetWidth: number,
  targetHeight: number
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width === targetWidth && bitmap.height === targetHeight) {
    bitmap.close();
    return blob;
  }
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("No 2D context");
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png"
    );
  });
}

export async function scalePngBlob(blob: Blob, scale: number): Promise<Blob> {
  if (scale >= 1) return blob;
  const bitmap = await createImageBitmap(blob);
  const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
  const targetHeight = Math.max(1, Math.round(bitmap.height * scale));
  bitmap.close();
  return scalePngBlobToDimensions(blob, targetWidth, targetHeight);
}

/** Scale PNG so its longest edge equals targetLongEdge (up or down). */
export async function scalePngBlobToLongEdge(
  blob: Blob,
  targetLongEdge: number
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const longEdge = Math.max(width, height);
  bitmap.close();
  if (longEdge === targetLongEdge) return blob;
  const scale = targetLongEdge / longEdge;
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  return scalePngBlobToDimensions(blob, targetWidth, targetHeight);
}

export { scalePngBlobToDimensions };

/** Encodes the current preview canvas only (no full-res pipeline). */
export function buildPreviewPngBlobFromCanvas(
  canvas: HTMLCanvasElement
): Promise<Blob> {
  if (canvas.width < 1 || canvas.height < 1) {
    return Promise.reject(new Error("Nothing to export — preview is empty."));
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png"
    );
  });
}

export function downloadPngBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
