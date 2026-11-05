import sharp from "sharp";
import { applyAlgo2GrainToImageData } from "@/lib/grain/algo2-core";
import type { GrainExportParams } from "@/lib/grain/types";
import type { PixelFrameRGBA } from "@/src/lib/pipeline/types";
import { createNodeCanvas, installNodeCanvasGlobals } from "./canvas";

export const CLOUD_THUMB_LONG_EDGE = 640;

/**
 * Output stage of a cloud export, in the same order as lab2's export menu:
 * the full-resolution graded frame (already quantised by the export path) gets
 * grain at full size, then is scaled, then PNG-encoded.
 */
export async function encodeCloudExport(
  rgba: PixelFrameRGBA,
  opts: { withGrain: boolean; grain: GrainExportParams; scale: number }
): Promise<{ png: Buffer; thumb: Buffer; width: number; height: number }> {
  installNodeCanvasGlobals();
  let pixels: Uint8ClampedArray = rgba.data;
  if (opts.withGrain) {
    const source = new ImageData(
      rgba.data as Uint8ClampedArray<ArrayBuffer>,
      rgba.width,
      rgba.height
    );
    const grained = await applyAlgo2GrainToImageData(
      source,
      opts.grain,
      undefined,
      createNodeCanvas
    );
    pixels = grained.data;
  }
  const width =
    opts.scale < 1 ? Math.max(1, Math.round(rgba.width * opts.scale)) : rgba.width;
  const height =
    opts.scale < 1 ? Math.max(1, Math.round(rgba.height * opts.scale)) : rgba.height;
  const raw = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  let pipeline = sharp(raw, {
    raw: { width: rgba.width, height: rgba.height, channels: 4 },
    limitInputPixels: false,
  });
  if (width !== rgba.width || height !== rgba.height) {
    pipeline = pipeline.resize(width, height, { kernel: "lanczos3", fit: "fill" });
  }
  const png = await pipeline.png().toBuffer();
  const thumb = await sharp(png, { limitInputPixels: false })
    .resize(CLOUD_THUMB_LONG_EDGE, CLOUD_THUMB_LONG_EDGE, { fit: "inside" })
    .flatten({ background: "#000" })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { png, thumb, width, height };
}
