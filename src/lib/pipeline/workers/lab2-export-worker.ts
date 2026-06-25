/**
 * Web Worker for full-resolution Lab2 export grading.
 *
 * Runs buildExposureMapFromFloat → processFramesFloat → pixelFrameF32ToPixelFrameRGBA
 * off the main thread so export-modal loader animations stay smooth.
 */

import { buildExposureMapFromFloat } from "../exposureMap";
import { processFramesFloat } from "../processFrames";
import type { PipelineParams, PixelFrameF32 } from "../types";
import { pixelFrameF32ToPixelFrameRGBA } from "../types";

type ExportWorkerMsg = {
  sourceData: ArrayBuffer;
  sourceWidth: number;
  sourceHeight: number;
  refData: ArrayBuffer | null;
  refWidth: number;
  refHeight: number;
  params: PipelineParams;
};

self.onmessage = (e: MessageEvent<ExportWorkerMsg>) => {
  try {
    const {
      sourceData,
      sourceWidth,
      sourceHeight,
      refData,
      refWidth,
      refHeight,
      params,
    } = e.data;

    const source: PixelFrameF32 = {
      width: sourceWidth,
      height: sourceHeight,
      data: new Float32Array(sourceData),
    };
    const ref: PixelFrameF32 | null = refData
      ? {
          width: refWidth,
          height: refHeight,
          data: new Float32Array(refData),
        }
      : null;

    const exposureMap = buildExposureMapFromFloat(source);
    const resultFloat = processFramesFloat(source, ref, {
      ...params,
      exposureMap,
    });
    const rgba = pixelFrameF32ToPixelFrameRGBA(resultFloat);

    self.postMessage(
      { data: rgba.data.buffer, width: rgba.width, height: rgba.height },
      // @ts-expect-error transfer list in worker postMessage
      [rgba.data.buffer]
    );
  } catch (err) {
    self.postMessage({
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
