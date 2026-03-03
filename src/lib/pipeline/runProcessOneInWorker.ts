/**
 * Async wrapper that runs processOne inside a dedicated Web Worker.
 *
 * Each call spawns a fresh worker, transfers the input ArrayBuffers to it
 * (zero-copy), awaits the result, terminates the worker, and returns the
 * result PixelFrameRGBA.
 *
 * Terminating the worker causes the OS to reclaim the entire worker heap
 * immediately — bypassing V8 GC and preventing old-generation accumulation
 * across training iterations.
 *
 * IMPORTANT: the caller must pass *copies* of source/ref data buffers if the
 * originals are needed in later iterations, because ArrayBuffer transfer
 * neuters the original (source.data becomes zero-length after postMessage).
 * See app/train/page.tsx for the copy pattern.
 */

import type { PipelineParams, PixelFrameRGBA } from "./types";

export async function runProcessOneInWorker(
  source: PixelFrameRGBA,
  ref: PixelFrameRGBA | null,
  params: PipelineParams
): Promise<PixelFrameRGBA> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./processOne-worker.ts", import.meta.url)
    );

    const sourceBuffer = source.data.buffer;
    const refBuffer = ref?.data.buffer ?? null;
    const transferList: Transferable[] = [sourceBuffer];
    if (refBuffer) transferList.push(refBuffer);

    worker.postMessage(
      {
        sourceData: sourceBuffer,
        sourceWidth: source.width,
        sourceHeight: source.height,
        refData: refBuffer,
        refWidth: ref?.width ?? 0,
        refHeight: ref?.height ?? 0,
        params,
      },
      transferList
    );

    worker.onmessage = (
      e: MessageEvent<
        | { data: ArrayBuffer; width: number; height: number; error?: never }
        | { error: string; data?: never }
      >
    ) => {
      worker.terminate();
      if (e.data.error) {
        reject(new Error(e.data.error));
        return;
      }
      resolve({
        width: e.data.width!,
        height: e.data.height!,
        data: new Uint8ClampedArray(e.data.data!),
      });
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };
  });
}
