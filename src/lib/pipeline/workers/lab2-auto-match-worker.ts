/**
 * Offloads Lab 2 auto-match CPU work from the main thread:
 * - float32 → sRGB conversion + tile embeddings (DINOv2 + chroma histograms)
 * - fitLookParamsFromReference on full-res reference frames
 */

import {
  imageToChromaticTileEmbeddings,
  imageToColClipTileEmbeddings,
} from "@/src/lib/colclipEmbeddings";
import {
  frameToImageData,
  pixelFrameF32ToPixelFrameRGBA,
} from "@/src/lib/pipeline";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";
import type { LookParams } from "@/src/lib/pipeline/stages/match";

type TileEmbeddingsMsg = {
  type: "tileEmbeddings";
  requestId: number;
  width: number;
  height: number;
  data: ArrayBuffer;
  gridCols: number;
  gridRows: number;
};

type FitLookParamsMsg = {
  type: "fitLookParams";
  requestId: number;
  width: number;
  height: number;
  data: ArrayBuffer;
};

type WorkerInMsg = TileEmbeddingsMsg | FitLookParamsMsg;

type ProgressOutMsg = {
  type: "progress";
  requestId: number;
  phase: "semantic" | "chromatic";
  current: number;
  total: number;
};

type TileEmbeddingsResultMsg = {
  type: "tileEmbeddingsResult";
  requestId: number;
  semantic: number[][];
  chromatic: number[][];
};

type FitLookParamsResultMsg = {
  type: "fitLookParamsResult";
  requestId: number;
  lookParams: LookParams;
};

type ErrorOutMsg = {
  type: "error";
  requestId: number;
  error: string;
};

self.onmessage = async (e: MessageEvent<WorkerInMsg>) => {
  const msg = e.data;
  try {
    if (msg.type === "tileEmbeddings") {
      const frame = {
        width: msg.width,
        height: msg.height,
        data: new Float32Array(msg.data),
      };
      const rgba = pixelFrameF32ToPixelFrameRGBA(frame);
      const imageData = frameToImageData(rgba);

      const semantic = await imageToColClipTileEmbeddings(
        imageData,
        msg.gridCols,
        msg.gridRows,
        (current, total) => {
          const progress: ProgressOutMsg = {
            type: "progress",
            requestId: msg.requestId,
            phase: "semantic",
            current,
            total,
          };
          self.postMessage(progress);
        }
      );

      const chromatic = imageToChromaticTileEmbeddings(
        imageData,
        msg.gridCols,
        msg.gridRows
      );
      const total = msg.gridCols * msg.gridRows;
      const done: ProgressOutMsg = {
        type: "progress",
        requestId: msg.requestId,
        phase: "chromatic",
        current: total,
        total,
      };
      self.postMessage(done);

      const result: TileEmbeddingsResultMsg = {
        type: "tileEmbeddingsResult",
        requestId: msg.requestId,
        semantic,
        chromatic,
      };
      self.postMessage(result);
      return;
    }

    if (msg.type === "fitLookParams") {
      const frame = {
        width: msg.width,
        height: msg.height,
        data: new Float32Array(msg.data),
      };
      const lookParams = fitLookParamsFromReference(frame);
      const result: FitLookParamsResultMsg = {
        type: "fitLookParamsResult",
        requestId: msg.requestId,
        lookParams,
      };
      self.postMessage(result);
      return;
    }
  } catch (err) {
    const error: ErrorOutMsg = {
      type: "error",
      requestId: msg.requestId,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(error);
  }
};
