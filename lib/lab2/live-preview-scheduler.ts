import { buildEngineParamsFromLookParams } from "@/lib/build-engine-params";
import type { LookParams as LookParamsT } from "@/lib/look-params";
import {
  applyLivePostModel2OnlyWithState,
  ensureLab2LiveWorkState,
  type Lab2LivePreviewOptions,
  type Lab2LiveWorkState,
} from "@/lib/lab2-live-preview";
import {
  defaultDrawCache,
  drawRgbaToCanvasPreview,
} from "@/lib/lab2/canvas-utils";
import type { RgbaFrame } from "@/lib/lab2/types";
import {
  pixelFrameF32ToPixelFrameRGBA,
  type PixelFrameF32,
} from "@/src/lib/pipeline";

export const EXPENSIVE_DRAG_THROTTLE_MS = 340;
export const NORMAL_DRAG_THROTTLE_MS = 110;
export const INTERACTIVE_PREVIEW_SCALE = 0.32;
export const INTERACTIVE_PREVIEW_SCALE_AGGRESSIVE = 0.25;

type WorkerInitedMsg = { type: "inited"; width: number; height: number };
type WorkerResultMsg = {
  type: "result";
  requestId: number;
  width: number;
  height: number;
  data: ArrayBuffer;
  renderMode?: "interactive" | "settled";
  telemetry?: {
    computeMs?: number;
    packMs?: number;
    totalWorkerMs?: number;
  };
};
type WorkerErrorMsg = { type: "error"; requestId?: number; error: string };
type WorkerMsg = WorkerInitedMsg | WorkerResultMsg | WorkerErrorMsg;

export type ScheduleLiveDrawOpts = {
  forceImmediate?: boolean;
  interactiveExpensive?: boolean;
  halationPreview?: boolean;
  renderMode?: "interactive" | "settled";
  lookParamsOverride?: LookParamsT;
  liveRerenderEnabled?: boolean;
  halationPreviewEnabled?: boolean;
  isDragging?: boolean;
  dragCost?: "expensive" | "normal" | null;
  adaptiveQualityMode?: "normal" | "degraded" | "aggressive";
};

export type Lab2LivePreviewSchedulerConfig = {
  getCanvas: () => HTMLCanvasElement | null;
  getMaxEdge: () => number;
  drawCache?: ReturnType<typeof defaultDrawCache>;
  onSettled?: (rgba: RgbaFrame, lookParams: LookParamsT) => void;
  onError?: (message: string) => void;
};

export type Lab2LivePreviewScheduler = {
  initPreviewBase: (base: PixelFrameF32) => void;
  terminate: () => void;
  drawRgba: (rgba: RgbaFrame) => void;
  scheduleDraw: (
    lookParams: LookParamsT,
    finalGrading: LookParamsT["grading"],
    opts?: ScheduleLiveDrawOpts
  ) => void;
};

