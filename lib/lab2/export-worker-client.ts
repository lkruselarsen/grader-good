import type {
  PipelineParams,
  PixelFrameF32,
  PixelFrameRGBA,
} from "@/src/lib/pipeline";

export type RunExportGradingInWorkerInput = {
  decodedSource: PixelFrameF32;
  decodedRef: PixelFrameF32 | null | undefined;
  pipelineParams: PipelineParams;
};

type WorkerSuccessMsg = {
  data: ArrayBuffer;
  width: number;
  height: number;
  error?: never;
};

type WorkerErrorMsg = {
  error: string;
  data?: never;
};

/**
 * Grade full-resolution float frames in a dedicated worker.
 *
 * Copies source/ref buffers before transfer so the caller's frames remain usable
 * for live preview and subsequent exports.
 */
export async function runExportGradingInWorker(
  input: RunExportGradingInWorkerInput
): Promise<PixelFrameRGBA> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL(
        "../../src/lib/pipeline/workers/lab2-export-worker.ts",
        import.meta.url
      )
    );

    const sourceCopy = new Float32Array(input.decodedSource.data);
    const transferList: Transferable[] = [sourceCopy.buffer];

    let refCopy: Float32Array | null = null;
    if (input.decodedRef) {
      refCopy = new Float32Array(input.decodedRef.data);
      transferList.push(refCopy.buffer);
    }

    worker.postMessage(
      {
        sourceData: sourceCopy.buffer,
        sourceWidth: input.decodedSource.width,
        sourceHeight: input.decodedSource.height,
        refData: refCopy?.buffer ?? null,
        refWidth: input.decodedRef?.width ?? 0,
        refHeight: input.decodedRef?.height ?? 0,
        params: input.pipelineParams,
      },
      transferList
    );

    worker.onmessage = (e: MessageEvent<WorkerSuccessMsg | WorkerErrorMsg>) => {
      worker.terminate();
      if ("error" in e.data && e.data.error) {
        reject(new Error(e.data.error));
        return;
      }
      const ok = e.data as WorkerSuccessMsg;
      resolve({
        width: ok.width,
        height: ok.height,
        data: new Uint8ClampedArray(ok.data),
      });
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };
  });
}
