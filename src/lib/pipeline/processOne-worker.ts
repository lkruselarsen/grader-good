/**
 * Web Worker entry point for processOne.
 *
 * Receives a message with { sourceData, sourceWidth, sourceHeight,
 * refData, refWidth, refHeight, params } where sourceData and refData
 * are transferred ArrayBuffers (zero-copy, already neutered on the main thread).
 *
 * Runs processOne and posts the result ArrayBuffer back (also transferred),
 * then the caller must call worker.terminate() to free the worker heap.
 *
 * decode is not called here — the main thread passes already-decoded
 * PixelFrameRGBA data, so libraw-wasm never needs to run in this worker.
 */

import type { PipelineParams, PixelFrameRGBA } from "./types";

self.onmessage = async (
  e: MessageEvent<{
    sourceData: ArrayBuffer;
    sourceWidth: number;
    sourceHeight: number;
    refData: ArrayBuffer | null;
    refWidth: number;
    refHeight: number;
    params: PipelineParams;
  }>
) => {
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

    // Reconstruct PixelFrameRGBA from transferred buffers
    const source: PixelFrameRGBA = {
      width: sourceWidth,
      height: sourceHeight,
      data: new Uint8ClampedArray(sourceData),
    };
    const ref: PixelFrameRGBA | null = refData
      ? {
          width: refWidth,
          height: refHeight,
          data: new Uint8ClampedArray(refData),
        }
      : null;

    // Dynamic import keeps libraw-wasm (imported by decode.ts) out of the
    // static dependency graph of this worker entry point.
    const { processOne } = await import("./processOne");

    const result = await processOne(source, ref, params);

    // Transfer the result buffer back — zero copy
    self.postMessage(
      { data: result.data.buffer, width: result.width, height: result.height },
      // @ts-expect-error transferList is the second arg to self.postMessage in workers
      [result.data.buffer]
    );
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
