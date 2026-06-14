"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  DEFAULT_LOOK_PARAMS,
  defaultExposureCurve,
  defaultColorDensityCurve,
  type LookParams as LookParamsT,
} from "@/lib/look-params";
import { buildEngineParamsFromLookParams } from "@/lib/build-engine-params";
import {
  applyLivePostModel2OnlyWithState,
  buildPostModel2BaseFrame,
  clonePixelFrameF32,
  ensureLab2LiveWorkState,
  type Lab2LivePreviewOptions,
  type Lab2LiveWorkState,
} from "@/lib/lab2-live-preview";
import {
  downscaleLinearFloatMaxEdge,
  PREVIEW_LIVE_MAX_EDGE,
} from "@/lib/scale-linear-float-frame";
import { decodeToLinearFloat } from "@/src/lib/pipeline/decode";
import { decodeRd1ToLinearFloat } from "@/src/lib/pipeline/decodeRd1";
import {
  processFramesFloat,
  buildExposureMapFromFloat,
  pixelFrameF32ToPixelFrameRGBA,
  frameToImageData,
  type PixelFrameF32,
} from "@/src/lib/pipeline";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";
import { engineToGrading } from "@/lib/look-params";
import { REFRACTION_POST_MODEL2_HUES_DEG } from "@/src/lib/pipeline/stages/refractionPostModel2";
import {
  imageToChromaticTileEmbeddings,
  imageToColClipTileEmbeddings,
} from "@/src/lib/colclipEmbeddings";
import JSZip from "jszip";

const LAB2_DEFAULTS_STORAGE_KEY = "grader-good:lab2-defaults";
const PREVIEW_MAX_EDGE = 1600;
const LAB2_AUTO_DENSITY_ENABLED = false;
const EXPENSIVE_DRAG_THROTTLE_MS = 340;
const NORMAL_DRAG_THROTTLE_MS = 110;
const INTERACTIVE_PREVIEW_SCALE = 0.32;
const INTERACTIVE_PREVIEW_SCALE_AGGRESSIVE = 0.25;
const ADAPTIVE_SLOW_MS = 220;
const ADAPTIVE_VERY_SLOW_MS = 420;
const LAB2_DEFAULT_EXPOSURE_CURVE = defaultExposureCurve();
const REFRACTION_HUE_NAMES = [
  "deep red",
  "red-orange",
  "amber orange",
  "golden yellow",
  "yellow-green",
  "emerald green",
  "aqua cyan",
  "azure blue",
  "deep cobalt",
  "violet purple",
  "magenta pink",
  "rose crimson",
] as const;
const LAB2_DEFAULT_LOOK_PARAMS: LookParamsT = {
  ...DEFAULT_LOOK_PARAMS,
  match: {
    ...DEFAULT_LOOK_PARAMS.match,
    colorDensityCurveMasterMul: 1.0,
    exposureCurve: {
      ...LAB2_DEFAULT_EXPOSURE_CURVE,
      L_out: [
        0.35,
        0.5,
        0.65,
        ...(LAB2_DEFAULT_EXPOSURE_CURVE.L_out.slice(3)),
      ],
    },
    devignette: {
      ...(DEFAULT_LOOK_PARAMS.match.devignette ?? {
        innerDiameterNorm: 0.65,
        strengthStops: 0,
      }),
      strengthStops: 1.88,
    },
  },
};

function deepMergeLab2(
  base: LookParamsT,
  saved: Partial<LookParamsT>
): LookParamsT {
  return {
    ...base,
    ...saved,
    match: { ...base.match, ...saved.match },
    grading: { ...base.grading, ...saved.grading },
    halation: saved.halation
      ? { ...base.halation, ...saved.halation }
      : base.halation,
    grain: saved.grain ? { ...base.grain, ...saved.grain } : base.grain,
  };
}

function cloneLab2LookParams(params: LookParamsT): LookParamsT {
  return JSON.parse(JSON.stringify(params)) as LookParamsT;
}

type RgbaFrame = ReturnType<typeof pixelFrameF32ToPixelFrameRGBA>;

/** Tile match preset at enqueue/auto-match time — semantic-only vs hybrid weights. */
type Lab2TileBlend = "semantic" | "halfHalf" | "tonalHeavy";

type BulkItem = {
  id: string;
  file: File;
  originalName: string;
  thumbUrl: string | null;
  status: string;
  error?: string;
  processed: boolean;
  autoMatchedRefLabel: string;
  tileBlend: Lab2TileBlend;
  lookParams: LookParamsT;
  liveLookParams: LookParamsT;
  finalGrading: LookParamsT["grading"];
  decodedSource: PixelFrameF32 | null;
  decodedRef: PixelFrameF32 | null;
  postM2Base: PixelFrameF32 | null;
  postM2PreviewBase: PixelFrameF32 | null;
  previewRgba: RgbaFrame | null;
  hasBaked: boolean;
  bakedRgba: RgbaFrame | null;
};

type ProcessSourceResult = {
  decodedSource: PixelFrameF32;
  decodedRef: PixelFrameF32 | null;
  grading: LookParamsT["grading"];
  lookParamsForRender: LookParamsT;
  completionStatus: string;
  autoMatchedRefLabel: string;
  fallbackError?: string;
};

type RenderTelemetrySample = {
  mode: "interactive" | "settled";
  computeMs: number;
  packMs: number;
  transferMs: number;
  drawMs: number;
  totalMs: number;
};

function cloneRgbaFrame(frame: RgbaFrame): RgbaFrame {
  return {
    width: frame.width,
    height: frame.height,
    data: new Uint8ClampedArray(frame.data),
  };
}

function drawFloatToCanvasPreview(
  floatFrame: PixelFrameF32,
  canvas: HTMLCanvasElement | null,
  maxEdge: number,
  drawCache: {
    tempCanvas: HTMLCanvasElement | null;
    imageData: ImageData | null;
    width: number;
    height: number;
  }
) {
  if (!canvas) return;
  const rgba = pixelFrameF32ToPixelFrameRGBA(floatFrame);
  drawRgbaToCanvasPreview(rgba, canvas, maxEdge, drawCache);
}

function drawRgbaToCanvasPreview(
  rgba: { width: number; height: number; data: Uint8ClampedArray },
  canvas: HTMLCanvasElement | null,
  maxEdge: number,
  drawCache: {
    tempCanvas: HTMLCanvasElement | null;
    imageData: ImageData | null;
    width: number;
    height: number;
  }
) {
  if (!canvas) return;
  const { width, height } = rgba;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  let temp = drawCache.tempCanvas;
  if (!temp) {
    temp = document.createElement("canvas");
    drawCache.tempCanvas = temp;
  }
  temp.width = width;
  temp.height = height;
  const tctx = temp.getContext("2d");
  if (!tctx) return;
  if (
    !drawCache.imageData ||
    drawCache.width !== width ||
    drawCache.height !== height
  ) {
    drawCache.imageData = new ImageData(
      new Uint8ClampedArray(width * height * 4),
      width,
      height
    );
    drawCache.width = width;
    drawCache.height = height;
  }
  drawCache.imageData.data.set(rgba.data);
  tctx.putImageData(drawCache.imageData, 0, 0);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(temp, 0, 0, width, height, 0, 0, w, h);
}

function makeSafeFilenamePart(name: string): string {
  const trimmed = name.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
  return safe.replace(/^-+|-+$/g, "") || "image";
}

async function buildThumbUrlFromFloatFrame(floatFrame: PixelFrameF32): Promise<string> {
  const rgba = pixelFrameF32ToPixelFrameRGBA(floatFrame);
  const maxEdge = 250;
  const scale = Math.min(1, maxEdge / Math.max(rgba.width, rgba.height));
  const targetWidth = Math.max(1, Math.round(rgba.width * scale));
  const targetHeight = Math.max(1, Math.round(rgba.height * scale));
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = rgba.width;
  srcCanvas.height = rgba.height;
  const srcCtx = srcCanvas.getContext("2d");
  if (!srcCtx) throw new Error("No 2D context");
  srcCtx.putImageData(frameToImageData(rgba), 0, 0);
  const dstCanvas = document.createElement("canvas");
  dstCanvas.width = targetWidth;
  dstCanvas.height = targetHeight;
  const dstCtx = dstCanvas.getContext("2d");
  if (!dstCtx) throw new Error("No 2D context");
  dstCtx.imageSmoothingEnabled = true;
  dstCtx.imageSmoothingQuality = "high";
  dstCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);
  return dstCanvas.toDataURL("image/jpeg", 0.88);
}

