"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { ChevronDown, Loader2, MoreHorizontal } from "lucide-react";
import { LoadingButton } from "@/components/app/loading-button";
import { PageHeader } from "@/components/app/page-header";
import { ProgressWithLabel } from "@/components/app/progress-with-label";
import {
  PanelSidebar,
  PanelSidebarContent,
  PanelSidebarInset,
  PanelSidebarProvider,
  PanelSidebarTrigger,
} from "@/components/app/panel-sidebar";
import { Lab2ControlsPanel } from "@/components/lab2/lab2-controls-panel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  DEFAULT_LOOK_PARAMS,
  defaultExposureCurve,
  type LookParams as LookParamsT,
} from "@/lib/look-params";
import { buildEngineParamsFromLookParams } from "@/lib/build-engine-params";
import { applyLab2ResetWithUndo } from "@/lib/lab2/reset-defaults-undo";
import { processSourceFileAuto } from "@/lib/lab2/auto-match";
import { terminateAutoMatchWorker } from "@/lib/lab2/auto-match-worker-client";
import { createThrottledCallback } from "@/lib/throttled-callback";
import {
  buildExportPngBlobFromFrames,
  buildPreviewPngBlobFromCanvas,
  downloadPngBlob,
  scalePngBlob,
} from "@/lib/lab2/build-export-png-blob";
import {
  GrainOptionsDialog,
  type GrainExportRequest,
} from "@/components/grain/grain-options-dialog";
import { applyGrainToPngBlob, applyGrainToPreviewPngBlob } from "@/lib/grain/apply-algo2-grain";
import type { GrainExportParams } from "@/lib/grain/types";
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

const ALL_TILE_BLENDS: Lab2TileBlend[] = ["semantic", "tonalHeavy", "halfHalf"];

const TILE_BLEND_SHORT_LABELS: Record<Lab2TileBlend, string> = {
  semantic: "Standard",
  tonalHeavy: "10/90",
  halfHalf: "50/50",
};

function emptyMatchCandidateSlots(): Record<Lab2TileBlend, (MatchCandidate | null)[]> {
  return {
    semantic: [null, null, null],
    tonalHeavy: [null, null, null],
    halfHalf: [null, null, null],
  };
}

function buildTileSearchBody(
  blend: Lab2TileBlend,
  tileEmbeddings: number[][],
  chromaTiles: number[][]
) {
  const tiles = tileEmbeddings.map((embedding, idx) => ({
    tile_index: idx,
    embedding,
    embedding_tonal_chroma: chromaTiles[idx]!,
  }));
  if (blend === "semantic") {
    return {
      tileEmbeddings: tileEmbeddings.map((embedding, idx) => ({
        tile_index: idx,
        embedding,
      })),
    };
  }
  if (blend === "tonalHeavy") {
    return {
      combineTileTonal: true,
      w_semantic: 0.1,
      w_tonal: 0.9,
      tileEmbeddings: tiles,
    };
  }
  return {
    combineTileTonal: true,
    tileEmbeddings: tiles,
  };
}

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

type MatchRank = 1 | 2 | 3;

type MatchCandidate = {
  label: string;
  thumbUrl: string;
  decodedRef: PixelFrameF32;
  grading: LookParamsT["grading"];
};

type MatchPreview = {
  tileBlend: Lab2TileBlend;
  rank: MatchRank;
  url: string;
  label: string;
};

type ActiveMatchSelection = {
  tileBlend: Lab2TileBlend;
  rank: MatchRank;
};

