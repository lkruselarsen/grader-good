/**
 * Pipeline public API.
 */

export { processOne } from "./processOne";
export { processFrames, processFramesFloat } from "./processFrames";
export { exportToCanvas, frameToImageData } from "./exportStage";
// decode and decodeDngLinear are browser-only (libraw-wasm) — import directly
// from "@/src/lib/pipeline/decode" in client components; never from this barrel
// so that server API routes don't accidentally pull libraw-wasm into the Node bundle.
export {
  buildExposureMapFromFloat,
  buildExposureMapFromSrgb,
  buildExposureMapFromLinearRgb,
  type ExposureMap,
} from "./exposureMap";
export { match } from "./match";
export { halation } from "./halation";
export { grain } from "./grain";
export type {
  PixelFrameRGBA,
  PixelFrameF32,
  DecodeInput,
  PipelineParams,
} from "./types";
export { allocPixelFrameF32, pixelFrameF32ToPixelFrameRGBA } from "./types";
export { pixelFrameF32ToPixelFrameRGBAAsync } from "./yielding-conversions";
export {
  computeImageStats,
  computeImageStatsFromFloat,
  computeBandAnchorsFromFrame,
  type ImageStats,
  type ExposureLevel,
  type ChromaDistribution,
  type ChromaBand,
} from "./imageStats";