export default function Lab2Page() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceFileRef = useRef<File | null>(null);
  /** When true, source DNG/ERF is decoded via POST /api/decode/rd1 (server LibRaw). */
  const sourceDecodeRd1Ref = useRef(false);
  const refFileRef = useRef<File | null>(null);
  const decodedSourceRef = useRef<PixelFrameF32 | null>(null);
  const decodedRefRef = useRef<PixelFrameF32 | null>(null);
  const postM2BaseRef = useRef<PixelFrameF32 | null>(null);
  const postM2PreviewBaseRef = useRef<PixelFrameF32 | null>(null);
  const bakedRgbaRef = useRef<ReturnType<typeof pixelFrameF32ToPixelFrameRGBA> | null>(
    null
  );
  const liveRafRef = useRef<number | null>(null);
  const drawCacheRef = useRef<{
    tempCanvas: HTMLCanvasElement | null;
    imageData: ImageData | null;
    width: number;
    height: number;
  }>({ tempCanvas: null, imageData: null, width: 0, height: 0 });
  const liveLocalStateRef = useRef<Lab2LiveWorkState | null>(null);
  const liveWorkerRef = useRef<Worker | null>(null);
  const autoMatchedRefFrameRef = useRef<PixelFrameF32 | null>(null);
  const autoMatchedRefLabelRef = useRef<string>("");
  const autoMatchRunIdRef = useRef(0);
  const workerReadyRef = useRef(false);
  const workerInFlightRef = useRef(false);
  const workerQueuedRef = useRef(false);
  const latestRenderReqIdRef = useRef(0);
  const latestDrawnReqIdRef = useRef(0);
  const queuedEngineRef = useRef<ReturnType<typeof buildEngineParamsFromLookParams> | null>(
    null
  );
  const lastDispatchMsRef = useRef(0);
  const queuedRenderOptionsRef = useRef<Lab2LivePreviewOptions | null>(null);
  const renderRequestItemIdRef = useRef<Map<number, string | null>>(new Map());
  const isDraggingRef = useRef(false);
  const lastChangedControlRef = useRef<"expensive" | "normal" | null>(null);
  const bulkItemsRef = useRef<BulkItem[]>([]);
  const itemWorkStateCacheRef = useRef<Map<string, Lab2LiveWorkState>>(new Map());
  const latestDispatchPerfRef = useRef<{ requestId: number; startMs: number; mode: "interactive" | "settled" } | null>(null);
  const telemetryRollingRef = useRef<{
    interactiveMs: number[];
    settledMs: number[];
  }>({ interactiveMs: [], settledMs: [] });
  const activeBulkIdRef = useRef<string | null>(null);

  const [lookParams, setLookParams] = useState<LookParamsT>(() => ({
    ...LAB2_DEFAULT_LOOK_PARAMS,
  }));
  const [liveLookParams, setLiveLookParams] = useState<LookParamsT>(() => ({
    ...LAB2_DEFAULT_LOOK_PARAMS,
  }));
  const [finalGrading, setFinalGrading] = useState(LAB2_DEFAULT_LOOK_PARAMS.grading);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgressPct, setExportProgressPct] = useState(0);
  const [exportProgressLabel, setExportProgressLabel] = useState("");
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveDirty, setLiveDirty] = useState(false);
  const [model2Strength, setModel2Strength] = useState(1);
  const [model2Robust, setModel2Robust] = useState(true);
  const [hasMatch, setHasMatch] = useState(false);
  const [hasBaked, setHasBaked] = useState(false);
  const [showBakedHold, setShowBakedHold] = useState(false);
  const [liveRerenderEnabled, setLiveRerenderEnabled] = useState(false);
  const [bulkItems, setBulkItems] = useState<BulkItem[]>([]);
  const [activeBulkId, setActiveBulkId] = useState<string | null>(null);
  const [bulkQueue, setBulkQueue] = useState<string[]>([]);
  const [bulkProcessingIndex, setBulkProcessingIndex] = useState(0);
  const [bulkTotal, setBulkTotal] = useState(0);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [showPerfDebug, setShowPerfDebug] = useState(false);
  const [halationPreviewEnabled, setHalationPreviewEnabled] = useState(false);
  /** When false (default), PNG exports skip halation + actuance for speed. */
  const [exportHalationActuance, setExportHalationActuance] = useState(false);
  const [lastRenderTelemetry, setLastRenderTelemetry] = useState<RenderTelemetrySample | null>(null);
  const [tileBlend, setTileBlend] = useState<Lab2TileBlend>("semantic");
  const [sourceDecodeRd1, setSourceDecodeRd1] = useState(false);
  const [adaptiveQualityMode, setAdaptiveQualityMode] = useState<"normal" | "degraded" | "aggressive">("normal");
  const [expensiveDragBlocked, setExpensiveDragBlocked] = useState(false);

  const decodeSourceToLinearFloat = useCallback(async (file: File) => {
    if (sourceDecodeRd1Ref.current) {
      return decodeRd1ToLinearFloat(file);
    }
    return decodeToLinearFloat(file);
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAB2_DEFAULTS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<LookParamsT>;
        const merged = deepMergeLab2(LAB2_DEFAULT_LOOK_PARAMS, parsed);
        setLookParams(merged);
        setLiveLookParams(merged);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    bulkItemsRef.current = bulkItems;
  }, [bulkItems]);

  useEffect(() => {
    activeBulkIdRef.current = activeBulkId;
  }, [activeBulkId]);

  const saveDefaults = useCallback(() => {
    try {
      localStorage.setItem(LAB2_DEFAULTS_STORAGE_KEY, JSON.stringify(lookParams));
      setStatus("Saved current settings as Lab2 defaults.");
    } catch {
      setStatus("Could not save defaults.");
    }
  }, [lookParams]);

  const resetToLab2Defaults = useCallback(() => {
    const reset = cloneLab2LookParams(LAB2_DEFAULT_LOOK_PARAMS);
    setLookParams(reset);
    setLiveLookParams(reset);
    setFinalGrading(reset.grading);
    try {
      localStorage.removeItem(LAB2_DEFAULTS_STORAGE_KEY);
      setStatus("Reset to Lab2 baseline defaults.");
    } catch {
      setStatus("Reset to Lab2 baseline defaults (local save could not be cleared).");
    }
  }, []);

  const patchBulkItem = useCallback((id: string, patch: Partial<BulkItem>) => {
    setBulkItems((items) => {
      const next = items.map((item) => (item.id === id ? { ...item, ...patch } : item));
      bulkItemsRef.current = next;
      return next;
    });
  }, []);

  const setPostM2Bases = useCallback((full: PixelFrameF32) => {
    postM2BaseRef.current = full;
    const preview = downscaleLinearFloatMaxEdge(full, PREVIEW_LIVE_MAX_EDGE);
    postM2PreviewBaseRef.current = preview;
    liveLocalStateRef.current = ensureLab2LiveWorkState(
      liveLocalStateRef.current,
      preview.width,
      preview.height
    );
    return preview;
  }, []);

  const initLiveWorker = useCallback((base: PixelFrameF32) => {
    if (liveWorkerRef.current) liveWorkerRef.current.terminate();
    const worker = new Worker(
      new URL("../../src/lib/pipeline/workers/lab2-live-worker.ts", import.meta.url)
    );
    liveWorkerRef.current = worker;
    workerReadyRef.current = false;
    workerInFlightRef.current = false;
    workerQueuedRef.current = false;
    latestRenderReqIdRef.current = 0;
    latestDrawnReqIdRef.current = 0;
    queuedEngineRef.current = null;
    queuedRenderOptionsRef.current = null;
    renderRequestItemIdRef.current.clear();

    worker.onmessage = (e: MessageEvent<unknown>) => {
      const msg = e.data as
        | { type: "inited"; width: number; height: number }
        | {
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
          }
        | { type: "error"; requestId?: number; error: string };
      if (msg.type === "inited") {
        workerReadyRef.current = true;
        return;
      }
      if (msg.type === "error") {
        workerInFlightRef.current = false;
        setLiveBusy(false);
        setStatus(msg.error);
        return;
      }
      workerInFlightRef.current = false;
      if (msg.requestId < latestDrawnReqIdRef.current) return;
      latestDrawnReqIdRef.current = msg.requestId;
      const requestItemId = renderRequestItemIdRef.current.get(msg.requestId) ?? null;
      renderRequestItemIdRef.current.delete(msg.requestId);
      const currentActiveId = activeBulkIdRef.current;
      // Ignore stale results targeted at a no-longer-active bulk item.
      if (requestItemId && currentActiveId && requestItemId !== currentActiveId) {
        if (!workerQueuedRef.current) {
          setLiveBusy(false);
          setLiveDirty(false);
        }
        return;
      }
      const tDraw0 = performance.now();
      const rgba = {
        width: msg.width,
        height: msg.height,
        data: new Uint8ClampedArray(msg.data),
      };
      drawRgbaToCanvasPreview(
        rgba,
        canvasRef.current,
        PREVIEW_MAX_EDGE,
        drawCacheRef.current
      );
      const tDraw1 = performance.now();
      const dispatch = latestDispatchPerfRef.current;
      const transferMs =
        dispatch && dispatch.requestId === msg.requestId
          ? Math.max(0, tDraw0 - dispatch.startMs - (msg.telemetry?.totalWorkerMs ?? 0))
          : 0;
      const sample: RenderTelemetrySample = {
        mode: msg.renderMode ?? dispatch?.mode ?? "settled",
        computeMs: msg.telemetry?.computeMs ?? 0,
        packMs: msg.telemetry?.packMs ?? 0,
        transferMs,
        drawMs: tDraw1 - tDraw0,
        totalMs:
          dispatch && dispatch.requestId === msg.requestId
            ? tDraw1 - dispatch.startMs
            : (msg.telemetry?.totalWorkerMs ?? 0) + (tDraw1 - tDraw0),
      };
      setLastRenderTelemetry(sample);
      const bucket =
        sample.mode === "interactive"
          ? telemetryRollingRef.current.interactiveMs
          : telemetryRollingRef.current.settledMs;
      bucket.push(sample.totalMs);
      if (bucket.length > 12) bucket.shift();
      if (requestItemId) {
        patchBulkItem(requestItemId, {
          previewRgba: cloneRgbaFrame(rgba),
        });
      }
      if (!workerQueuedRef.current) {
        setLiveBusy(false);
        setLiveDirty(false);
        return;
      }
      workerQueuedRef.current = false;
      const queuedEngine = queuedEngineRef.current;
      if (!queuedEngine || !workerReadyRef.current || workerInFlightRef.current) return;
      const requestId = ++latestRenderReqIdRef.current;
      workerInFlightRef.current = true;
      setLiveBusy(true);
      const options: Lab2LivePreviewOptions =
        queuedRenderOptionsRef.current ?? {
          halationPreview: false,
        };
      const renderMode: "interactive" | "settled" =
        options.interactiveMode ? "interactive" : "settled";
      latestDispatchPerfRef.current = {
        requestId,
        startMs: performance.now(),
        mode: renderMode,
      };
      renderRequestItemIdRef.current.set(requestId, activeBulkIdRef.current);
      worker.postMessage({ type: "render", requestId, grading: queuedEngine, options, renderMode });
    };
    worker.onerror = (err) => {
      workerInFlightRef.current = false;
      setLiveBusy(false);
      setStatus(err.message || "Live worker failed");
    };

    const baseCopy = new Float32Array(base.data);
    worker.postMessage(
      { type: "init", width: base.width, height: base.height, base: baseCopy.buffer },
      [baseCopy.buffer]
    );
  }, [patchBulkItem]);

  const activateBulkItem = useCallback((item: BulkItem) => {
    setActiveBulkId(item.id);
    sourceFileRef.current = item.file;
    decodedSourceRef.current = item.decodedSource;
    decodedRefRef.current = item.decodedRef;
    postM2BaseRef.current = item.postM2Base;
    postM2PreviewBaseRef.current =
      item.postM2PreviewBase ??
      (item.postM2Base
        ? downscaleLinearFloatMaxEdge(item.postM2Base, PREVIEW_LIVE_MAX_EDGE)
        : null);
    bakedRgbaRef.current = item.bakedRgba;
    autoMatchedRefFrameRef.current = item.decodedRef;
    autoMatchedRefLabelRef.current = item.autoMatchedRefLabel;
    setLookParams(cloneLab2LookParams(item.lookParams));
    setLiveLookParams(cloneLab2LookParams(item.liveLookParams));
    setFinalGrading(item.finalGrading);
    setHasBaked(item.hasBaked);
    setHasMatch(!!item.postM2Base);
    setStatus(item.status);
    setLiveDirty(false);
    const baseFrame = item.postM2Base;
    const previewBase = postM2PreviewBaseRef.current;
    if (!baseFrame || !previewBase) return;
    if (item.previewRgba) {
      drawRgbaToCanvasPreview(
        item.previewRgba,
        canvasRef.current,
        PREVIEW_MAX_EDGE,
        drawCacheRef.current
      );
      // Defer worker re-init so thumbnail switching feels instant.
      window.setTimeout(() => {
        if (postM2BaseRef.current === baseFrame) {
          initLiveWorker(previewBase);
        }
      }, 0);
      return;
    }
    const cachedState =
      itemWorkStateCacheRef.current.get(item.id) ?? liveLocalStateRef.current;
    liveLocalStateRef.current = ensureLab2LiveWorkState(
      cachedState,
      previewBase.width,
      previewBase.height
    );
    itemWorkStateCacheRef.current.set(item.id, liveLocalStateRef.current);
    initLiveWorker(previewBase);
    const engine = buildEngineParamsFromLookParams(item.liveLookParams, item.finalGrading);
    const live = applyLivePostModel2OnlyWithState(
      previewBase,
      engine,
      liveLocalStateRef.current,
      { halationPreview: false }
    );
    drawFloatToCanvasPreview(
      live,
      canvasRef.current,
      PREVIEW_MAX_EDGE,
      drawCacheRef.current
    );
  }, [initLiveWorker]);

  const activateBulkItemById = useCallback((id: string) => {
    const item = bulkItemsRef.current.find((entry) => entry.id === id);
    if (!item) return;
    activateBulkItem(item);
  }, [activateBulkItem]);

  const buildPostModel2Artifacts = useCallback((
    decodedSource: PixelFrameF32,
    decodedRef: PixelFrameF32 | null,
    grading: LookParamsT["grading"],
    lookParamsForRender: LookParamsT
  ) => {
    const engine = buildEngineParamsFromLookParams(lookParamsForRender, grading);
    const pipelineParams = {
      strength: model2Strength,
      grading: engine,
      exposureMap: buildExposureMapFromFloat(decodedSource),
      matchModel: 2 as const,
      model2Strength,
      model2RobustSampling: model2Robust,
    };
    const base = buildPostModel2BaseFrame(
      decodedSource,
      decodedRef,
      pipelineParams
    );
    const preview = downscaleLinearFloatMaxEdge(base, PREVIEW_LIVE_MAX_EDGE);
    const tempState = ensureLab2LiveWorkState(null, preview.width, preview.height);
    const live = applyLivePostModel2OnlyWithState(preview, engine, tempState, {
      halationPreview: false,
    });
    return { base, preview, live };
  }, [model2Robust, model2Strength]);

  const renderPostModel2Preview = useCallback((
    decodedSource: PixelFrameF32,
    decodedRef: PixelFrameF32 | null,
    grading: LookParamsT["grading"],
    completionStatus: string,
    lookParamsForRender?: LookParamsT
  ): { base: PixelFrameF32; live: PixelFrameF32 } => {
    const activeLookParams = lookParamsForRender ?? lookParams;
    setFinalGrading(grading);
    decodedRefRef.current = decodedRef;
    setStatus("Model 2 match…");
    const { base, preview, live } = buildPostModel2Artifacts(
      decodedSource,
      decodedRef,
      grading,
      activeLookParams
    );
    setPostM2Bases(base);
    initLiveWorker(preview);
    setHasMatch(true);
    bakedRgbaRef.current = null;
    setHasBaked(false);
    drawFloatToCanvasPreview(
      live,
      canvasRef.current,
      PREVIEW_MAX_EDGE,
      drawCacheRef.current
    );
    setStatus(completionStatus);
    return { base, live };
  }, [buildPostModel2Artifacts, initLiveWorker, lookParams, setPostM2Bases]);

  const processSourceFileAuto = useCallback(async (
    sourceFile: File,
    runId: number,
    onStatus: (text: string) => void,
    lookParamsSeed: LookParamsT,
    opts?: { tileBlend?: Lab2TileBlend }
  ): Promise<ProcessSourceResult | null> => {
    const blend = opts?.tileBlend ?? "semantic";
    const useHybridTiles = blend === "halfHalf" || blend === "tonalHeavy";
    const isStale = () => runId !== autoMatchRunIdRef.current;
    let decodedSource: PixelFrameF32 | null = null;
    try {
      onStatus("Decoding source RAW…");
      decodedSource = await decodeSourceToLinearFloat(sourceFile);
      if (isStale()) return null;
      onStatus("Computing 10x10 tile embeddings…");
      const sourcePreviewRgba = pixelFrameF32ToPixelFrameRGBA(decodedSource);
      const sourceImageData = frameToImageData(sourcePreviewRgba);
      const tileEmbeddings = await imageToColClipTileEmbeddings(
        sourceImageData,
        10,
        10,
        (current, total) => {
          if (isStale()) return;
          onStatus(`Computing 10x10 tile embeddings… ${current}/${total}`);
        }
      );
      if (isStale()) return null;
      let chromaTiles: number[][] | null = null;
      if (useHybridTiles) {
        onStatus("Computing 10×10 chroma (a/b) histograms…");
        chromaTiles = imageToChromaticTileEmbeddings(sourceImageData, 10, 10);
      }
      if (isStale()) return null;
      onStatus("Searching dataset matches…");
      const searchRes = await fetch("/api/dataset/search?limit=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          useHybridTiles && blend === "tonalHeavy" && chromaTiles
            ? {
                combineTileTonal: true,
                w_semantic: 0.1,
                w_tonal: 0.9,
                tileEmbeddings: tileEmbeddings.map((embedding, idx) => ({
                  tile_index: idx,
                  embedding,
                  embedding_tonal_chroma: chromaTiles[idx]!,
                })),
              }
            : useHybridTiles && chromaTiles
              ? {
                  combineTileTonal: true,
                  tileEmbeddings: tileEmbeddings.map((embedding, idx) => ({
                    tile_index: idx,
                    embedding,
                    embedding_tonal_chroma: chromaTiles[idx]!,
                  })),
                }
              : {
                  tileEmbeddings: tileEmbeddings.map((embedding, idx) => ({
                    tile_index: idx,
                    embedding,
                  })),
                }
        ),
      });
      const searchData = (await searchRes.json()) as {
        error?: string;
        matches?: Array<{ image_url?: unknown; name?: unknown }>;
      };
      if (!searchRes.ok) {
        throw new Error(searchData.error ?? "Dataset search failed.");
      }
      const top = searchData.matches?.[0];
      if (!top) throw new Error("No dataset matches found.");
      const imageUrl = typeof top.image_url === "string" ? top.image_url : "";
      if (!imageUrl) throw new Error("Top dataset match is missing image_url.");
      onStatus("Fetching matched reference…");
      const refRes = await fetch(imageUrl);
      if (!refRes.ok) {
        throw new Error(`Failed to fetch matched reference (${refRes.status}).`);
      }
      const refBlob = await refRes.blob();
      if (isStale()) return null;
      const refLabel =
        typeof top.name === "string" && top.name.trim().length > 0
          ? top.name.trim()
          : "dataset match";
      const extFromType = refBlob.type?.split("/")[1] ?? "png";
      const matchedRefFile = new File(
        [refBlob],
        `lab2-auto-reference.${extFromType}`,
        { type: refBlob.type || "image/png" }
      );
      onStatus("Decoding matched reference…");
      const decodedRef = await decodeToLinearFloat(matchedRefFile);
      if (isStale()) return null;
      onStatus("Fitting grading from matched reference…");
      const grading = engineToGrading(fitLookParamsFromReference(decodedRef));
      if (LAB2_AUTO_DENSITY_ENABLED) {
        // Feature-flagged off by default for now; keep block ready for re-enable.
      }
      return {
        decodedSource,
        decodedRef,
        grading,
        lookParamsForRender: cloneLab2LookParams(lookParamsSeed),
        completionStatus: `Auto match complete (${refLabel}). Post–Model 2 preview is live.`,
        autoMatchedRefLabel: refLabel,
      };
    } catch (e) {
      if (isStale()) return null;
      const message = e instanceof Error ? e.message : String(e);
      if (!decodedSource) {
        throw e;
      }
      return {
        decodedSource,
        decodedRef: null,
        grading: lookParamsSeed.grading,
        lookParamsForRender: cloneLab2LookParams(lookParamsSeed),
        completionStatus:
          `Auto embedding match failed: ${message}. Showing source-only preview; use Match / refresh base to retry.`,
        autoMatchedRefLabel: "",
        fallbackError: message,
      };
    }
  }, [decodeSourceToLinearFloat]);

  const runAutoEmbeddingModel2Match = useCallback(async (
    sourceFileOverride?: File,
    bulkItemId?: string,
    providedRunId?: number,
    lookParamsOverride?: LookParamsT,
    tileBlendSnapshot?: Lab2TileBlend
  ) => {
    const sourceFile = sourceFileOverride ?? sourceFileRef.current;
    if (!sourceFile) {
      setStatus("Choose a source file first.");
      return;
    }
    const runId = providedRunId ?? ++autoMatchRunIdRef.current;
    if (providedRunId == null) {
      autoMatchRunIdRef.current = runId;
    }
    const isStale = () => runId !== autoMatchRunIdRef.current;
    setBusy(true);
    setHasMatch(false);
    autoMatchedRefFrameRef.current = null;
    autoMatchedRefLabelRef.current = "";
    try {
      const lookSeed = cloneLab2LookParams(lookParamsOverride ?? lookParams);
      const result = await processSourceFileAuto(
        sourceFile,
        runId,
        (text) => {
          setStatus(text);
          if (bulkItemId) patchBulkItem(bulkItemId, { status: text });
        },
        lookSeed,
        { tileBlend: tileBlendSnapshot ?? "semantic" }
      );
      if (!result || isStale()) return;
      const shouldRenderMainPreview =
        !bulkItemId || !activeBulkId || activeBulkId === bulkItemId;
      let base: PixelFrameF32;
      let preview: PixelFrameF32;
      let live: PixelFrameF32;
      if (shouldRenderMainPreview) {
        decodedSourceRef.current = result.decodedSource;
        decodedRefRef.current = result.decodedRef;
        autoMatchedRefFrameRef.current = result.decodedRef;
        autoMatchedRefLabelRef.current = result.autoMatchedRefLabel;
        setLookParams(result.lookParamsForRender);
        setLiveLookParams(result.lookParamsForRender);
        ({ base, live } = renderPostModel2Preview(
          result.decodedSource,
          result.decodedRef,
          result.grading,
          result.completionStatus,
          result.lookParamsForRender
        ));
        preview = postM2PreviewBaseRef.current!;
      } else {
        ({ base, preview, live } = buildPostModel2Artifacts(
          result.decodedSource,
          result.decodedRef,
          result.grading,
          result.lookParamsForRender
        ));
      }
      if (bulkItemId) {
        const previewRgba = pixelFrameF32ToPixelFrameRGBA(live);
        const thumbUrl = await buildThumbUrlFromFloatFrame(live);
        patchBulkItem(bulkItemId, {
          decodedSource: clonePixelFrameF32(result.decodedSource),
          decodedRef: result.decodedRef ? clonePixelFrameF32(result.decodedRef) : null,
          postM2Base: clonePixelFrameF32(base),
          postM2PreviewBase: clonePixelFrameF32(preview),
          previewRgba: cloneRgbaFrame(previewRgba),
          lookParams: cloneLab2LookParams(result.lookParamsForRender),
          liveLookParams: cloneLab2LookParams(result.lookParamsForRender),
          finalGrading: result.grading,
          thumbUrl,
          status: result.completionStatus,
          autoMatchedRefLabel: result.autoMatchedRefLabel,
          processed: true,
          error: result.fallbackError,
          hasBaked: false,
          bakedRgba: null,
        });
      }
    } catch (e) {
      if (isStale()) return;
      const message = e instanceof Error ? e.message : String(e);
      setStatus(`Auto embedding match failed: ${message}`);
      if (bulkItemId) {
        patchBulkItem(bulkItemId, {
          status: `Auto embedding match failed: ${message}`,
          error: message,
          processed: true,
        });
      }
    } finally {
      if (!isStale()) {
        setBusy(false);
      }
    }
  }, [
    activeBulkId,
    buildPostModel2Artifacts,
    lookParams,
    patchBulkItem,
    processSourceFileAuto,
    renderPostModel2Preview,
  ]);

  const runMatch = useCallback(async () => {
    const sourceFile = sourceFileRef.current;
    if (!sourceFile) {
      setStatus("Choose a source file first.");
      return;
    }
    setBusy(true);
    setStatus("Decoding…");
    try {
      const decodedSource = await decodeSourceToLinearFloat(sourceFile);
      decodedSourceRef.current = decodedSource;
      const refFile = refFileRef.current;
      let decodedRef: PixelFrameF32 | null = null;
      let grading = lookParams.grading;
      let completionStatus = "Source only — no reference. Post–Model 2 still works.";
      if (refFile) {
        setStatus("Decoding reference…");
        decodedRef = await decodeToLinearFloat(refFile);
        const engineFit = fitLookParamsFromReference(decodedRef);
        grading = engineToGrading(engineFit);
        completionStatus =
          "Match complete from manual reference. Adjust post–Model 2 sliders (live).";
      } else if (autoMatchedRefFrameRef.current) {
        decodedRef = autoMatchedRefFrameRef.current;
        const engineFit = fitLookParamsFromReference(decodedRef);
        grading = engineToGrading(engineFit);
        const label = autoMatchedRefLabelRef.current || "dataset match";
        completionStatus =
          `Match refreshed from auto dataset reference (${label}).`;
      }
      const { base, live } = renderPostModel2Preview(
        decodedSource,
        decodedRef,
        grading,
        completionStatus
      );
      if (activeBulkId) {
        const previewRgba = pixelFrameF32ToPixelFrameRGBA(live);
        const thumbUrl = await buildThumbUrlFromFloatFrame(live);
        const preview = downscaleLinearFloatMaxEdge(base, PREVIEW_LIVE_MAX_EDGE);
        patchBulkItem(activeBulkId, {
          decodedSource: clonePixelFrameF32(decodedSource),
          decodedRef: decodedRef ? clonePixelFrameF32(decodedRef) : null,
          postM2Base: clonePixelFrameF32(base),
          postM2PreviewBase: clonePixelFrameF32(preview),
          previewRgba: cloneRgbaFrame(previewRgba),
          lookParams: cloneLab2LookParams(lookParams),
          liveLookParams: cloneLab2LookParams(liveLookParams),
          finalGrading: grading,
          status: completionStatus,
          thumbUrl,
          processed: true,
          autoMatchedRefLabel: autoMatchedRefLabelRef.current,
          hasBaked: false,
          bakedRgba: null,
        });
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [activeBulkId, decodeSourceToLinearFloat, liveLookParams, lookParams, patchBulkItem, renderPostModel2Preview]);

  const runBulkQueueSequentially = useCallback(async (itemIds: string[]) => {
    if (!itemIds.length) return;
    setBulkRunning(true);
    setBulkTotal(itemIds.length);
    setBulkProcessingIndex(0);
    setBulkQueue(itemIds);
    const runId = ++autoMatchRunIdRef.current;
    for (let idx = 0; idx < itemIds.length; idx += 1) {
      if (runId !== autoMatchRunIdRef.current) break;
      const id = itemIds[idx];
      const item = bulkItemsRef.current.find((entry) => entry.id === id);
      if (!item) continue;
      setBulkProcessingIndex(idx + 1);
      patchBulkItem(id, {
        status: `processing file ${idx + 1} of ${itemIds.length}…`,
        processed: false,
        error: undefined,
      });
      sourceFileRef.current = item.file;
      if (!activeBulkId && idx === 0) setActiveBulkId(id);
      await runAutoEmbeddingModel2Match(
        item.file,
        id,
        runId,
        cloneLab2LookParams(item.lookParams),
        item.tileBlend
      );
      if (runId !== autoMatchRunIdRef.current) break;
      if (idx === 0 || activeBulkId === id) {
        activateBulkItemById(id);
      }
    }
    if (runId === autoMatchRunIdRef.current) {
      setBulkRunning(false);
      setBulkQueue([]);
      setBulkProcessingIndex(0);
      setBulkTotal(0);
      setStatus("Bulk queue finished.");
    }
  }, [activateBulkItemById, activeBulkId, patchBulkItem, runAutoEmbeddingModel2Match]);

  const startBulkUpload = useCallback((files: File[]) => {
    const limited = files.slice(0, 36);
    autoMatchRunIdRef.current += 1;
    setBulkRunning(false);
    setBulkQueue([]);
    setBulkProcessingIndex(0);
    setBulkTotal(0);
    setHasMatch(false);
    setHasBaked(false);
    const created: BulkItem[] = limited.map((file, idx) => ({
      id: `bulk-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      originalName: file.name,
      thumbUrl: null,
      status: "queued",
      processed: false,
      autoMatchedRefLabel: "",
      tileBlend,
      lookParams: cloneLab2LookParams(lookParams),
      liveLookParams: cloneLab2LookParams(lookParams),
      finalGrading: lookParams.grading,
      decodedSource: null,
      decodedRef: null,
      postM2Base: null,
      postM2PreviewBase: null,
      previewRgba: null,
      hasBaked: false,
      bakedRgba: null,
    }));
    setBulkItems((prev) => {
      prev.forEach((item) => {
        if (item.thumbUrl?.startsWith("blob:")) URL.revokeObjectURL(item.thumbUrl);
      });
      return created;
    });
    // Keep ref in sync immediately so the queue can resolve files before the next render.
    bulkItemsRef.current = created;
    const ids = created.map((item) => item.id);
    setActiveBulkId(ids[0] ?? null);
    if (ids.length > 0) {
      void runBulkQueueSequentially(ids);
    }
  }, [tileBlend, lookParams, runBulkQueueSequentially]);

  const deleteBulkItem = useCallback((id: string) => {
    const current = bulkItemsRef.current;
    const target = current.find((item) => item.id === id);
    if (target?.thumbUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(target.thumbUrl);
    }
    const next = current.filter((item) => item.id !== id);
    setBulkItems(next);
    bulkItemsRef.current = next;
    if (!next.length) {
      setActiveBulkId(null);
      setHasMatch(false);
      setStatus("Bulk item removed.");
    } else if (activeBulkId === id) {
      activateBulkItemById(next[0].id);
    }
    setBulkQueue((q) => q.filter((entry) => entry !== id));
  }, [activateBulkItemById, activeBulkId]);

  const scheduleLiveDraw = useCallback((opts?: {
    forceImmediate?: boolean;
    interactiveExpensive?: boolean;
    halationPreviewEnabled?: boolean;
    renderMode?: "interactive" | "settled";
    lookParamsOverride?: LookParamsT;
  }) => {
    const forceImmediate = !!opts?.forceImmediate;
    if (!liveRerenderEnabled && !forceImmediate) return;
    if (liveRafRef.current != null) cancelAnimationFrame(liveRafRef.current);
    liveRafRef.current = requestAnimationFrame(() => {
      liveRafRef.current = null;
      const base = postM2PreviewBaseRef.current;
      if (!base || showBakedHold) return;
      const interactiveExpensive = !!opts?.interactiveExpensive && !forceImmediate;
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
            halationPreview: opts?.halationPreviewEnabled ?? halationPreviewEnabled,
            interactiveMode: false,
            interactivePreviewScale: 1,
          };
      const lookForRender = opts?.lookParamsOverride ?? liveLookParams;
      const engine = buildEngineParamsFromLookParams(lookForRender, finalGrading);
      queuedEngineRef.current = engine;
      queuedRenderOptionsRef.current = options;
      setLiveDirty(true);
      const now = Date.now();
      const throttleMs = interactiveExpensive
        ? EXPENSIVE_DRAG_THROTTLE_MS
        : NORMAL_DRAG_THROTTLE_MS;
      if (!forceImmediate && now - lastDispatchMsRef.current < throttleMs) return;
      lastDispatchMsRef.current = now;

      const worker = liveWorkerRef.current;
      if (worker && workerReadyRef.current) {
        if (workerInFlightRef.current) {
          workerQueuedRef.current = true;
          setLiveBusy(true);
          return;
        }
        const requestId = ++latestRenderReqIdRef.current;
        workerInFlightRef.current = true;
        setLiveBusy(true);
        const renderMode =
          opts?.renderMode ?? (interactiveExpensive ? "interactive" : "settled");
        latestDispatchPerfRef.current = {
          requestId,
          startMs: performance.now(),
          mode: renderMode,
        };
        renderRequestItemIdRef.current.set(requestId, activeBulkIdRef.current);
        worker.postMessage({ type: "render", requestId, grading: engine, options, renderMode });
        return;
      }
      setLiveBusy(true);
      liveLocalStateRef.current = ensureLab2LiveWorkState(
        liveLocalStateRef.current,
        base.width,
        base.height
      );
      const live = applyLivePostModel2OnlyWithState(
        base,
        engine,
        liveLocalStateRef.current,
        options
      );
      const tDraw0 = performance.now();
      const rgba = pixelFrameF32ToPixelFrameRGBA(live);
      drawRgbaToCanvasPreview(
        rgba,
        canvasRef.current,
        PREVIEW_MAX_EDGE,
        drawCacheRef.current
      );
      const tDraw1 = performance.now();
      setLastRenderTelemetry({
        mode: opts?.renderMode ?? (interactiveExpensive ? "interactive" : "settled"),
        computeMs: tDraw1 - tDraw0,
        packMs: 0,
        transferMs: 0,
        drawMs: 0,
        totalMs: tDraw1 - tDraw0,
      });
      const activeId = activeBulkIdRef.current;
      if (activeId) {
        patchBulkItem(activeId, {
          previewRgba: cloneRgbaFrame(rgba),
          liveLookParams: cloneLab2LookParams(lookForRender),
          lookParams: cloneLab2LookParams(lookParams),
          finalGrading,
        });
      }
      setLiveBusy(false);
      setLiveDirty(false);
    });
  }, [
    adaptiveQualityMode,
    finalGrading,
    halationPreviewEnabled,
    liveRerenderEnabled,
    liveLookParams,
    lookParams,
    patchBulkItem,
    showBakedHold,
  ]);

  const renderEditsNow = useCallback(() => {
    if (!hasMatch || showBakedHold) return;
    setLiveLookParams(lookParams);
    scheduleLiveDraw({ forceImmediate: true, lookParamsOverride: lookParams });
  }, [hasMatch, showBakedHold, lookParams, scheduleLiveDraw]);

  const toggleHalationPreview = useCallback(() => {
    if (!hasMatch || showBakedHold) return;
    const next = !halationPreviewEnabled;
    setHalationPreviewEnabled(next);
    setLiveLookParams(lookParams);
    scheduleLiveDraw({
      forceImmediate: true,
      halationPreviewEnabled: next,
      lookParamsOverride: lookParams,
    });
    setStatus(next ? "Halation preview mode enabled (approximate)." : "Halation preview mode disabled.");
  }, [halationPreviewEnabled, hasMatch, lookParams, scheduleLiveDraw, showBakedHold]);

  useEffect(() => {
    setLiveDirty(true);
    if (!liveRerenderEnabled) return;
    if (
      isDraggingRef.current &&
      (lastChangedControlRef.current === "expensive" || adaptiveQualityMode === "aggressive")
    ) {
      setExpensiveDragBlocked(true);
      return;
    }
    const t = window.setTimeout(() => {
      setExpensiveDragBlocked(false);
      setLiveLookParams(lookParams);
    }, 120);
    return () => window.clearTimeout(t);
  }, [adaptiveQualityMode, lookParams, liveRerenderEnabled]);

  useEffect(() => {
    if (!liveRerenderEnabled) return;
    if (!hasMatch || showBakedHold) return;
    scheduleLiveDraw({
      interactiveExpensive:
        isDraggingRef.current &&
        (lastChangedControlRef.current === "expensive" || adaptiveQualityMode !== "normal"),
      renderMode:
        isDraggingRef.current &&
        (lastChangedControlRef.current === "expensive" || adaptiveQualityMode !== "normal")
          ? "interactive"
          : "settled",
    });
  }, [
    adaptiveQualityMode,
    finalGrading,
    hasMatch,
    liveLookParams,
    liveRerenderEnabled,
    scheduleLiveDraw,
    showBakedHold,
  ]);

  useEffect(() => {
    const onPointerUp = () => {
      const wasDragging = isDraggingRef.current;
      isDraggingRef.current = false;
      if (!liveRerenderEnabled || !wasDragging) return;
      if (!hasMatch || showBakedHold) return;
      setExpensiveDragBlocked(false);
      setLiveLookParams(lookParams);
      scheduleLiveDraw({
        forceImmediate: true,
        renderMode: "settled",
        lookParamsOverride: lookParams,
      });
    };
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("touchend", onPointerUp);
    return () => {
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("touchend", onPointerUp);
    };
  }, [liveRerenderEnabled, hasMatch, showBakedHold, lookParams, scheduleLiveDraw]);

  useEffect(() => {
    if (!liveRerenderEnabled || !hasMatch || showBakedHold) return;
    setLiveLookParams(lookParams);
    scheduleLiveDraw({ forceImmediate: true });
  }, [liveRerenderEnabled, hasMatch, showBakedHold, lookParams, scheduleLiveDraw]);

  useEffect(() => {
    if (!activeBulkId) return;
    // Only persist the editable parameter state here. Frame refs are updated
    // by explicit per-item processing/apply handlers to avoid cross-item leakage
    // while the bulk queue is processing in the background.
    patchBulkItem(activeBulkId, {
      lookParams: cloneLab2LookParams(lookParams),
      liveLookParams: cloneLab2LookParams(liveLookParams),
      finalGrading,
    });
  }, [
    activeBulkId,
    finalGrading,
    liveLookParams,
    lookParams,
    patchBulkItem,
  ]);

  useEffect(() => {
    if (!activeBulkId) return;
    const items = bulkItemsRef.current;
    const activeIdx = items.findIndex((item) => item.id === activeBulkId);
    if (activeIdx < 0) return;
    const candidates = [items[activeIdx], items[activeIdx - 1], items[activeIdx + 1]].filter(
      (item): item is BulkItem => !!item && !!item.postM2Base
    );
    candidates.forEach((item) => {
      if (itemWorkStateCacheRef.current.has(item.id)) return;
      const base = item.postM2Base!;
      const preview =
        item.postM2PreviewBase ??
        downscaleLinearFloatMaxEdge(base, PREVIEW_LIVE_MAX_EDGE);
      itemWorkStateCacheRef.current.set(
        item.id,
        ensureLab2LiveWorkState(null, preview.width, preview.height)
      );
    });
    const keep = new Set(candidates.map((item) => item.id));
    for (const key of itemWorkStateCacheRef.current.keys()) {
      if (!keep.has(key)) {
        itemWorkStateCacheRef.current.delete(key);
      }
    }
  }, [activeBulkId]);

  useEffect(() => {
    const interactive = telemetryRollingRef.current.interactiveMs;
    if (!interactive.length) return;
    const avg = interactive.reduce((sum, v) => sum + v, 0) / interactive.length;
    if (avg > ADAPTIVE_VERY_SLOW_MS) {
      setAdaptiveQualityMode("aggressive");
      return;
    }
    if (avg > ADAPTIVE_SLOW_MS) {
      setAdaptiveQualityMode("degraded");
      return;
    }
    setAdaptiveQualityMode("normal");
  }, [lastRenderTelemetry]);

  useEffect(() => {
    return () => {
      autoMatchRunIdRef.current += 1;
      bulkItemsRef.current.forEach((item) => {
        if (item.thumbUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(item.thumbUrl);
        }
      });
      if (liveRafRef.current != null) cancelAnimationFrame(liveRafRef.current);
      if (liveWorkerRef.current) liveWorkerRef.current.terminate();
    };
  }, []);

  const applyHalationActuance = useCallback(async () => {
    const src = decodedSourceRef.current;
    const base = postM2BaseRef.current;
    if (!src || !base) {
      setStatus("Run match first.");
      return;
    }
    setBusy(true);
    setStatus("Full pipeline (halation + actuance)…");
    try {
      const ref = decodedRefRef.current;
      const engine = buildEngineParamsFromLookParams(lookParams, finalGrading);
      const exposureMap = buildExposureMapFromFloat(src);
      const resultFloat = processFramesFloat(src, ref, {
        strength: model2Strength,
        grading: engine,
        exposureMap,
        matchModel: 2,
        model2Strength,
        model2RobustSampling: model2Robust,
      });
      const rgba = pixelFrameF32ToPixelFrameRGBA(resultFloat);
      bakedRgbaRef.current = rgba;
      setHasBaked(true);
      drawRgbaToCanvasPreview(
        rgba,
        canvasRef.current,
        PREVIEW_MAX_EDGE,
        drawCacheRef.current
      );
      setStatus("Apply complete. Hold eye icon to compare with live edits.");
      if (activeBulkId) {
        patchBulkItem(activeBulkId, {
          hasBaked: true,
          bakedRgba: rgba,
          status: "Apply complete. Hold eye icon to compare with live edits.",
          lookParams: cloneLab2LookParams(lookParams),
          liveLookParams: cloneLab2LookParams(liveLookParams),
          finalGrading,
        });
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [
    activeBulkId,
    lookParams,
    liveLookParams,
    finalGrading,
    model2Strength,
    model2Robust,
    patchBulkItem,
  ]);

  const nextPaint = useCallback(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    []
  );

  const buildExportPngBlobFromItem = useCallback(async (
    item: Pick<BulkItem, "decodedSource" | "decodedRef" | "lookParams" | "finalGrading">
  ): Promise<Blob> => {
    // Canonical export path: full-resolution RAW-decoded linear float only.
    // Preview approximations are never used here.
    const src = item.decodedSource;
    if (!src) {
      throw new Error("Nothing to export.");
    }
    const ref = item.decodedRef;
    const engine = buildEngineParamsFromLookParams(item.lookParams, item.finalGrading);
    const grading =
      exportHalationActuance
        ? engine
        : {
            ...engine,
            actuanceStrength: 0,
            halationExposureTopographyLiftStops: 0,
            highlightFill: engine.highlightFill
              ? { ...engine.highlightFill, strength: 0 }
              : { strength: 0 },
          };
    const exposureMap = buildExposureMapFromFloat(src);
    const resultFloat = processFramesFloat(src, ref, {
      strength: model2Strength,
      grading,
      exposureMap,
      matchModel: 2,
      model2Strength,
      model2RobustSampling: model2Robust,
    });
    const rgba = pixelFrameF32ToPixelFrameRGBA(resultFloat);
    const canvas = document.createElement("canvas");
    canvas.width = rgba.width;
    canvas.height = rgba.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D context");
    ctx.putImageData(frameToImageData(rgba), 0, 0);
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
        "image/png"
      );
    });
  }, [exportHalationActuance, model2Robust, model2Strength]);

  const buildExportPngBlob = useCallback(async (): Promise<Blob> => {
    const active: Pick<BulkItem, "decodedSource" | "decodedRef" | "lookParams" | "finalGrading"> = {
      decodedSource: decodedSourceRef.current,
      decodedRef: decodedRefRef.current,
      lookParams,
      finalGrading,
    };
    setExportProgressPct(15);
    setExportProgressLabel("Preparing");
    await nextPaint();
    setExportProgressPct(45);
    setExportProgressLabel("Processing full resolution");
    await nextPaint();
    const blob = await buildExportPngBlobFromItem(active);
    setExportProgressPct(80);
    setExportProgressLabel("Encoding PNG");
    await nextPaint();
    return blob;
  }, [buildExportPngBlobFromItem, finalGrading, lookParams, nextPaint]);

  const scalePngBlob = useCallback(async (blob: Blob, scale: number): Promise<Blob> => {
    if (scale >= 1) return blob;
    const bitmap = await createImageBitmap(blob);
    const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
    const targetHeight = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      throw new Error("No 2D context");
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
        "image/png"
      );
    });
  }, []);

  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  /** Encodes the current preview canvas only (no full-res pipeline). Long edge ≤ PREVIEW_MAX_EDGE. */
  const exportPreviewPng = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width < 1 || canvas.height < 1) {
      setStatus("Nothing to export — preview is empty.");
      return;
    }
    void new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
        "image/png"
      );
    })
      .then((blob) => {
        downloadBlob(blob, "lab2-grade-preview.png");
        setStatus("Preview PNG downloaded (fast; canvas resolution).");
      })
      .catch((e: unknown) => {
        setStatus(e instanceof Error ? e.message : String(e));
      });
  }, [downloadBlob]);

  const exportPng = useCallback(async () => {
    setBusy(true);
    setIsExporting(true);
    setExportProgressPct(5);
    setExportProgressLabel("Starting export");
    setStatus("Export…");
    try {
      await nextPaint();
      const blob = await buildExportPngBlob();
      setExportProgressPct(95);
      setExportProgressLabel("Downloading");
      await nextPaint();
      downloadBlob(blob, "lab2-grade.png");
      setExportProgressPct(100);
      setExportProgressLabel("Done");
      setStatus("Export downloaded.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      window.setTimeout(() => {
        setExportProgressPct(0);
        setExportProgressLabel("");
        setIsExporting(false);
      }, 300);
      setBusy(false);
    }
  }, [buildExportPngBlob, downloadBlob, nextPaint]);

  const exportPngLow = useCallback(async () => {
    setBusy(true);
    setIsExporting(true);
    setExportProgressPct(5);
    setExportProgressLabel("Starting export");
    setStatus("Export low (70%)…");
    try {
      await nextPaint();
      const blob = await buildExportPngBlob();
      setExportProgressPct(88);
      setExportProgressLabel("Downscaling to 70%");
      await nextPaint();
      const lowBlob = await scalePngBlob(blob, 0.7);
      setExportProgressPct(95);
      setExportProgressLabel("Downloading");
      await nextPaint();
      downloadBlob(lowBlob, "lab2-grade-low.png");
      setExportProgressPct(100);
      setExportProgressLabel("Done");
      setStatus("Low-res export downloaded.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      window.setTimeout(() => {
        setExportProgressPct(0);
        setExportProgressLabel("");
        setIsExporting(false);
      }, 300);
      setBusy(false);
    }
  }, [buildExportPngBlob, downloadBlob, scalePngBlob, nextPaint]);

  const exportPng50 = useCallback(async () => {
    setBusy(true);
    setIsExporting(true);
    setExportProgressPct(5);
    setExportProgressLabel("Starting export");
    setStatus("Export 50%…");
    try {
      await nextPaint();
      const blob = await buildExportPngBlob();
      setExportProgressPct(88);
      setExportProgressLabel("Downscaling to 50%");
      await nextPaint();
      const lowBlob = await scalePngBlob(blob, 0.5);
      setExportProgressPct(95);
      setExportProgressLabel("Downloading");
      await nextPaint();
      downloadBlob(lowBlob, "lab2-grade-50.png");
      setExportProgressPct(100);
      setExportProgressLabel("Done");
      setStatus("50% export downloaded.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      window.setTimeout(() => {
        setExportProgressPct(0);
        setExportProgressLabel("");
        setIsExporting(false);
      }, 300);
      setBusy(false);
    }
  }, [buildExportPngBlob, downloadBlob, scalePngBlob, nextPaint]);

  const exportAllZip = useCallback(async (lowScale: number) => {
    const currentItems = bulkItemsRef.current;
    if (!currentItems.length) {
      setStatus("No bulk items to export.");
      return;
    }
    setBusy(true);
    setIsExporting(true);
    setExportProgressPct(5);
    setExportProgressLabel("Starting ZIP export");
    const lowPct = lowScale < 1 ? Math.round(lowScale * 100) : 100;
    setStatus(lowScale < 1 ? `Export low all (${lowPct}%)…` : "Export all…");
    try {
      const zip = new JSZip();
      const doneProcessed = currentItems.filter((item) => item.processed && item.decodedSource);
      if (!doneProcessed.length) {
        throw new Error("No processed bulk items to export.");
      }
      for (let idx = 0; idx < doneProcessed.length; idx += 1) {
        const item = doneProcessed[idx];
        setExportProgressLabel(`Rendering ${idx + 1}/${doneProcessed.length}`);
        setExportProgressPct(10 + Math.round((idx / doneProcessed.length) * 70));
        await nextPaint();
        const fullBlob = await buildExportPngBlobFromItem(item);
        const blob = lowScale < 1 ? await scalePngBlob(fullBlob, lowScale) : fullBlob;
        const stem = makeSafeFilenamePart(item.originalName.replace(/\.[^.]+$/, ""));
        const suffix =
          lowScale < 1
            ? lowPct === 70
              ? "-lab2-grade-low.png"
              : `-lab2-grade-low-${lowPct}pct.png`
            : "-lab2-grade.png";
        const filename = `${String(idx + 1).padStart(2, "0")}-${stem}${suffix}`;
        zip.file(filename, blob);
      }
      setExportProgressPct(90);
      setExportProgressLabel("Packaging ZIP");
      await nextPaint();
      const zipBlob = await zip.generateAsync({ type: "blob" });
      setExportProgressPct(98);
      setExportProgressLabel("Downloading");
      await nextPaint();
      downloadBlob(
        zipBlob,
        lowScale < 1 ? `lab2-grades-low-${lowPct}.zip` : "lab2-grades.zip"
      );
      setExportProgressPct(100);
      setExportProgressLabel("Done");
      setStatus(lowScale < 1 ? `Low-res (${lowPct}%) ZIP downloaded.` : "ZIP downloaded.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      window.setTimeout(() => {
        setExportProgressPct(0);
        setExportProgressLabel("");
        setIsExporting(false);
      }, 300);
      setBusy(false);
    }
  }, [buildExportPngBlobFromItem, downloadBlob, nextPaint, scalePngBlob]);

  const updateMatch = <K extends keyof LookParamsT["match"]>(
    key: K,
    value: LookParamsT["match"][K],
    cost: "expensive" | "normal" = "normal"
  ) => {
    lastChangedControlRef.current = cost;
    setLookParams((p) => ({ ...p, match: { ...p.match, [key]: value } }));
  };

  const beginSliderDrag = useCallback((cost: "expensive" | "normal") => {
    isDraggingRef.current = true;
    lastChangedControlRef.current = cost;
  }, []);

  const sliderClass =
    "[&_[data-slot=slider-thumb]]:size-6 [&_[data-slot=slider-track]]:h-3 touch-manipulation";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4 md:p-6 pb-24">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Lab 2</h1>
            <p className="text-sm text-zinc-400 mt-1">
              Model 2 match is full-res; live sliders run on preview-resolution linear
              float (~1600px). Halation and actuance apply on &quot;Apply&quot;. Exports
              full decode resolution. Omit halation/actuance on export unless you tick
              &quot;Halation + actuance&quot; below (faster default export).
            </p>
          </div>
          <Link
            href="/lab"
            className="text-sm text-amber-400/90 hover:underline shrink-0"
          >
            Original Lab
          </Link>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-3">
            {!!bulkItems.length && (
              <section className="space-y-2 rounded-xl border border-zinc-800 p-3 bg-zinc-900/30">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-zinc-400">
                    {bulkRunning && bulkTotal > 0
                      ? `processing file ${bulkProcessingIndex} of ${bulkTotal}... (${bulkQueue.length} queued)`
                      : `${bulkItems.length} file(s) in carousel`}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void exportAllZip(1)}
                    >
                      Export all
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void exportAllZip(0.7)}
                    >
                      Export low all (70%)
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void exportAllZip(0.5)}
                    >
                      Export low all (50%)
                    </Button>
                  </div>
                </div>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {bulkItems.map((item, idx) => {
                    const isActive = item.id === activeBulkId;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`shrink-0 w-[180px] rounded border text-left ${
                          isActive
                            ? "border-amber-400 bg-zinc-900"
                            : "border-zinc-700 bg-zinc-900/40"
                        }`}
                        onClick={() => activateBulkItemById(item.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          deleteBulkItem(item.id);
                        }}
                        title="Right-click to delete from carousel"
                      >
                        <div className="h-[110px] w-full bg-zinc-950 overflow-hidden rounded-t">
                          {item.thumbUrl ? (
                            <Image
                              src={item.thumbUrl}
                              alt={item.originalName}
                              width={180}
                              height={110}
                              unoptimized
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="h-full w-full flex items-center justify-center text-[11px] text-zinc-500">
                              {item.processed ? "No thumb" : "Queued"}
                            </div>
                          )}
                        </div>
                        <div className="p-2 space-y-1">
                          <p className="text-[11px] text-zinc-300 truncate">
                            {idx + 1}. {item.originalName}
                          </p>
                          <p className="text-[10px] text-zinc-500 truncate">{item.status}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
            <canvas
              ref={canvasRef}
              className="w-full max-h-[70vh] rounded-lg border border-zinc-800 bg-black object-contain"
            />
            {(liveBusy || (liveRerenderEnabled && liveDirty)) && (
              <div className="w-full h-1.5 rounded bg-zinc-800 overflow-hidden">
                <div className="h-full w-2/5 bg-amber-400 animate-pulse" />
              </div>
            )}
            {!liveRerenderEnabled && liveDirty && !liveBusy && (
              <p className="text-xs text-amber-300">edits not yet applied</p>
            )}
            {liveRerenderEnabled && expensiveDragBlocked && (
              <p className="text-[11px] text-zinc-500">
                Expensive sliders render on pointer-up for responsiveness.
              </p>
            )}
            {isExporting && (
              <div className="w-full space-y-1">
                <div className="h-1.5 rounded bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-emerald-400 transition-all duration-150"
                    style={{ width: `${Math.max(5, exportProgressPct)}%` }}
                  />
                </div>
                <p className="text-[11px] text-zinc-500">
                  Export: {exportProgressLabel || "Working"} ({Math.round(exportProgressPct)}%)
                </p>
              </div>
            )}
            <p className="text-xs text-zinc-500">{status}</p>
            {showPerfDebug && lastRenderTelemetry && (
              <p className="text-[11px] text-zinc-500">
                render {lastRenderTelemetry.mode}: total {lastRenderTelemetry.totalMs.toFixed(0)}ms
                {" | "}compute {lastRenderTelemetry.computeMs.toFixed(0)}ms
                {" | "}pack {lastRenderTelemetry.packMs.toFixed(0)}ms
                {" | "}transfer {lastRenderTelemetry.transferMs.toFixed(0)}ms
                {" | "}draw {lastRenderTelemetry.drawMs.toFixed(0)}ms
              </p>
            )}
            {(adaptiveQualityMode === "degraded" || adaptiveQualityMode === "aggressive") && (
              <p className="text-[11px] text-amber-300">
                interactive quality mode: {adaptiveQualityMode}
              </p>
            )}
            <div className="flex flex-col gap-2 w-full max-w-xl">
              <label className="flex items-center gap-2 text-sm text-zinc-400 touch-manipulation">
                <input
                  type="checkbox"
                  checked={exportHalationActuance}
                  onChange={(e) => setExportHalationActuance(e.target.checked)}
                />
                Halation + actuance
              </label>
              <div className="flex flex-wrap gap-2 items-center">
              <Button
                type="button"
                variant="secondary"
                disabled={busy || !hasBaked}
                onMouseDown={() => {
                  const b = bakedRgbaRef.current;
                  if (b)
                    drawRgbaToCanvasPreview(
                      b,
                      canvasRef.current,
                      PREVIEW_MAX_EDGE,
                      drawCacheRef.current
                    );
                  setShowBakedHold(true);
                }}
                onMouseUp={() => {
                  setShowBakedHold(false);
                  scheduleLiveDraw({ forceImmediate: true });
                }}
                onMouseLeave={() => {
                  setShowBakedHold(false);
                  scheduleLiveDraw({ forceImmediate: true });
                }}
                onTouchStart={() => {
                  const b = bakedRgbaRef.current;
                  if (b)
                    drawRgbaToCanvasPreview(
                      b,
                      canvasRef.current,
                      PREVIEW_MAX_EDGE,
                      drawCacheRef.current
                    );
                  setShowBakedHold(true);
                }}
                onTouchEnd={() => {
                  setShowBakedHold(false);
                  scheduleLiveDraw({ forceImmediate: true });
                }}
                title="Hold to see last Apply result (halation + actuance)"
              >
                Eye
              </Button>
              <Button type="button" onClick={applyHalationActuance} disabled={busy || !hasMatch}>
                Apply halation + actuance
              </Button>
              <Button type="button" variant="outline" onClick={exportPng} disabled={busy || !hasMatch}>
                Export PNG
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={exportPreviewPng}
                disabled={!hasMatch}
                title={`Fast: saves the preview canvas only (long edge up to ${PREVIEW_MAX_EDGE}px). Not a full-resolution pipeline export.`}
              >
                Export preview PNG
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={exportPngLow}
                disabled={busy || !hasMatch}
              >
                Export low (70%)
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={exportPng50}
                disabled={busy || !hasMatch}
              >
                Export 50%
              </Button>
              </div>
            </div>
          </div>

          <div
            className="space-y-6 overflow-y-auto max-h-[85vh] pr-1"
            onPointerDownCapture={() => beginSliderDrag("normal")}
            onTouchStart={() => beginSliderDrag("normal")}
          >
            <section className="space-y-3 rounded-xl border border-zinc-800 p-4 bg-zinc-900/40">
              <label className="flex items-center gap-2 text-sm text-zinc-300 min-h-11 touch-manipulation">
                <input
                  type="checkbox"
                  checked={tileBlend === "tonalHeavy"}
                  onChange={(e) =>
                    setTileBlend(e.target.checked ? "tonalHeavy" : "semantic")
                  }
                />
                10% semantic / 90% tonal (tile match)
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-300 min-h-11 touch-manipulation">
                <input
                  type="checkbox"
                  checked={tileBlend === "halfHalf"}
                  onChange={(e) =>
                    setTileBlend(e.target.checked ? "halfHalf" : "semantic")
                  }
                />
                50/50 semantic / tonal (tile match)
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-300 min-h-11 touch-manipulation">
                <input
                  type="checkbox"
                  checked={sourceDecodeRd1}
                  onChange={(e) => {
                    const v = e.target.checked;
                    setSourceDecodeRd1(v);
                    sourceDecodeRd1Ref.current = v;
                    const f = sourceFileRef.current;
                    const blendSnapshot = tileBlend;
                    setBulkRunning(false);
                    setBulkQueue([]);
                    setBulkProcessingIndex(0);
                    setBulkTotal(0);
                    setActiveBulkId(null);
                    if (f) {
                      void runAutoEmbeddingModel2Match(
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        blendSnapshot
                      );
                    }
                  }}
                />
                Epson R-D1 — server decode (LibRaw)
              </label>
              <p className="text-[11px] text-zinc-500 leading-snug -mt-1">
                Use when an R-D1 DNG preview shows only a corner tile. Decodes full resolution on the
                server; leave off for normal Leica and other DNGs.
              </p>
              <Label className="text-zinc-300">Source (RAW/DNG)</Label>
              <input
                type="file"
                accept="image/*,.dng,.cr2,.nef,.arw,.erf"
                className="block w-full text-sm text-zinc-300 min-h-11"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  const blendSnapshot = tileBlend;
                  setBulkRunning(false);
                  setBulkQueue([]);
                  setBulkProcessingIndex(0);
                  setBulkTotal(0);
                  setActiveBulkId(null);
                  sourceFileRef.current = f;
                  setHasMatch(false);
                  autoMatchedRefFrameRef.current = null;
                  autoMatchedRefLabelRef.current = "";
                  if (f) {
                    void runAutoEmbeddingModel2Match(
                      undefined,
                      undefined,
                      undefined,
                      undefined,
                      blendSnapshot
                    );
                  }
                }}
              />
              <Label className="text-zinc-300">Upload bulk (up to 36)</Label>
              <input
                type="file"
                multiple
                accept="image/*,.dng,.cr2,.nef,.arw,.erf"
                className="block w-full text-sm text-zinc-300 min-h-11"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (!files.length) return;
                  startBulkUpload(files);
                }}
              />
              <Label className="text-zinc-300">Reference (optional)</Label>
              <input
                type="file"
                accept="image/*,.dng,.cr2,.nef,.arw"
                className="block w-full text-sm text-zinc-300 min-h-11"
                onChange={(e) => {
                  refFileRef.current = e.target.files?.[0] ?? null;
                  setHasMatch(false);
                }}
              />
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Model 2 strength</span>
                  <span>{model2Strength.toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0}
                  max={1}
                  step={0.01}
                  value={[model2Strength]}
                  onValueChange={(v) => setModel2Strength(v[0] ?? 1)}
                />
              </div>
              <label className="flex items-center gap-2 text-sm min-h-11 touch-manipulation">
                <input
                  type="checkbox"
                  checked={model2Robust}
                  onChange={(e) => setModel2Robust(e.target.checked)}
                />
                Robust sampling (exclude clipped L)
              </label>
              <Button
                type="button"
                variant={halationPreviewEnabled ? "secondary" : "outline"}
                className="w-full min-h-11"
                disabled={busy || !hasMatch}
                onClick={toggleHalationPreview}
              >
                {halationPreviewEnabled
                  ? "Disable halation preview (approx)"
                  : "Enable halation preview (approx)"}
              </Button>
              <label className="flex items-center gap-2 text-sm min-h-11 touch-manipulation">
                <input
                  type="checkbox"
                  checked={liveRerenderEnabled}
                  onChange={(e) => setLiveRerenderEnabled(e.target.checked)}
                />
                Live re-render
              </label>
              <label className="flex items-center gap-2 text-sm min-h-11 touch-manipulation">
                <input
                  type="checkbox"
                  checked={showPerfDebug}
                  onChange={(e) => setShowPerfDebug(e.target.checked)}
                />
                Perf debug
              </label>
              <Button type="button" className="w-full min-h-11" disabled={busy} onClick={runMatch}>
                Match / refresh base
              </Button>
              {!liveRerenderEnabled && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full min-h-11"
                  disabled={busy || !hasMatch}
                  onClick={renderEditsNow}
                >
                  Render edits
                </Button>
              )}
            </section>

            <section
              className="space-y-3 rounded-xl border border-zinc-800 p-4 bg-zinc-900/40"
              onPointerDownCapture={() => beginSliderDrag("expensive")}
              onTouchStart={() => beginSliderDrag("expensive")}
            >
              <h2 className="font-medium text-zinc-200">Masters</h2>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Overall exposure (× all 7 handles)</span>
                  <span>{(lookParams.match.exposureCurveMasterMul ?? 1).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0.25}
                  max={4}
                  step={0.01}
                  value={[lookParams.match.exposureCurveMasterMul ?? 1]}
                  onValueChange={(v) =>
                    updateMatch("exposureCurveMasterMul", v[0] ?? 1, "expensive")
                  }
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Overall colour density (× all 7)</span>
                  <span>{(lookParams.match.colorDensityCurveMasterMul ?? 1).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0.25}
                  max={4}
                  step={0.01}
                  value={[lookParams.match.colorDensityCurveMasterMul ?? 1]}
                  onValueChange={(v) =>
                    updateMatch("colorDensityCurveMasterMul", v[0] ?? 1, "expensive")
                  }
                />
              </div>
            </section>

            <section
              className="space-y-3 rounded-xl border border-zinc-800 p-4 bg-zinc-900/40"
              onPointerDownCapture={() => beginSliderDrag("expensive")}
              onTouchStart={() => beginSliderDrag("expensive")}
            >
              <h2 className="font-medium text-zinc-200">Exposure handles</h2>
              {(lookParams.match.exposureCurve ?? defaultExposureCurve()).L_out.map(
                (_, idx) => {
                  const curve = lookParams.match.exposureCurve ?? defaultExposureCurve();
                  const L_out = [...curve.L_out];
                  return (
                    <div key={idx} className="space-y-1">
                      <div className="flex justify-between text-xs text-zinc-400">
                        <span>Handle {idx + 1}</span>
                        <span>{L_out[idx]?.toFixed(2) ?? "1"}</span>
                      </div>
                      <Slider
                        className={sliderClass}
                        min={0}
                        max={2}
                        step={0.01}
                        value={[L_out[idx] ?? 1]}
                        onValueChange={(v) => {
                          const next = [...L_out];
                          next[idx] = v[0] ?? 1;
                          updateMatch("exposureCurve", {
                            ...curve,
                            L_out: next,
                          }, "expensive");
                        }}
                      />
                    </div>
                  );
                }
              )}
            </section>

            <section
              className="space-y-3 rounded-xl border border-zinc-800 p-4 bg-zinc-900/40"
              onPointerDownCapture={() => beginSliderDrag("expensive")}
              onTouchStart={() => beginSliderDrag("expensive")}
            >
              <h2 className="font-medium text-zinc-200">Colour density</h2>
              {(lookParams.match.colorDensityCurve ?? defaultColorDensityCurve()).scale.map(
                (_, idx) => {
                  const cur =
                    lookParams.match.colorDensityCurve ?? defaultColorDensityCurve();
                  const scale = [...cur.scale];
                  return (
                    <div key={idx} className="space-y-1">
                      <div className="flex justify-between text-xs text-zinc-400">
                        <span>Handle {idx + 1}</span>
                        <span>{scale[idx]?.toFixed(2) ?? "1"}</span>
                      </div>
                      <Slider
                        className={sliderClass}
                        min={0.2}
                        max={2.5}
                        step={0.01}
                        value={[scale[idx] ?? 1]}
                        onValueChange={(v) => {
                          const next = [...scale];
                          next[idx] = v[0] ?? 1;
                          updateMatch("colorDensityCurve", {
                            ...cur,
                            scale: next,
                          }, "expensive");
                        }}
                      />
                    </div>
                  );
                }
              )}
            </section>

            <section className="space-y-3 rounded-xl border border-zinc-800 p-4 bg-zinc-900/40">
              <h2 className="font-medium text-zinc-200">Refraction post–M2 (12 × sat)</h2>
              <p className="text-xs text-zinc-500">
                Hues fixed every 30°. Only saturation is adjustable.
              </p>
              {(lookParams.match.refractionPostModel2 ?? Array(12).fill(1)).map(
                (sat, idx) => (
                  <div key={idx} className="space-y-1">
                    <div className="flex justify-between text-xs text-zinc-400">
                      <span>
                        {REFRACTION_POST_MODEL2_HUES_DEG[idx]}° ({REFRACTION_HUE_NAMES[idx]})
                      </span>
                      <span>{sat.toFixed(2)}</span>
                    </div>
                    <Slider
                      className={sliderClass}
                      min={0}
                      max={3}
                      step={0.01}
                      value={[sat]}
                      onValueChange={(v) => {
                        const arr = [...(lookParams.match.refractionPostModel2 ?? Array(12).fill(1))];
                        arr[idx] = v[0] ?? 1;
                        updateMatch("refractionPostModel2", arr);
                      }}
                    />
                  </div>
                )
              )}
            </section>

            <section className="space-y-3 rounded-xl border border-zinc-800 p-4 bg-zinc-900/40">
              <h2 className="font-medium text-zinc-200">De-vignette</h2>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Inner diameter / min side</span>
                  <span>
                    {(lookParams.match.devignette?.innerDiameterNorm ?? 0.65).toFixed(2)}
                  </span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0}
                  max={1}
                  step={0.01}
                  value={[lookParams.match.devignette?.innerDiameterNorm ?? 0.65]}
                  onValueChange={(v) =>
                    updateMatch("devignette", {
                      innerDiameterNorm: v[0] ?? 0.65,
                      strengthStops: lookParams.match.devignette?.strengthStops ?? 0,
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Corner lift (stops)</span>
                  <span>{(lookParams.match.devignette?.strengthStops ?? 0).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0}
                  max={3}
                  step={0.02}
                  value={[lookParams.match.devignette?.strengthStops ?? 0]}
                  onValueChange={(v) =>
                    updateMatch("devignette", {
                      innerDiameterNorm:
                        lookParams.match.devignette?.innerDiameterNorm ?? 0.65,
                      strengthStops: v[0] ?? 0,
                    })
                  }
                />
              </div>
            </section>

            <section className="space-y-3 rounded-xl border border-zinc-800 p-4 bg-zinc-900/40">
              <h2 className="font-medium text-zinc-200">Highlights post–M2</h2>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Highlight smoothing</span>
                  <span>{(lookParams.match.highlightSmoothing ?? 0).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0}
                  max={1}
                  step={0.01}
                  value={[lookParams.match.highlightSmoothing ?? 0]}
                  onValueChange={(v) =>
                    updateMatch("highlightSmoothing", v[0] ?? 0)
                  }
                />
              </div>
            </section>

            <section className="space-y-3 rounded-xl border border-zinc-800 p-4 bg-zinc-900/40">
              <h2 className="font-medium text-zinc-200">Actuance (apply only)</h2>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Strength</span>
                  <span>{(lookParams.match.actuanceStrength ?? 0).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0}
                  max={3}
                  step={0.05}
                  value={[lookParams.match.actuanceStrength ?? 0]}
                  onValueChange={(v) => updateMatch("actuanceStrength", v[0] ?? 0)}
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Radius</span>
                  <span>{(lookParams.match.actuanceRadius ?? 0).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0}
                  max={5}
                  step={0.1}
                  value={[lookParams.match.actuanceRadius ?? 0]}
                  onValueChange={(v) => updateMatch("actuanceRadius", v[0] ?? 0)}
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Highlight guard</span>
                  <span>{(lookParams.match.actuanceHighlightGuard ?? 0).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0}
                  max={0.9}
                  step={0.01}
                  value={[lookParams.match.actuanceHighlightGuard ?? 0]}
                  onValueChange={(v) =>
                    updateMatch("actuanceHighlightGuard", v[0] ?? 0)
                  }
                />
              </div>
            </section>

            <section className="space-y-3 rounded-xl border border-zinc-800 p-4 bg-zinc-900/40">
              <h2 className="font-medium text-zinc-200">Halation (apply/export canonical)</h2>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Exposure topography lift (stops)</span>
                  <span>
                    {(lookParams.match.halationExposureTopographyLiftStops ?? 0).toFixed(2)}
                  </span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0}
                  max={3}
                  step={0.05}
                  value={[lookParams.match.halationExposureTopographyLiftStops ?? 0]}
                  onValueChange={(v) =>
                    updateMatch("halationExposureTopographyLiftStops", v[0] ?? 0)
                  }
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Threshold (%)</span>
                  <span>
                    {((lookParams.match.halationThreshold ?? 0.92) * 100).toFixed(1)}%
                  </span>
                </div>
                <Slider
                  className={sliderClass}
                  min={90}
                  max={99.99}
                  step={0.1}
                  value={[(lookParams.match.halationThreshold ?? 0.92) * 100]}
                  onValueChange={(v) =>
                    updateMatch("halationThreshold", (v[0] ?? 92) / 100)
                  }
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Highlight fill strength</span>
                  <span>{(lookParams.match.highlightFillStrength ?? 0).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0}
                  max={2}
                  step={0.05}
                  value={[lookParams.match.highlightFillStrength ?? 0]}
                  onValueChange={(v) =>
                    updateMatch("highlightFillStrength", v[0] ?? 0)
                  }
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Warmth</span>
                  <span>{(lookParams.match.highlightFillWarmth ?? 0).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={-1}
                  max={1}
                  step={0.05}
                  value={[lookParams.match.highlightFillWarmth ?? 0]}
                  onValueChange={(v) =>
                    updateMatch("highlightFillWarmth", v[0] ?? 0)
                  }
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Contrast gate</span>
                  <span>{(lookParams.match.halationContrastGate ?? 1).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0}
                  max={1}
                  step={0.01}
                  value={[lookParams.match.halationContrastGate ?? 1]}
                  onValueChange={(v) =>
                    updateMatch("halationContrastGate", v[0] ?? 1)
                  }
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Rim strength</span>
                  <span>{(lookParams.match.halationRimStrength ?? 0.6).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0}
                  max={1}
                  step={0.01}
                  value={[lookParams.match.halationRimStrength ?? 0.6]}
                  onValueChange={(v) =>
                    updateMatch("halationRimStrength", v[0] ?? 0.6)
                  }
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Bloom strength</span>
                  <span>{(lookParams.match.halationBloomStrength ?? 0.8).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0}
                  max={1}
                  step={0.01}
                  value={[lookParams.match.halationBloomStrength ?? 0.8]}
                  onValueChange={(v) =>
                    updateMatch("halationBloomStrength", v[0] ?? 0.8)
                  }
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Rim radius</span>
                  <span>{(lookParams.match.halationRimRadius ?? 0.1).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0}
                  max={0.75}
                  step={0.05}
                  value={[lookParams.match.halationRimRadius ?? 0.1]}
                  onValueChange={(v) =>
                    updateMatch("halationRimRadius", v[0] ?? 0.1)
                  }
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Bloom radius</span>
                  <span>{(lookParams.match.halationBloomRadius ?? 1).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0}
                  max={2.5}
                  step={0.1}
                  value={[lookParams.match.halationBloomRadius ?? 1]}
                  onValueChange={(v) =>
                    updateMatch("halationBloomRadius", v[0] ?? 1)
                  }
                />
              </div>
            </section>

            <Button type="button" variant="secondary" className="w-full min-h-11" onClick={saveDefaults}>
              Make current parameters default
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full min-h-11"
              onClick={resetToLab2Defaults}
            >
              Reset to Lab2 baseline defaults
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
