import sharp from "sharp";

/** Public bucket holding dataset reference images and their library thumbnails. */
export const SAMPLES_BUCKET = "grading-samples";
const THUMB_EDGE = 320;

/** Display-only library thumbnail; matching always uses the original image. */
export async function makeSampleThumb(original: Buffer): Promise<Buffer> {
  return sharp(original)
    .rotate()
    .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
}

/** `samples/foo.png` → `samples/thumbs/foo.jpg`. */
export function sampleThumbPath(originalPath: string): string {
  const file = originalPath.split("/").pop() ?? originalPath;
  return `samples/thumbs/${file.replace(/\.[^.]+$/, "")}.jpg`;
}

/** Object path inside the samples bucket for one of its public URLs, or null. */
export function samplesObjectPath(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  const marker = `/object/public/${SAMPLES_BUCKET}/`;
  const at = publicUrl.indexOf(marker);
  if (at < 0) return null;
  return decodeURIComponent(publicUrl.slice(at + marker.length).split("?")[0]!);
}
