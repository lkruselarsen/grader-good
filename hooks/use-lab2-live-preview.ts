"use client";

import { useCallback, useEffect, useRef } from "react";
import { PREVIEW_MAX_EDGE } from "@/lib/lab2/constants";
import {
  cloneRgbaFrame,
  defaultDrawCache,
} from "@/lib/lab2/canvas-utils";
import {
  createLab2LivePreviewScheduler,
  type Lab2LivePreviewScheduler,
  type Lab2LivePreviewSchedulerConfig,
  type ScheduleLiveDrawOpts,
} from "@/lib/lab2/live-preview-scheduler";
import type { RgbaFrame } from "@/lib/lab2/types";
import type { LookParams as LookParamsT } from "@/lib/look-params";
import type { PixelFrameF32 } from "@/src/lib/pipeline";

export type UseLab2LivePreviewOptions = {
  onSettled?: (rgba: RgbaFrame, lookParams: LookParamsT) => void;
  onError?: (message: string) => void;
  getRenderer?: Lab2LivePreviewSchedulerConfig["getRenderer"];
  onLinearFrame?: Lab2LivePreviewSchedulerConfig["onLinearFrame"];
  onFinishOnly?: Lab2LivePreviewSchedulerConfig["onFinishOnly"];
  hasLinearFrame?: Lab2LivePreviewSchedulerConfig["hasLinearFrame"];
};

export function useLab2LivePreview(options: UseLab2LivePreviewOptions = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maxEdgeRef = useRef(PREVIEW_MAX_EDGE);
  const schedulerRef = useRef<Lab2LivePreviewScheduler | null>(null);
  const onSettledRef = useRef(options.onSettled);
  const onErrorRef = useRef(options.onError);
  const surfaceRef = useRef({
    getRenderer: options.getRenderer,
    onLinearFrame: options.onLinearFrame,
    onFinishOnly: options.onFinishOnly,
    hasLinearFrame: options.hasLinearFrame,
  });

  useEffect(() => {
    onSettledRef.current = options.onSettled;
    onErrorRef.current = options.onError;
    surfaceRef.current = {
      getRenderer: options.getRenderer,
      onLinearFrame: options.onLinearFrame,
      onFinishOnly: options.onFinishOnly,
      hasLinearFrame: options.hasLinearFrame,
    };
  }, [
    options.onSettled,
    options.onError,
    options.getRenderer,
    options.onLinearFrame,
    options.onFinishOnly,
    options.hasLinearFrame,
  ]);

  useEffect(() => {
    schedulerRef.current = createLab2LivePreviewScheduler({
      getCanvas: () => canvasRef.current,
      getMaxEdge: () => maxEdgeRef.current,
      drawCache: defaultDrawCache(),
      onSettled: (rgba, lookParams) => {
        onSettledRef.current?.(cloneRgbaFrame(rgba), lookParams);
      },
      onError: (message) => {
        onErrorRef.current?.(message);
      },
      getRenderer: () => surfaceRef.current.getRenderer?.() ?? "2d",
      onLinearFrame: (frame, renderMode, lookParams) =>
        surfaceRef.current.onLinearFrame?.(frame, renderMode, lookParams),
      onFinishOnly: (lookParams) => surfaceRef.current.onFinishOnly?.(lookParams),
      hasLinearFrame: () => surfaceRef.current.hasLinearFrame?.() ?? false,
    });
    return () => {
      schedulerRef.current?.terminate();
      schedulerRef.current = null;
    };
  }, []);

  const setMaxEdge = useCallback((edge: number) => {
    maxEdgeRef.current = edge;
  }, []);

  const initPreviewBase = useCallback((base: PixelFrameF32) => {
    schedulerRef.current?.initPreviewBase(base);
  }, []);

  const terminate = useCallback(() => {
    schedulerRef.current?.terminate();
  }, []);

  const drawRgba = useCallback((rgba: RgbaFrame) => {
    schedulerRef.current?.drawRgba(rgba);
  }, []);

  const scheduleDraw = useCallback(
    (
      lookParams: LookParamsT,
      finalGrading: LookParamsT["grading"],
      opts?: ScheduleLiveDrawOpts
    ) => {
      schedulerRef.current?.scheduleDraw(lookParams, finalGrading, opts);
    },
    []
  );

  return {
    canvasRef,
    setMaxEdge,
    initPreviewBase,
    terminate,
    drawRgba,
    scheduleDraw,
  };
}
