import { CUSTOM_SHAPE_LIMITS } from "./types";
import { createCustomShapeId, filenameToShapeName } from "./slug";
import type { CustomGridShapePng } from "./types";
import { parseSvgFile } from "./parse-svg";

export type ParsePngResult =
  | { ok: true; shape: CustomGridShapePng; warnings: string[] }
  | { ok: false; error: string };

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function loadImageDimensions(
  dataUrl: string
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Failed to decode PNG"));
    img.src = dataUrl;
  });
}

export async function parsePngFile(file: File): Promise<ParsePngResult> {
  const warnings: string[] = [];

  if (file.size > CUSTOM_SHAPE_LIMITS.pngMaxBytes) {
    return {
      ok: false,
      error: `PNG must be under ${CUSTOM_SHAPE_LIMITS.pngMaxBytes / 1024} KB`,
    };
  }

  const ext = file.name.toLowerCase();
  if (!ext.endsWith(".png") && file.type !== "image/png") {
    return { ok: false, error: "File must be a PNG" };
  }

  let dataUrl: string;
  try {
    dataUrl = await readFileAsDataUrl(file);
  } catch {
    return { ok: false, error: "Failed to read PNG file" };
  }

  let width: number;
  let height: number;
  try {
    ({ width, height } = await loadImageDimensions(dataUrl));
  } catch {
    return { ok: false, error: "Invalid or corrupted PNG" };
  }

  if (
    width > CUSTOM_SHAPE_LIMITS.pngMaxDimension ||
    height > CUSTOM_SHAPE_LIMITS.pngMaxDimension
  ) {
    return {
      ok: false,
      error: `PNG dimensions must be at most ${CUSTOM_SHAPE_LIMITS.pngMaxDimension}×${CUSTOM_SHAPE_LIMITS.pngMaxDimension}px`,
    };
  }

  if (width !== height) {
    warnings.push("Non-square PNG — shape will be scaled to fit");
  }

  const ideal = CUSTOM_SHAPE_LIMITS.pngIdealDimension;
  if (width !== ideal || height !== ideal) {
    warnings.push(`Ideal size is ${ideal}×${ideal}px (32×32 also works well)`);
  }

  const name = filenameToShapeName(file.name);
  const shape: CustomGridShapePng = {
    id: createCustomShapeId(name, dataUrl),
    name,
    kind: "png",
    dataUrl,
    width,
    height,
    createdAt: Date.now(),
  };

  return { ok: true, shape, warnings };
}

export async function parseShapeFile(
  file: File
): Promise<
  | { ok: true; shape: import("./types").CustomGridShape; warnings: string[] }
  | { ok: false; error: string }
> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".svg") || file.type === "image/svg+xml") {
    return parseSvgFile(file);
  }
  if (name.endsWith(".png") || file.type === "image/png") {
    return parsePngFile(file);
  }
  return { ok: false, error: "Unsupported format — use SVG or PNG" };
}
