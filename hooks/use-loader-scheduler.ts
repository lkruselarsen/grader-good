"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LoaderDefinition } from "@/lib/loaders/types";
import { buildLoaderSequence } from "@/lib/loaders/sequence-cache";
import "@/lib/loaders/algorithms";

export type LoaderSchedulerState = {
  frameIndex: number;
  frameCount: number;
  tickIntervalMs: number;
  unitStates: Uint8Array;
};

export type LoaderSchedulerOptions = {
  paused?: boolean;
  manualFrame?: number;
  onLoopComplete?: () => void;
};

export function useLoaderScheduler(
  definition: LoaderDefinition,
  options?: LoaderSchedulerOptions
): LoaderSchedulerState {
  const sequence = useMemo(
    () => buildLoaderSequence(definition),
    [definition]
  );

  const [frameIndex, setFrameIndex] = useState(0);
  const prevFrameRef = useRef<number | null>(null);
  const onLoopCompleteRef = useRef(options?.onLoopComplete);
  onLoopCompleteRef.current = options?.onLoopComplete;

  useEffect(() => {
    if (options?.paused) return;
    if (options?.manualFrame !== undefined) return;

    const id = window.setInterval(() => {
      setFrameIndex((n) => (n + 1) % sequence.frameCount);
    }, sequence.tickIntervalMs);

    return () => window.clearInterval(id);
  }, [
    sequence.frameCount,
    sequence.tickIntervalMs,
    options?.paused,
    options?.manualFrame,
  ]);

  useEffect(() => {
    if (options?.paused) return;
    if (options?.manualFrame !== undefined) return;

    const prev = prevFrameRef.current;
    if (prev !== null && prev > frameIndex) {
      onLoopCompleteRef.current?.();
    }
    prevFrameRef.current = frameIndex;
  }, [frameIndex, options?.paused, options?.manualFrame]);

  const effectiveFrame =
    options?.manualFrame !== undefined
      ? options.manualFrame % sequence.frameCount
      : frameIndex;

  const unitStates =
    sequence.frames[effectiveFrame] ??
    sequence.frames[0] ??
    new Uint8Array(sequence.unitCount);

  return {
    frameIndex: effectiveFrame,
    frameCount: sequence.frameCount,
    tickIntervalMs: sequence.tickIntervalMs,
    unitStates,
  };
}
