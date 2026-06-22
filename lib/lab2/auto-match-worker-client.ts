import type { PixelFrameF32 } from "@/src/lib/pipeline";
import type { LookParams } from "@/src/lib/pipeline/stages/match";

type TileEmbeddingProgress = (
  phase: "semantic" | "chromatic",
  current: number,
  total: number
) => void;

type PendingTileEmbeddings = {
  kind: "tileEmbeddings";
  resolve: (value: { semantic: number[][]; chromatic: number[][] }) => void;
  reject: (reason: Error) => void;
  onProgress?: TileEmbeddingProgress;
};

type PendingFitLookParams = {
  kind: "fitLookParams";
  resolve: (value: LookParams) => void;
  reject: (reason: Error) => void;
};

type Pending = PendingTileEmbeddings | PendingFitLookParams;

type WorkerProgressMsg = {
  type: "progress";
  requestId: number;
  phase: "semantic" | "chromatic";
  current: number;
  total: number;
};

type WorkerTileEmbeddingsResultMsg = {
  type: "tileEmbeddingsResult";
  requestId: number;
  semantic: number[][];
  chromatic: number[][];
};

type WorkerFitLookParamsResultMsg = {
  type: "fitLookParamsResult";
  requestId: number;
  lookParams: LookParams;
};

type WorkerErrorMsg = {
  type: "error";
  requestId: number;
  error: string;
};

type WorkerOutMsg =
  | WorkerProgressMsg
  | WorkerTileEmbeddingsResultMsg
  | WorkerFitLookParamsResultMsg
  | WorkerErrorMsg;

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(
    new URL(
      "../../src/lib/pipeline/workers/lab2-auto-match-worker.ts",
      import.meta.url
    )
  );
  worker.onmessage = (e: MessageEvent<WorkerOutMsg>) => {
    const msg = e.data;
    if (msg.type === "progress") {
      const entry = pending.get(msg.requestId);
      if (entry?.kind === "tileEmbeddings") {
        entry.onProgress?.(msg.phase, msg.current, msg.total);
      }
      return;
    }
    const entry = pending.get(msg.requestId);
    if (!entry) return;
    pending.delete(msg.requestId);
    if (msg.type === "error") {
      entry.reject(new Error(msg.error));
      return;
    }
    if (entry.kind === "tileEmbeddings" && msg.type === "tileEmbeddingsResult") {
      entry.resolve({ semantic: msg.semantic, chromatic: msg.chromatic });
      return;
    }
    if (entry.kind === "fitLookParams" && msg.type === "fitLookParamsResult") {
      entry.resolve(msg.lookParams);
    }
  };
  worker.onerror = (err) => {
    const message = err.message || "Auto-match worker failed";
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(new Error(message));
    }
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function postFrameCopy(
  type: "tileEmbeddings" | "fitLookParams",
  frame: PixelFrameF32,
  extra?: { gridCols: number; gridRows: number }
): number {
  const requestId = nextRequestId++;
  const dataCopy = new Float32Array(frame.data);
  const w = getWorker();
  if (type === "tileEmbeddings") {
    w.postMessage(
      {
        type,
        requestId,
        width: frame.width,
        height: frame.height,
        data: dataCopy.buffer,
        gridCols: extra?.gridCols ?? 10,
        gridRows: extra?.gridRows ?? 10,
      },
      [dataCopy.buffer]
    );
  } else {
    w.postMessage(
      {
        type,
        requestId,
        width: frame.width,
        height: frame.height,
        data: dataCopy.buffer,
      },
      [dataCopy.buffer]
    );
  }
  return requestId;
}

/**
 * Convert full-res linear float frame to tile embeddings off the main thread.
 * DINOv2 inference and chroma histograms run in a dedicated worker.
 */
export function computeSourceTileEmbeddingsInWorker(
  frame: PixelFrameF32,
  onProgress?: TileEmbeddingProgress
): Promise<{ semantic: number[][]; chromatic: number[][] }> {
  return new Promise((resolve, reject) => {
    const requestId = postFrameCopy("tileEmbeddings", frame, {
      gridCols: 10,
      gridRows: 10,
    });
    pending.set(requestId, {
      kind: "tileEmbeddings",
      resolve,
      reject,
      onProgress,
    });
  });
}

/**
 * Fit LookParams from a full-res reference frame off the main thread.
 */
export function fitLookParamsInWorker(frame: PixelFrameF32): Promise<LookParams> {
  return new Promise((resolve, reject) => {
    const requestId = postFrameCopy("fitLookParams", frame);
    pending.set(requestId, {
      kind: "fitLookParams",
      resolve,
      reject,
    });
  });
}

export function terminateAutoMatchWorker(): void {
  for (const [id, entry] of pending) {
    pending.delete(id);
    entry.reject(new Error("Auto-match worker terminated"));
  }
  worker?.terminate();
  worker = null;
}
