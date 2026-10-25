"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { PreviewPresenter } from "@/lib/lab2/preview-presenter";
import {
  DEFAULT_PREVIEW_MODE,
  previewModeReducer,
  type PreviewModeState,
  type PreviewRenderer,
} from "@/lib/lab2/preview-mode";
import type { RgbaFrame } from "@/lib/lab2/types";
import type { FinishParams } from "@/src/lib/pipeline/finishing/model";
import type { PixelFrameF32 } from "@/src/lib/pipeline/types";

const SETTLED_READBACK_DELAY_MS = 250;

export type UseFinishingPreviewOptions = {
  getMaxEdge: () => number;
  initialMode?: PreviewModeState;
  /** Called once the WebGL-mode canvas is ready and needs a frame. */
  onPresenterReady?: () => void;
};

export function useFinishingPreview(options: UseFinishingPreviewOptions) {
  const [mode, dispatch] = useReducer(
    previewModeReducer,
    options.initialMode ?? DEFAULT_PREVIEW_MODE
  );
  const modeRef = useRef(mode);
  const presenterRef = useRef<PreviewPresenter | null>(null);
  const getMaxEdgeRef = useRef(options.getMaxEdge);
  const onReadyRef = useRef(options.onPresenterReady);
  const readbackTimerRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    modeRef.current = mode;
    getMaxEdgeRef.current = options.getMaxEdge;
    onReadyRef.current = options.onPresenterReady;
  });

  const pendingDisposeRef = useRef<number | null>(null);

  const webglCanvasRef = useCallback((el: HTMLCanvasElement | null) => {
    if (el) {
      if (pendingDisposeRef.current != null) {
        window.clearTimeout(pendingDisposeRef.current);
        pendingDisposeRef.current = null;
      }
      if (presenterRef.current?.canvas === el) return;
      presenterRef.current?.dispose();
      presenterRef.current = new PreviewPresenter(el, () => getMaxEdgeRef.current());
      onReadyRef.current?.();
      return;
    }
    // Deferred: a dev StrictMode detach/re-attach of the same canvas must keep its context.
    const detached = presenterRef.current;
    pendingDisposeRef.current = window.setTimeout(() => {
      pendingDisposeRef.current = null;
      if (presenterRef.current === detached) {
        detached?.dispose();
        presenterRef.current = null;
      }
    }, 0);
  }, []);

  // The presenter is disposed by the canvas ref detaching (deferred above).
  useEffect(
    () => () => {
      if (readbackTimerRef.current != null) window.clearTimeout(readbackTimerRef.current);
    },
    []
  );

  const setEffectsEnabled = useCallback((value: boolean) => {
    dispatch({ type: "setEffectsEnabled", value });
  }, []);

  const setPreviewRenderer = useCallback((value: PreviewRenderer) => {
    dispatch({ type: "setRenderer", value });
  }, []);

  const replaceMode = useCallback((next: PreviewModeState) => {
    dispatch({ type: "replace", value: next });
  }, []);

  /** True while the WebGL-mode canvas (with presenter) is the active surface. */
  const isWebglActive = useCallback(
    () => modeRef.current.previewRenderer === "webgl" && !!presenterRef.current,
    []
  );

  const presentLinear = useCallback((frame: PixelFrameF32, finish: FinishParams | null) => {
    presenterRef.current?.presentLinear(frame, finish);
  }, []);

  const presentRgba = useCallback((rgba: RgbaFrame) => {
    presenterRef.current?.presentRgba(rgba);
  }, []);

  const updateFinish = useCallback((finish: FinishParams | null) => {
    presenterRef.current?.updateFinish(finish);
  }, []);

  const readbackRgba = useCallback((): RgbaFrame | null => {
    return presenterRef.current?.readbackRgba() ?? null;
  }, []);

  /** Debounced readback of the finished preview (for thumbnails / saved previews). */
  const scheduleSettledReadback = useCallback((onRgba: (rgba: RgbaFrame) => void) => {
    if (readbackTimerRef.current != null) window.clearTimeout(readbackTimerRef.current);
    readbackTimerRef.current = window.setTimeout(() => {
      readbackTimerRef.current = null;
      const rgba = presenterRef.current?.readbackRgba();
      if (rgba) onRgba(rgba);
    }, SETTLED_READBACK_DELAY_MS);
  }, []);

  const api = useMemo(
    () => ({
      modeRef,
      presenterRef,
      webglCanvasRef,
      setEffectsEnabled,
      setPreviewRenderer,
      replaceMode,
      isWebglActive,
      presentLinear,
      presentRgba,
      updateFinish,
      readbackRgba,
      scheduleSettledReadback,
    }),
    [
      webglCanvasRef,
      setEffectsEnabled,
      setPreviewRenderer,
      replaceMode,
      isWebglActive,
      presentLinear,
      presentRgba,
      updateFinish,
      readbackRgba,
      scheduleSettledReadback,
    ]
  );

  return {
    previewRenderer: mode.previewRenderer,
    effectsEnabled: mode.effectsEnabled,
    /** Stable identity: safe to use in hook dependency lists. */
    api,
  };
}
