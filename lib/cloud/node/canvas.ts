/**
 * Node canvas (Skia via @napi-rs/canvas) for the cloud worker. Installs its
 * ImageData as the global so pipeline helpers (`new ImageData`) and canvas
 * putImageData share one implementation.
 */

import { createCanvas, ImageData as NapiImageData } from "@napi-rs/canvas";
import type { GrainCanvasFactory } from "@/lib/grain/types";

let installed = false;

export function installNodeCanvasGlobals(): void {
  if (installed) return;
  (globalThis as unknown as { ImageData: unknown }).ImageData = NapiImageData;
  installed = true;
}

export const createNodeCanvas: GrainCanvasFactory = (width, height) =>
  createCanvas(width, height) as unknown as ReturnType<GrainCanvasFactory>;

export { createCanvas };