export function createLab2LivePreviewScheduler(
  config: Lab2LivePreviewSchedulerConfig
): Lab2LivePreviewScheduler {
  const drawCache = config.drawCache ?? defaultDrawCache();

  let worker: Worker | null = null;
  let workerReady = false;
  let workerInFlight = false;
  let workerQueued = false;
  let latestRenderReqId = 0;
  let latestDrawnReqId = 0;
  let lastDispatchMs = 0;
  let previewBase: PixelFrameF32 | null = null;
  let localWorkState: Lab2LiveWorkState | null = null;
  let liveRaf: number | null = null;

  let queuedEngine: ReturnType<typeof buildEngineParamsFromLookParams> | null =
    null;
  let queuedRenderOptions: Lab2LivePreviewOptions | null = null;
  let queuedLookParams: LookParamsT | null = null;
  let queuedRenderMode: "interactive" | "settled" = "settled";

  const drawToCanvas = (rgba: RgbaFrame, renderMode: "interactive" | "settled") => {
    drawRgbaToCanvasPreview(
      rgba,
      config.getCanvas(),
      config.getMaxEdge(),
      drawCache
    );
    if (renderMode === "settled" && queuedLookParams) {
      config.onSettled?.(rgba, queuedLookParams);
    }
  };

  const dispatchWorkerRender = (
    requestId: number,
    engine: ReturnType<typeof buildEngineParamsFromLookParams>,
    options: Lab2LivePreviewOptions,
    renderMode: "interactive" | "settled"
  ) => {
    if (!worker || !workerReady) return;
    workerInFlight = true;
    worker.postMessage({
      type: "render",
      requestId,
      grading: engine,
      options,
      renderMode,
    });
  };

  const flushQueuedWorkerRender = () => {
    if (!queuedEngine || !workerReady || workerInFlight) return;
    const requestId = ++latestRenderReqId;
    workerInFlight = true;
    const options: Lab2LivePreviewOptions = queuedRenderOptions ?? {
      halationPreview: false,
    };
    const renderMode: "interactive" | "settled" = options.interactiveMode
      ? "interactive"
      : "settled";
    dispatchWorkerRender(requestId, queuedEngine, options, renderMode);
  };

  const terminateWorker = () => {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    workerReady = false;
    workerInFlight = false;
    workerQueued = false;
    latestRenderReqId = 0;
    latestDrawnReqId = 0;
    queuedEngine = null;
    queuedRenderOptions = null;
    queuedLookParams = null;
  };

  const runMainThreadRender = (
    lookParams: LookParamsT,
    finalGrading: LookParamsT["grading"],
    options: Lab2LivePreviewOptions,
    renderMode: "interactive" | "settled"
  ) => {
    if (!previewBase) return;
    localWorkState = ensureLab2LiveWorkState(
      localWorkState,
      previewBase.width,
      previewBase.height
    );
    const engine = buildEngineParamsFromLookParams(lookParams, finalGrading);
    const live = applyLivePostModel2OnlyWithState(
      previewBase,
      engine,
      localWorkState,
      options
    );
    const rgba = pixelFrameF32ToPixelFrameRGBA(live);
    drawToCanvas(rgba, renderMode);
  };

  const initPreviewBase = (base: PixelFrameF32) => {
    previewBase = base;
    localWorkState = ensureLab2LiveWorkState(
      localWorkState,
      base.width,
      base.height
    );
    terminateWorker();

    const nextWorker = new Worker(
      new URL(
        "../../src/lib/pipeline/workers/lab2-live-worker.ts",
        import.meta.url
      )
    );
    worker = nextWorker;

    nextWorker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const msg = e.data;
      if (msg.type === "inited") {
        workerReady = true;
        return;
      }
      if (msg.type === "error") {
        workerInFlight = false;
        config.onError?.(msg.error);
        return;
      }
      workerInFlight = false;
      if (msg.requestId < latestDrawnReqId) return;
      latestDrawnReqId = msg.requestId;
      const rgba: RgbaFrame = {
        width: msg.width,
        height: msg.height,
        data: new Uint8ClampedArray(msg.data),
      };
      const renderMode = msg.renderMode ?? queuedRenderMode;
      drawToCanvas(rgba, renderMode);

      if (!workerQueued) return;
      workerQueued = false;
      flushQueuedWorkerRender();
    };

    nextWorker.onerror = (err) => {
      workerInFlight = false;
      config.onError?.(err.message || "Live worker failed");
    };

    const baseCopy = new Float32Array(base.data);
    nextWorker.postMessage(
      { type: "init", width: base.width, height: base.height, base: baseCopy.buffer },
      [baseCopy.buffer]
    );
  };

  const terminate = () => {
    if (liveRaf != null) {
      cancelAnimationFrame(liveRaf);
      liveRaf = null;
    }
    terminateWorker();
    previewBase = null;
    localWorkState = null;
    lastDispatchMs = 0;
  };

  const drawRgba = (rgba: RgbaFrame) => {
    drawRgbaToCanvasPreview(
      rgba,
      config.getCanvas(),
      config.getMaxEdge(),
      drawCache
    );
  };

  const scheduleDraw = (
    lookParams: LookParamsT,
    finalGrading: LookParamsT["grading"],
    opts: ScheduleLiveDrawOpts = {}
  ) => {
    const forceImmediate = !!opts.forceImmediate;
    const liveRerenderEnabled = opts.liveRerenderEnabled ?? false;
    if (!liveRerenderEnabled && !forceImmediate) return;
    if (!previewBase) return;

    if (liveRaf != null) cancelAnimationFrame(liveRaf);
    liveRaf = requestAnimationFrame(() => {
      liveRaf = null;

      const adaptiveQualityMode = opts.adaptiveQualityMode ?? "normal";
      const interactiveExpensive = !!opts.interactiveExpensive && !forceImmediate;
      const interactiveScale =
        adaptiveQualityMode === "aggressive"
          ? INTERACTIVE_PREVIEW_SCALE_AGGRESSIVE
          : INTERACTIVE_PREVIEW_SCALE;
      const options: Lab2LivePreviewOptions = interactiveExpensive
        ? {
            halationPreview: false,
            interactiveMode: true,
            interactivePreviewScale: interactiveScale,
          }
        : {
            halationPreview:
              opts.halationPreview ?? opts.halationPreviewEnabled ?? false,
            interactiveMode: false,
            interactivePreviewScale: 1,
          };

      const lookForRender = opts.lookParamsOverride ?? lookParams;
      queuedLookParams = lookForRender;
      const engine = buildEngineParamsFromLookParams(lookForRender, finalGrading);
      queuedEngine = engine;
      queuedRenderOptions = options;

      const renderMode: "interactive" | "settled" =
        opts.renderMode ??
        (interactiveExpensive ? "interactive" : "settled");
      queuedRenderMode = renderMode;

      const now = Date.now();
      const throttleMs = interactiveExpensive
        ? EXPENSIVE_DRAG_THROTTLE_MS
        : NORMAL_DRAG_THROTTLE_MS;
      if (!forceImmediate && now - lastDispatchMs < throttleMs) return;
      lastDispatchMs = now;

      if (worker && workerReady) {
        if (workerInFlight) {
          workerQueued = true;
          return;
        }
        const requestId = ++latestRenderReqId;
        dispatchWorkerRender(requestId, engine, options, renderMode);
        return;
      }

      runMainThreadRender(lookForRender, finalGrading, options, renderMode);
    });
  };

  return {
    initPreviewBase,
    terminate,
    drawRgba,
    scheduleDraw,
  };
}
