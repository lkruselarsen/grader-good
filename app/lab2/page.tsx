"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
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
  ensureLab2LiveWorkState,
  type Lab2LivePreviewOptions,
  type Lab2LiveWorkState,
} from "@/lib/lab2-live-preview";
import { decodeToLinearFloat } from "@/src/lib/pipeline/decode";
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
import { imageToColClipTileEmbeddings } from "@/src/lib/colclipEmbeddings";

const LAB2_DEFAULTS_STORAGE_KEY = "grader-good:lab2-defaults";
const PREVIEW_MAX_EDGE = 1600;
const LAB2_DEFAULT_EXPOSURE_CURVE = defaultExposureCurve();
const LAB2_DEFAULT_LOOK_PARAMS: LookParamsT = {
  ...DEFAULT_LOOK_PARAMS,
  match: {
    ...DEFAULT_LOOK_PARAMS.match,
    colorDensityCurveMasterMul: 1.5,
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

export default function Lab2Page() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceFileRef = useRef<File | null>(null);
  const refFileRef = useRef<File | null>(null);
  const decodedSourceRef = useRef<PixelFrameF32 | null>(null);
  const decodedRefRef = useRef<PixelFrameF32 | null>(null);
  const postM2BaseRef = useRef<PixelFrameF32 | null>(null);
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
  const lastRenderKeyRef = useRef<string>("");

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
  const [halationPreviewEnabled, setHalationPreviewEnabled] = useState(false);

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
      lastRenderKeyRef.current = "";

    worker.onmessage = (e: MessageEvent<unknown>) => {
      const msg = e.data as
        | { type: "inited"; width: number; height: number }
        | { type: "result"; requestId: number; width: number; height: number; data: ArrayBuffer }
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
      drawFloatToCanvasPreview(
        { width: msg.width, height: msg.height, data: new Float32Array(msg.data) },
        canvasRef.current,
        PREVIEW_MAX_EDGE,
        drawCacheRef.current
      );
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
      const options: Lab2LivePreviewOptions = {
        halationPreview: halationPreviewEnabled,
      };
      worker.postMessage({ type: "render", requestId, grading: queuedEngine, options });
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
  }, [halationPreviewEnabled]);

  const renderPostModel2Preview = useCallback((
    decodedSource: PixelFrameF32,
    decodedRef: PixelFrameF32 | null,
    grading: LookParamsT["grading"],
    completionStatus: string
  ) => {
    setFinalGrading(grading);
    decodedRefRef.current = decodedRef;
    const engine = buildEngineParamsFromLookParams(lookParams, grading);
    const pipelineParams = {
      strength: model2Strength,
      grading: engine,
      exposureMap: buildExposureMapFromFloat(decodedSource),
      matchModel: 2 as const,
      model2Strength,
      model2RobustSampling: model2Robust,
    };

    setStatus("Model 2 match…");
    const base = buildPostModel2BaseFrame(
      decodedSource,
      decodedRef,
      pipelineParams
    );
    postM2BaseRef.current = base;
    liveLocalStateRef.current = ensureLab2LiveWorkState(
      liveLocalStateRef.current,
      base.width,
      base.height
    );
    initLiveWorker(base);
    setHasMatch(true);
    bakedRgbaRef.current = null;

    const live = applyLivePostModel2OnlyWithState(
      base,
      engine,
      liveLocalStateRef.current,
      { halationPreview: halationPreviewEnabled }
    );
    drawFloatToCanvasPreview(
      live,
      canvasRef.current,
      PREVIEW_MAX_EDGE,
      drawCacheRef.current
    );
    setStatus(completionStatus);
  }, [
    halationPreviewEnabled,
    initLiveWorker,
    lookParams,
    model2Robust,
    model2Strength,
  ]);

  const runAutoEmbeddingModel2Match = useCallback(async () => {
    const sourceFile = sourceFileRef.current;
    if (!sourceFile) {
      setStatus("Choose a source file first.");
      return;
    }
    const runId = ++autoMatchRunIdRef.current;
    const isStale = () => runId !== autoMatchRunIdRef.current;
    setBusy(true);
    try {
      setStatus("Decoding source RAW…");
      const decodedSource = await decodeToLinearFloat(sourceFile);
      if (isStale()) return;
      decodedSourceRef.current = decodedSource;
      decodedRefRef.current = null;
      autoMatchedRefFrameRef.current = null;
      autoMatchedRefLabelRef.current = "";
      setHasMatch(false);

      // Retrieval-only interpretation path (embeddings); grading/export remain linear-float.
      const sourcePreviewRgba = pixelFrameF32ToPixelFrameRGBA(decodedSource);
      const sourceImageData = frameToImageData(sourcePreviewRgba);
      setStatus("Computing 10x10 tile embeddings…");
      const tileEmbeddings = await imageToColClipTileEmbeddings(
        sourceImageData,
        10,
        10,
        (current, total) => {
          if (isStale()) return;
          setStatus(`Computing 10x10 tile embeddings… ${current}/${total}`);
        }
      );
      if (isStale()) return;

      setStatus("Searching dataset matches…");
      const searchRes = await fetch("/api/dataset/search?limit=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tileEmbeddings: tileEmbeddings.map((embedding, idx) => ({
            tile_index: idx,
            embedding,
          })),
        }),
      });
      const searchData = (await searchRes.json()) as {
        error?: string;
        matches?: Array<{ image_url?: unknown; name?: unknown }>;
      };
      if (!searchRes.ok) {
        throw new Error(searchData.error ?? "Dataset search failed.");
      }
      const top = searchData.matches?.[0];
      if (!top) {
        throw new Error("No dataset matches found.");
      }
      const imageUrl = typeof top.image_url === "string" ? top.image_url : "";
      if (!imageUrl) {
        throw new Error("Top dataset match is missing image_url.");
      }

      setStatus("Fetching matched reference…");
      const refRes = await fetch(imageUrl);
      if (!refRes.ok) {
        throw new Error(`Failed to fetch matched reference (${refRes.status}).`);
      }
      const refBlob = await refRes.blob();
      if (isStale()) return;

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

      setStatus("Decoding matched reference…");
      const decodedRef = await decodeToLinearFloat(matchedRefFile);
      if (isStale()) return;
      autoMatchedRefFrameRef.current = decodedRef;
      autoMatchedRefLabelRef.current = refLabel;
      setStatus("Fitting grading from matched reference…");
      const fitted = engineToGrading(fitLookParamsFromReference(decodedRef));
      if (isStale()) return;
      renderPostModel2Preview(
        decodedSource,
        decodedRef,
        fitted,
        `Auto match complete (${refLabel}). Post–Model 2 preview is live.`
      );
    } catch (e) {
      if (isStale()) return;
      const message = e instanceof Error ? e.message : String(e);
      const decodedSource = decodedSourceRef.current;
      if (decodedSource) {
        renderPostModel2Preview(
          decodedSource,
          null,
          lookParams.grading,
          `Auto embedding match failed: ${message}. Showing source-only preview; use Match / refresh base to retry.`
        );
      } else {
        setStatus(`Auto embedding match failed: ${message}`);
      }
    } finally {
      if (!isStale()) {
        setBusy(false);
      }
    }
  }, [lookParams.grading, renderPostModel2Preview]);

  const runMatch = useCallback(async () => {
    const sourceFile = sourceFileRef.current;
    if (!sourceFile) {
      setStatus("Choose a source file first.");
      return;
    }
    setBusy(true);
    setStatus("Decoding…");
    try {
      const decodedSource = await decodeToLinearFloat(sourceFile);
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
      } else {
        grading = lookParams.grading;
      }
      renderPostModel2Preview(
        decodedSource,
        decodedRef,
        grading,
        completionStatus
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [lookParams.grading, renderPostModel2Preview]);

  const scheduleLiveDraw = useCallback((forceImmediate?: boolean) => {
    if (liveRafRef.current != null) cancelAnimationFrame(liveRafRef.current);
    liveRafRef.current = requestAnimationFrame(() => {
      liveRafRef.current = null;
      const base = postM2BaseRef.current;
      if (!base || showBakedHold) return;
      const engine = buildEngineParamsFromLookParams(liveLookParams, finalGrading);
      const renderKey = JSON.stringify({
        match: liveLookParams.match,
        grading: finalGrading,
        halationPreviewEnabled,
      });
      if (!forceImmediate && renderKey === lastRenderKeyRef.current) {
        setLiveBusy(false);
        setLiveDirty(false);
        return;
      }
      lastRenderKeyRef.current = renderKey;
      queuedEngineRef.current = engine;
      setLiveDirty(true);
      const now = Date.now();
      const throttleMs = 90;
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
        const options: Lab2LivePreviewOptions = {
          halationPreview: halationPreviewEnabled,
        };
        worker.postMessage({ type: "render", requestId, grading: engine, options });
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
        { halationPreview: halationPreviewEnabled }
      );
      drawFloatToCanvasPreview(
        live,
        canvasRef.current,
        PREVIEW_MAX_EDGE,
        drawCacheRef.current
      );
      setLiveBusy(false);
      setLiveDirty(false);
    });
  }, [liveLookParams, finalGrading, showBakedHold, halationPreviewEnabled]);

  useEffect(() => {
    setLiveDirty(true);
    const t = window.setTimeout(() => {
      setLiveLookParams(lookParams);
    }, 220);
    return () => window.clearTimeout(t);
  }, [lookParams]);

  useEffect(() => {
    if (!hasMatch || showBakedHold) return;
    scheduleLiveDraw();
  }, [liveLookParams, finalGrading, hasMatch, showBakedHold, scheduleLiveDraw]);

  useEffect(() => {
    const onPointerUp = () => {
      if (!hasMatch || showBakedHold) return;
      setLiveLookParams(lookParams);
      scheduleLiveDraw(true);
    };
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("touchend", onPointerUp);
    return () => {
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("touchend", onPointerUp);
    };
  }, [hasMatch, showBakedHold, lookParams, scheduleLiveDraw]);

  useEffect(() => {
    return () => {
      autoMatchRunIdRef.current += 1;
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
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [
    lookParams,
    finalGrading,
    model2Strength,
    model2Robust,
  ]);

  const nextPaint = useCallback(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    []
  );

  const buildExportPngBlob = useCallback(async (): Promise<Blob> => {
    // Canonical export path: full-resolution RAW-decoded linear float only.
    // Preview approximations are never used here.
    const src = decodedSourceRef.current;
    if (!src) {
      throw new Error("Nothing to export.");
    }
    setExportProgressPct(15);
    setExportProgressLabel("Preparing");
    await nextPaint();
    const ref = decodedRefRef.current;
    const engine = buildEngineParamsFromLookParams(lookParams, finalGrading);
    const exposureMap = buildExposureMapFromFloat(src);
    setExportProgressPct(45);
    setExportProgressLabel("Processing full resolution");
    await nextPaint();
    const resultFloat = processFramesFloat(src, ref, {
      strength: model2Strength,
      grading: engine,
      exposureMap,
      matchModel: 2,
      model2Strength,
      model2RobustSampling: model2Robust,
    });
    setExportProgressPct(80);
    setExportProgressLabel("Encoding PNG");
    await nextPaint();
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
  }, [lookParams, finalGrading, model2Strength, model2Robust, nextPaint]);

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

  const updateMatch = <K extends keyof LookParamsT["match"]>(
    key: K,
    value: LookParamsT["match"][K]
  ) => {
    setLookParams((p) => ({ ...p, match: { ...p.match, [key]: value } }));
  };

  const sliderClass =
    "[&_[data-slot=slider-thumb]]:size-6 [&_[data-slot=slider-track]]:h-3 touch-manipulation";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4 md:p-6 pb-24">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Lab 2</h1>
            <p className="text-sm text-zinc-400 mt-1">
              Model 2 only. Live preview runs on full-resolution linear float (no PNG
              edits). Halation and actuance apply on &quot;Apply&quot; or export.
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
            <canvas
              ref={canvasRef}
              className="w-full max-h-[70vh] rounded-lg border border-zinc-800 bg-black object-contain"
            />
            {(liveBusy || liveDirty) && (
              <div className="w-full h-1.5 rounded bg-zinc-800 overflow-hidden">
                <div className="h-full w-2/5 bg-amber-400 animate-pulse" />
              </div>
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
                  scheduleLiveDraw();
                }}
                onMouseLeave={() => {
                  setShowBakedHold(false);
                  scheduleLiveDraw();
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
                  scheduleLiveDraw();
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
                onClick={exportPngLow}
                disabled={busy || !hasMatch}
              >
                Export low (70%)
              </Button>
            </div>
          </div>

          <div className="space-y-6 overflow-y-auto max-h-[85vh] pr-1">
            <section className="space-y-3 rounded-xl border border-zinc-800 p-4 bg-zinc-900/40">
              <Label className="text-zinc-300">Source (RAW/DNG)</Label>
              <input
                type="file"
                accept="image/*,.dng,.cr2,.nef,.arw"
                className="block w-full text-sm text-zinc-300 min-h-11"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  sourceFileRef.current = f;
                  setHasMatch(false);
                  autoMatchedRefFrameRef.current = null;
                  autoMatchedRefLabelRef.current = "";
                  autoMatchRunIdRef.current += 1;
                  if (f) {
                    void runAutoEmbeddingModel2Match();
                  }
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
              <label className="flex items-center gap-2 text-sm min-h-11 touch-manipulation">
                <input
                  type="checkbox"
                  checked={halationPreviewEnabled}
                  onChange={(e) => setHalationPreviewEnabled(e.target.checked)}
                />
                Preview halation (fast approximation)
              </label>
              <Button type="button" className="w-full min-h-11" disabled={busy} onClick={runMatch}>
                Match / refresh base
              </Button>
            </section>

            <section className="space-y-3 rounded-xl border border-zinc-800 p-4 bg-zinc-900/40">
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
                    updateMatch("exposureCurveMasterMul", v[0] ?? 1)
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
                    updateMatch("colorDensityCurveMasterMul", v[0] ?? 1)
                  }
                />
              </div>
            </section>

            <section className="space-y-3 rounded-xl border border-zinc-800 p-4 bg-zinc-900/40">
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
                          });
                        }}
                      />
                    </div>
                  );
                }
              )}
            </section>

            <section className="space-y-3 rounded-xl border border-zinc-800 p-4 bg-zinc-900/40">
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
                          });
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
                      <span>{REFRACTION_POST_MODEL2_HUES_DEG[idx]}°</span>
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
                  <span>{(lookParams.match.actuanceRadius ?? 2).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0.5}
                  max={5}
                  step={0.1}
                  value={[lookParams.match.actuanceRadius ?? 2]}
                  onValueChange={(v) => updateMatch("actuanceRadius", v[0] ?? 2)}
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Highlight guard</span>
                  <span>{(lookParams.match.actuanceHighlightGuard ?? 0.65).toFixed(2)}</span>
                </div>
                <Slider
                  className={sliderClass}
                  min={0.5}
                  max={0.9}
                  step={0.01}
                  value={[lookParams.match.actuanceHighlightGuard ?? 0.65]}
                  onValueChange={(v) =>
                    updateMatch("actuanceHighlightGuard", v[0] ?? 0.65)
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
