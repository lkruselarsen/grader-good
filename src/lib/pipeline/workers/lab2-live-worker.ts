import {
  applyLivePostModel2OnlyWithState,
  createLab2LiveWorkState,
  type Lab2LiveWorkState,
} from "@/lib/lab2-live-preview";
import type { LookParams as GradingParams } from "@/src/lib/pipeline/stages/match";
import type { PixelFrameF32 } from "@/src/lib/pipeline/types";

type InitMsg = {
  type: "init";
  width: number;
  height: number;
  base: ArrayBuffer;
};

type RenderMsg = {
  type: "render";
  requestId: number;
  grading: GradingParams;
  options?: {
    halationPreview?: boolean;
  };
};

type WorkerInMsg = InitMsg | RenderMsg;

let baseFrame: PixelFrameF32 | null = null;
let workState: Lab2LiveWorkState | null = null;

self.onmessage = (e: MessageEvent<WorkerInMsg>) => {
  try {
    const msg = e.data;
    if (msg.type === "init") {
      baseFrame = {
        width: msg.width,
        height: msg.height,
        data: new Float32Array(msg.base),
      };
      workState = createLab2LiveWorkState(msg.width, msg.height);
      self.postMessage({ type: "inited", width: msg.width, height: msg.height });
      return;
    }

    if (!baseFrame || !workState) {
      self.postMessage({
        type: "error",
        requestId: msg.requestId,
        error: "Lab2 worker not initialized",
      });
      return;
    }

    const out = applyLivePostModel2OnlyWithState(
      baseFrame,
      msg.grading,
      workState,
      msg.options
    );
    const copy = new Float32Array(out.data);
    self.postMessage(
      {
        type: "result",
        requestId: msg.requestId,
        width: out.width,
        height: out.height,
        data: copy.buffer,
      },
      // @ts-expect-error transfer list in worker postMessage
      [copy.buffer]
    );
  } catch (err) {
    const msg = e.data as RenderMsg;
    self.postMessage({
      type: "error",
      requestId: msg.requestId ?? -1,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
