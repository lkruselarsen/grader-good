import sharp from "sharp";
import { pixelFrameRgbaSrgb8ToLinearFloat } from "@/src/lib/pipeline/srgb8ToLinearFloatFrame";
import type { PixelFrameF32 } from "@/src/lib/pipeline/types";

/**
 * Decode a dataset reference (JPG/PNG at its native 8-bit depth) to linear
 * float, like the browser's Image → canvas → getImageData → linearise path.
 * sharp converts any embedded ICC profile to sRGB, as the canvas does.
 */
export async function decodeReferenceBufferToLinearFloat(buf: Buffer): Promise<PixelFrameF32> {
  const { data, info } = await sharp(buf, { limitInputPixels: false })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return pixelFrameRgbaSrgb8ToLinearFloat({
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  });
}

export async function fetchReferenceLinearFloat(url: string): Promise<PixelFrameF32> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch matched reference (${res.status}).`);
  return decodeReferenceBufferToLinearFloat(Buffer.from(await res.arrayBuffer()));
}