type ProcessSourceResult = {
  decodedSource: PixelFrameF32;
  decodedRef: PixelFrameF32 | null;
  grading: LookParamsT["grading"];
  lookParamsForRender: LookParamsT;
  completionStatus: string;
  autoMatchedRefLabel: string;
  matchedReferenceThumbUrl: string | null;
  primaryTileBlend: Lab2TileBlend;
  rankedMatchesByBlend: Record<Lab2TileBlend, MatchCandidate[]>;
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
  const autoMatchedRefThumbUrlRef = useRef<string>("");
  const matchCandidatesRef = useRef(emptyMatchCandidateSlots());
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
  const statusRef = useRef("");
  const throttledSetStatus = useMemo(
    () => createThrottledCallback((text: string) => setStatus(text), 250),
    []
  );
  const reportPipelineStatus = useCallback(
    (text: string) => {
      statusRef.current = text;
      throttledSetStatus(text);
    },
    [throttledSetStatus]
  );
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
  const [showUploadDropzones, setShowUploadDropzones] = useState(true);
  const [matchPreviews, setMatchPreviews] = useState<MatchPreview[]>([]);
  const [activeMatch, setActiveMatch] = useState<ActiveMatchSelection>({
    tileBlend: "semantic",
    rank: 1,
  });
  const [switchingMatch, setSwitchingMatch] = useState(false);
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
  const [grainModalOpen, setGrainModalOpen] = useState(false);
  const [grainExportRequest, setGrainExportRequest] =
    useState<GrainExportRequest | null>(null);
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
    applyLab2ResetWithUndo({
      currentLookParams: lookParams,
      applyReset: (reset) => {
        setLookParams(reset);
        setLiveLookParams(reset);
        setFinalGrading(reset.grading);
        setStatus("Reset to Lab2 baseline defaults.");
      },
      applyUndo: (snapshot) => {
        setLookParams(snapshot.lookParams);
        setLiveLookParams(snapshot.lookParams);
        setFinalGrading(snapshot.lookParams.grading);
        setStatus("Restored previous settings.");
      },
    });
  }, [lookParams]);

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
      new URL("../../../src/lib/pipeline/workers/lab2-live-worker.ts", import.meta.url)
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
    reportPipelineStatus("Model 2 match…");
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
  }, [buildPostModel2Artifacts, initLiveWorker, lookParams, reportPipelineStatus, setPostM2Bases]);

  const syncMatchPreviewsFromAllBlends = useCallback(
    async (
      rankedByBlend: Record<Lab2TileBlend, MatchCandidate[]>,
      primaryBlend: Lab2TileBlend
    ) => {
      const slots = emptyMatchCandidateSlots();
      const previews: MatchPreview[] = [];

      for (const blend of ALL_TILE_BLENDS) {
        const candidates = rankedByBlend[blend] ?? [];
        candidates.slice(0, 3).forEach((candidate, idx) => {
          slots[blend][idx] = candidate;
        });
        for (let idx = 0; idx < candidates.length && idx < 3; idx += 1) {
          const candidate = candidates[idx]!;
          previews.push({
            tileBlend: blend,
            rank: (idx + 1) as MatchRank,
            url:
              candidate.thumbUrl ||
              (await buildThumbUrlFromFloatFrame(candidate.decodedRef)),
            label: candidate.label,
          });
        }
      }

      matchCandidatesRef.current = slots;
      setActiveMatch({ tileBlend: primaryBlend, rank: 1 });
      setMatchPreviews(previews);
    },
    []
  );

  const applyMatchCandidate = useCallback(
    async (tileBlend: Lab2TileBlend, rank: MatchRank) => {
      if (
        (activeMatch.tileBlend === tileBlend && activeMatch.rank === rank) ||
        switchingMatch
      ) {
        return;
      }
      const source = decodedSourceRef.current;
      const candidate = matchCandidatesRef.current[tileBlend][rank - 1];
      if (!source || !candidate) return;

      setSwitchingMatch(true);
      reportPipelineStatus(
        `Applying ${TILE_BLEND_SHORT_LABELS[tileBlend]} #${rank} (${candidate.label})…`
      );
      try {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        setActiveMatch({ tileBlend, rank });
        decodedRefRef.current = candidate.decodedRef;
        autoMatchedRefFrameRef.current = candidate.decodedRef;
        autoMatchedRefLabelRef.current = candidate.label;
        autoMatchedRefThumbUrlRef.current = candidate.thumbUrl;
        renderPostModel2Preview(
          source,
          candidate.decodedRef,
          candidate.grading,
          `Applied ${TILE_BLEND_SHORT_LABELS[tileBlend]} #${rank} (${candidate.label}). Post–Model 2 preview is live.`
        );
      } finally {
        setSwitchingMatch(false);
      }
    },
    [activeMatch.rank, activeMatch.tileBlend, renderPostModel2Preview, reportPipelineStatus, switchingMatch]
  );

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
    setShowUploadDropzones(false);
    autoMatchedRefFrameRef.current = null;
    autoMatchedRefLabelRef.current = "";
    autoMatchedRefThumbUrlRef.current = "";
    matchCandidatesRef.current = emptyMatchCandidateSlots();
    setMatchPreviews([]);
    setActiveMatch({ tileBlend: tileBlendSnapshot ?? "semantic", rank: 1 });
    setSwitchingMatch(false);
    try {
      const lookSeed = cloneLab2LookParams(lookParamsOverride ?? lookParams);
      let primaryPreviewShown = false;
      const result = await processSourceFileAuto(
        sourceFile,
        runId,
        () => autoMatchRunIdRef.current,
        (text) => {
          reportPipelineStatus(text);
          if (bulkItemId) patchBulkItem(bulkItemId, { status: text });
        },
        lookSeed,
        sourceDecodeRd1Ref.current,
        {
          tileBlend: tileBlendSnapshot ?? "semantic",
          onPrimaryReady: async (primary) => {
            if (isStale()) return;
            const shouldRenderMainPreview =
              !bulkItemId || !activeBulkId || activeBulkId === bulkItemId;
            if (!shouldRenderMainPreview) return;
            primaryPreviewShown = true;
            decodedSourceRef.current = primary.decodedSource;
            decodedRefRef.current = primary.decodedRef;
            autoMatchedRefFrameRef.current = primary.decodedRef;
            autoMatchedRefLabelRef.current = primary.autoMatchedRefLabel;
            autoMatchedRefThumbUrlRef.current = primary.matchedReferenceThumbUrl;
            setLookParams(primary.lookParamsForRender);
            setLiveLookParams(primary.lookParamsForRender);
            const slots = emptyMatchCandidateSlots();
            slots[primary.primaryTileBlend][0] = {
              label: primary.autoMatchedRefLabel,
              thumbUrl: primary.matchedReferenceThumbUrl,
              decodedRef: primary.decodedRef,
              grading: primary.grading,
            };
            matchCandidatesRef.current = slots;
            setMatchPreviews([
              {
                tileBlend: primary.primaryTileBlend,
                rank: 1,
                url: primary.matchedReferenceThumbUrl,
                label: primary.autoMatchedRefLabel,
              },
            ]);
            setActiveMatch({ tileBlend: primary.primaryTileBlend, rank: 1 });
            renderPostModel2Preview(
              primary.decodedSource,
              primary.decodedRef,
              primary.grading,
              `Matched ${primary.autoMatchedRefLabel}; loading alternates…`,
              primary.lookParamsForRender
            );
          },
        }
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
        autoMatchedRefThumbUrlRef.current = result.matchedReferenceThumbUrl ?? "";
        if (result.decodedRef) {
          const hasAnyMatches = ALL_TILE_BLENDS.some(
            (blend) => result.rankedMatchesByBlend[blend].length > 0
          );
          if (hasAnyMatches) {
            await syncMatchPreviewsFromAllBlends(
              result.rankedMatchesByBlend,
              result.primaryTileBlend
            );
          }
        }
        setLookParams(result.lookParamsForRender);
        setLiveLookParams(result.lookParamsForRender);
        if (primaryPreviewShown) {
          setStatus(result.completionStatus);
          ({ base, preview, live } = buildPostModel2Artifacts(
            result.decodedSource,
            result.decodedRef,
            result.grading,
            result.lookParamsForRender
          ));
        } else {
          ({ base, live } = renderPostModel2Preview(
            result.decodedSource,
            result.decodedRef,
            result.grading,
            result.completionStatus,
            result.lookParamsForRender
          ));
          preview = postM2PreviewBaseRef.current!;
        }
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
      reportPipelineStatus(`Auto embedding match failed: ${message}`);
      if (bulkItemId) {
        patchBulkItem(bulkItemId, {
          status: `Auto embedding match failed: ${message}`,
          error: message,
          processed: true,
        });
      }
    } finally {
      if (!isStale()) {
        throttledSetStatus.flush();
        setBusy(false);
      }
    }
  }, [
    activeBulkId,
    buildPostModel2Artifacts,
    lookParams,
    patchBulkItem,
    renderPostModel2Preview,
    reportPipelineStatus,
    syncMatchPreviewsFromAllBlends,
    throttledSetStatus,
  ]);

  const runMatch = useCallback(async () => {
    const sourceFile = sourceFileRef.current;
    if (!sourceFile) {
      setStatus("Choose a source file first.");
      return;
    }
    setBusy(true);
    reportPipelineStatus("Decoding…");
    try {
      const decodedSource = await decodeSourceToLinearFloat(sourceFile);
      decodedSourceRef.current = decodedSource;
      const refFile = refFileRef.current;
      let decodedRef: PixelFrameF32 | null = null;
      let grading = lookParams.grading;
      let completionStatus = "Source only — no reference. Post–Model 2 still works.";
      if (refFile) {
        reportPipelineStatus("Decoding reference…");
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
      if (decodedRef) {
        const thumbUrl = refFile
          ? await buildThumbUrlFromFloatFrame(decodedRef)
          : autoMatchedRefThumbUrlRef.current ||
            (await buildThumbUrlFromFloatFrame(decodedRef));
        const label = refFile
          ? refFile.name
          : autoMatchedRefLabelRef.current || "dataset match";
        if (refFile) {
          const slots = emptyMatchCandidateSlots();
          slots.semantic[0] = {
            label,
            thumbUrl,
            decodedRef,
            grading,
          };
          matchCandidatesRef.current = slots;
          setMatchPreviews([{ tileBlend: "semantic", rank: 1, url: thumbUrl, label }]);
          setActiveMatch({ tileBlend: "semantic", rank: 1 });
        }
        setShowUploadDropzones(false);
      } else {
        matchCandidatesRef.current = emptyMatchCandidateSlots();
        setMatchPreviews([]);
      }
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
  }, [activeBulkId, decodeSourceToLinearFloat, liveLookParams, lookParams, patchBulkItem, renderPostModel2Preview, reportPipelineStatus]);

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
      if (!base) return;
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
  ]);

  const renderEditsNow = useCallback(() => {
    if (!hasMatch) return;
    setLiveLookParams(lookParams);
    scheduleLiveDraw({ forceImmediate: true, lookParamsOverride: lookParams });
  }, [hasMatch, lookParams, scheduleLiveDraw]);

  const toggleHalationPreview = useCallback(() => {
    if (!hasMatch) return;
    const next = !halationPreviewEnabled;
    setHalationPreviewEnabled(next);
    setLiveLookParams(lookParams);
    scheduleLiveDraw({
      forceImmediate: true,
      halationPreviewEnabled: next,
      lookParamsOverride: lookParams,
    });
    setStatus(next ? "Halation preview mode enabled (approximate)." : "Halation preview mode disabled.");
  }, [halationPreviewEnabled, hasMatch, lookParams, scheduleLiveDraw]);

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
    if (!hasMatch) return;
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
  ]);

  useEffect(() => {
    const onPointerUp = () => {
      const wasDragging = isDraggingRef.current;
      isDraggingRef.current = false;
      if (!liveRerenderEnabled || !wasDragging) return;
      if (!hasMatch) return;
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
  }, [liveRerenderEnabled, hasMatch, lookParams, scheduleLiveDraw]);

  useEffect(() => {
    if (!liveRerenderEnabled || !hasMatch) return;
    setLiveLookParams(lookParams);
    scheduleLiveDraw({ forceImmediate: true });
  }, [liveRerenderEnabled, hasMatch, lookParams, scheduleLiveDraw]);

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
      terminateAutoMatchWorker();
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
    const src = item.decodedSource;
    if (!src) {
      throw new Error("Nothing to export.");
    }
    return buildExportPngBlobFromFrames({
      decodedSource: src,
      decodedRef: item.decodedRef,
      lookParams: item.lookParams,
      finalGrading: item.finalGrading,
      model2Strength,
      model2Robust,
      exportHalationActuance,
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

  const downloadBlob = downloadPngBlob;

  /** Encodes the current preview canvas only (no full-res pipeline). Long edge ≤ PREVIEW_MAX_EDGE. */
  const exportPreviewPng = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      setStatus("Nothing to export — preview is empty.");
      return;
    }
    void buildPreviewPngBlobFromCanvas(canvas)
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

  const openGrainExport = useCallback((request: GrainExportRequest) => {
    setGrainExportRequest(request);
    setGrainModalOpen(true);
  }, []);

  const runGrainExport = useCallback(
    async (params: GrainExportParams, request: GrainExportRequest) => {
      const isPreview = request.source === "preview";
      setBusy(true);
      setIsExporting(true);
      setExportProgressPct(5);
      setExportProgressLabel(isPreview ? "Encoding preview" : "Starting export");
      setStatus(isPreview ? "Export preview with grain…" : "Export with grain…");
      try {
        await nextPaint();
        const canvas = canvasRef.current;
        const blob = isPreview
          ? await buildPreviewPngBlobFromCanvas(canvas!)
          : await buildExportPngBlob();
        setExportProgressPct(isPreview ? 25 : 78);
        setExportProgressLabel("Applying grain");
        await nextPaint();
        let grainBlob = isPreview
          ? await applyGrainToPreviewPngBlob(blob, params, (progress) => {
              setExportProgressLabel(progress.stage);
              const grainStart = 25;
              const grainSpan = 65;
              setExportProgressPct(
                grainStart + Math.round(progress.percentage * (grainSpan / 100))
              );
            })
          : await applyGrainToPngBlob(blob, params, (progress) => {
              setExportProgressLabel(progress.stage);
              setExportProgressPct(78 + Math.round(progress.percentage * 0.17));
            });
        if (!isPreview && request.scale < 1) {
          setExportProgressLabel(`Downscaling to ${Math.round(request.scale * 100)}%`);
          setExportProgressPct(96);
          await nextPaint();
          grainBlob = await scalePngBlob(grainBlob, request.scale);
        }
        setExportProgressPct(98);
        setExportProgressLabel("Downloading");
        await nextPaint();
        downloadBlob(grainBlob, request.filename);
        setExportProgressPct(100);
        setExportProgressLabel("Done");
        setStatus(
          isPreview
            ? "Preview grain export downloaded (canvas resolution)."
            : "Grain export downloaded."
        );
        setGrainModalOpen(false);
        setGrainExportRequest(null);
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
    },
    [buildExportPngBlob, downloadBlob, nextPaint]
  );

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

  return (
    <>
      <PanelSidebarProvider defaultOpen>
        <div className="flex min-h-0 w-full gap-0">
          <PanelSidebarInset>
            <div className="mx-auto max-w-6xl space-y-6 pb-12">
              <PageHeader
                title="Lab 2"
                href="/lab2"
                description='Model 2 match is full-res; live sliders run on preview-resolution linear float (~1600px). Halation and actuance apply on "Apply". Exports full decode resolution. Omit halation/actuance on export unless enabled from the more menu (faster default export).'
              />

              <div className="space-y-3">
            <div className="flex items-center gap-2 md:hidden">
              <PanelSidebarTrigger />
              <span className="text-sm text-muted-foreground">Controls</span>
            </div>
            {!!bulkItems.length && (
              <Card className="space-y-2 border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {bulkRunning && bulkTotal > 0
                      ? `processing file ${bulkProcessingIndex} of ${bulkTotal}... (${bulkQueue.length} queued)`
                      : `${bulkItems.length} file(s) in carousel`}
                  </p>
                  <div className="flex gap-2">
                    <LoadingButton
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void exportAllZip(1)}
                      loading={isExporting}
                      loadingText="Exporting…"
                    >
                      Export all
                    </LoadingButton>
                    <LoadingButton
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void exportAllZip(0.7)}
                      loading={isExporting}
                      loadingText="Exporting…"
                    >
                      Export low all (70%)
                    </LoadingButton>
                    <LoadingButton
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void exportAllZip(0.5)}
                      loading={isExporting}
                      loadingText="Exporting…"
                    >
                      Export low all (50%)
                    </LoadingButton>
                  </div>
                </div>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {bulkItems.map((item, idx) => {
                    const isActive = item.id === activeBulkId;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={cn(
                          "shrink-0 w-[180px] rounded border text-left transition-colors",
                          isActive
                            ? "border-primary bg-accent"
                            : "border bg-muted/40 hover:bg-muted/60"
                        )}
                        onClick={() => activateBulkItemById(item.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          deleteBulkItem(item.id);
                        }}
                        title="Right-click to delete from carousel"
                      >
                        <div className="h-[110px] w-full bg-muted overflow-hidden rounded-t">
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
                            <div className="h-full w-full flex items-center justify-center text-[11px] text-muted-foreground">
                              {item.processed ? "No thumb" : "Queued"}
                            </div>
                          )}
                        </div>
                        <div className="p-2 space-y-1">
                          <p className="text-[11px] text-foreground truncate">
                            {idx + 1}. {item.originalName}
                          </p>
                          <p className="text-[10px] text-muted-foreground truncate">{item.status}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Card>
            )}
            <canvas
              ref={canvasRef}
              className="w-full max-h-[70vh] rounded-lg border bg-black object-contain"
            />
            {(liveBusy || (liveRerenderEnabled && liveDirty)) && (
              <ProgressWithLabel indeterminate label="Updating preview…" />
            )}
            {!liveRerenderEnabled && liveDirty && !liveBusy && (
              <p className="text-xs text-amber-600 dark:text-amber-400">edits not yet applied</p>
            )}
            {liveRerenderEnabled && expensiveDragBlocked && (
              <p className="text-[11px] text-muted-foreground">
                Expensive sliders render on pointer-up for responsiveness.
              </p>
            )}
            {isExporting && (
              <ProgressWithLabel
                value={exportProgressPct}
                label={`Export: ${exportProgressLabel || "Working"} (${Math.round(exportProgressPct)}%)`}
              />
            )}
            <p className="text-xs text-muted-foreground">{status}</p>
            {showPerfDebug && lastRenderTelemetry && (
              <p className="text-[11px] text-muted-foreground">
                render {lastRenderTelemetry.mode}: total {lastRenderTelemetry.totalMs.toFixed(0)}ms
                {" | "}compute {lastRenderTelemetry.computeMs.toFixed(0)}ms
                {" | "}pack {lastRenderTelemetry.packMs.toFixed(0)}ms
                {" | "}transfer {lastRenderTelemetry.transferMs.toFixed(0)}ms
                {" | "}draw {lastRenderTelemetry.drawMs.toFixed(0)}ms
              </p>
            )}
            {(adaptiveQualityMode === "degraded" || adaptiveQualityMode === "aggressive") && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                interactive quality mode: {adaptiveQualityMode}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 w-full max-w-xl">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="More options"
                  >
                    <MoreHorizontal className="size-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuCheckboxItem
                    checked={exportHalationActuance}
                    onCheckedChange={(checked) =>
                      setExportHalationActuance(checked === true)
                    }
                  >
                    Halation + actuance
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!hasMatch || busy}
                    onClick={() => void applyHalationActuance()}
                  >
                    {busy && !isExporting ? "Applying…" : "Apply halation + actuance"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!hasMatch || isExporting}
                  >
                    {isExporting ? (
                      <>
                        <Loader2 className="animate-spin" />
                        Exporting…
                      </>
                    ) : (
                      <>
                        Export
                        <ChevronDown className="size-4" />
                      </>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52">
                  <DropdownMenuItem onClick={() => void exportPng()}>
                    Export PNG
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={exportPreviewPng}>
                    Export preview PNG
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      openGrainExport({
                        source: "preview",
                        scale: 1,
                        filename: "lab2-grade-preview-grain.png",
                      })
                    }
                  >
                    Export preview PNG with grain…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void exportPngLow()}>
                    Export low (70%)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void exportPng50()}>
                    Export 50%
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() =>
                      openGrainExport({
                        scale: 1,
                        filename: "lab2-grade-grain.png",
                      })
                    }
                  >
                    Export with grain…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      openGrainExport({
                        scale: 0.7,
                        filename: "lab2-grade-grain-low.png",
                      })
                    }
                  >
                    Export low with grain (70%)…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      openGrainExport({
                        scale: 0.5,
                        filename: "lab2-grade-grain-50.png",
                      })
                    }
                  >
                    Export with grain (50%)…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              </div>
            </div>
            </div>
          </PanelSidebarInset>

          <PanelSidebar collapsible="icon">
            <PanelSidebarContent>
              <Lab2ControlsPanel
                mode="full"
                lookParams={lookParams}
                tileBlend={tileBlend}
                sourceDecodeRd1={sourceDecodeRd1}
                model2Strength={model2Strength}
                model2Robust={model2Robust}
                halationPreviewEnabled={halationPreviewEnabled}
                liveRerenderEnabled={liveRerenderEnabled}
                showPerfDebug={showPerfDebug}
                busy={busy}
                isExporting={isExporting}
                hasMatch={hasMatch}
                showUploadDropzones={showUploadDropzones}
                status={status}
                statusRef={statusRef}
                matchPreviews={matchPreviews}
                activeMatch={activeMatch}
                switchingMatch={switchingMatch}
                onTileBlendChange={setTileBlend}
                onSourceDecodeRd1Change={(v) => {
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
                onModel2StrengthChange={setModel2Strength}
                onModel2RobustChange={setModel2Robust}
                onHalationPreviewToggle={toggleHalationPreview}
                onLiveRerenderChange={setLiveRerenderEnabled}
                onPerfDebugChange={setShowPerfDebug}
                onSourceFiles={(files) => {
                  const f = files?.[0] ?? null;
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
                  autoMatchedRefThumbUrlRef.current = "";
                  matchCandidatesRef.current = emptyMatchCandidateSlots();
                  setMatchPreviews([]);
                  setActiveMatch({ tileBlend: blendSnapshot, rank: 1 });
                  if (f) {
                    setShowUploadDropzones(false);
                    void runAutoEmbeddingModel2Match(
                      undefined,
                      undefined,
                      undefined,
                      undefined,
                      blendSnapshot
                    );
                  }
                }}
                onBulkFiles={(files) => {
                  const fileList = Array.from(files ?? []);
                  if (!fileList.length) return;
                  startBulkUpload(fileList);
                }}
                onReferenceFiles={(files) => {
                  refFileRef.current = files?.[0] ?? null;
                  setHasMatch(false);
                }}
                onUploadNewSource={() => setShowUploadDropzones(true)}
                onMatchSelect={(blend, rank) => void applyMatchCandidate(blend, rank)}
                onRunMatch={() => void runMatch()}
                onRenderEdits={renderEditsNow}
                onSaveDefaults={saveDefaults}
                onResetDefaults={resetToLab2Defaults}
                onMatchPointerDown={beginSliderDrag}
                updateMatch={updateMatch}
              />
            </PanelSidebarContent>
          </PanelSidebar>
        </div>
      </PanelSidebarProvider>
      <GrainOptionsDialog
        open={grainModalOpen}
        request={grainExportRequest}
        isExporting={isExporting}
        exportProgressLabel={exportProgressLabel}
        exportProgressPct={exportProgressPct}
        onOpenChange={(open) => {
          if (isExporting) return;
          setGrainModalOpen(open);
          if (!open) setGrainExportRequest(null);
        }}
        onConfirm={(params, request) => void runGrainExport(params, request)}
      />
    </>
  );
}
