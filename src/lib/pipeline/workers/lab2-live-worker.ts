import {
  applyLivePostModel2OnlyWithState,
  createLab2LiveWorkState,
  type Lab2LiveWorkState,
} from "@/lib/lab2-live-preview";
import { downscaleLinearFloatByScale } from "@/lib/scale-linear-float-frame";
import type { LookParams as GradingParams } from "@/src/lib/pipeline/stages/match";
import type { PixelFrameF32 } from "@/src/lib/pipeline/types";
import { pixelFrameF32ToPixelFrameRGBA } from "@/src/lib/pipeline";

type InitMsg = {
  type: "init";
  width: number;
  height: number;
  base: ArrayBuffer;
};

type RenderMsg = {
  type: "render";
  requestId: number;
  renderMode?: "interactive" | "settled";
  grading: GradingParams;
  options?: {
    halationPreview?: boolean;
    interactiveMode?: boolean;
    interactivePreviewScale?: number;
  };
};

type WorkerInMsg = InitMsg | RenderMsg;

let baseFrame: PixelFrameF32 | null = null;
let workState: Lab2LiveWorkState | null = null;
let interactiveBaseCache: Map<number, PixelFrameF32> = new Map();
const now = () => performance.now();

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function getInteractiveBase(scale: number): PixelFrameF32 | null {
  if (!baseFrame) return null;
  const key = Math.round(clamp(scale, 0.1, 1) * 1000) / 1000;
  if (key >= 0.999) return baseFrame;
  const cached = interactiveBaseCache.get(key);
  if (cached) return cached;
  const reduced = downscaleLinearFloatByScale(baseFrame, key);
  interactiveBaseCache.set(key, reduced);
  return reduced;
}

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
      interactiveBaseCache = new Map();
      self.postMessage({ type: "inited", width: msg.width, height: msg.height });
      return;
    }

    if (msg.type !== "render" || !baseFrame || !workState) {
      const reqId = msg.type === "render" ? msg.requestId : -1;
      self.postMessage({
        type: "error",
        requestId: reqId,
        error: "Lab2 worker not initialized",
      });
      return;
    }

    const renderOptions = {
      halationPreview: false,
      interactiveMode: false,
      interactivePreviewScale: 1,
      ...(msg.options ?? {}),
    };
    const interactiveScale = clamp(renderOptions.interactivePreviewScale ?? 1, 0.1, 1);
    const renderBase =
      renderOptions.interactiveMode && interactiveScale < 0.999
        ? getInteractiveBase(interactiveScale)
        : baseFrame;
    if (!renderBase) {
      self.postMessage({
        type: "error",
        requestId: msg.requestId,
        error: "Lab2 worker has no base frame",
      });
      return;
    }
    if (!workState || workState.width !== renderBase.width || workState.height !== renderBase.height) {
      workState = createLab2LiveWorkState(renderBase.width, renderBase.height);
    }

    const tCompute0 = now();
    const out = applyLivePostModel2OnlyWithState(
      renderBase,
      msg.grading,
      workState,
      renderOptions
    );
    const tCompute1 = now();
    const rgba = pixelFrameF32ToPixelFrameRGBA(out);
    const tPack1 = now();
    self.postMessage(
      {
        type: "result",
        requestId: msg.requestId,
        width: rgba.width,
        height: rgba.height,
        data: rgba.data.buffer,
        renderMode: msg.renderMode ?? (renderOptions.interactiveMode ? "interactive" : "settled"),
        telemetry: {
          computeMs: tCompute1 - tCompute0,
          packMs: tPack1 - tCompute1,
          totalWorkerMs: tPack1 - tCompute0,
        },
      },
      // @ts-expect-error transfer list in worker postMessage
      [rgba.data.buffer]
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
