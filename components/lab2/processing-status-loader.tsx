"use client";

import {
  memo,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { RotatingSavedLoaders } from "@/components/loaders/rotating-saved-loaders";
import { mapStatusToPhase } from "@/lib/lab2/types";

const STATUS_POLL_MS = 200;

type ProcessingStatusLoaderProps = {
  statusRef: RefObject<string>;
  defaultLabel?: string;
  switchingMatch?: boolean;
  className?: string;
};

/**
 * Loader that polls a status ref instead of receiving status as a prop, so
 * parent re-renders from pipeline progress do not reset the animation.
 * Rotates through saved loader presets whenever the coarse pipeline phase changes.
 */
export const ProcessingStatusLoader = memo(function ProcessingStatusLoader({
  statusRef,
  defaultLabel = "Processing source…",
  switchingMatch = false,
  className,
}: ProcessingStatusLoaderProps) {
  const fallback = switchingMatch ? "Applying match…" : defaultLabel;
  const [label, setLabel] = useState(
    () => statusRef.current?.trim() || fallback
  );
  const [presetIndex, setPresetIndex] = useState(0);
  const phaseRef = useRef<string | null>(null);

  useEffect(() => {
    const raw = statusRef.current?.trim() || fallback;
    phaseRef.current = mapStatusToPhase(raw);
  }, [statusRef, fallback]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const raw = statusRef.current?.trim() || fallback;
      const phase = mapStatusToPhase(raw);

      setLabel((prev) => (prev === raw ? prev : raw));

      if (phaseRef.current !== null && phaseRef.current !== phase) {
        setPresetIndex((index) => index + 1);
      }
      phaseRef.current = phase;
    }, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [statusRef, fallback]);

  return (
    <RotatingSavedLoaders
      loopId="processing"
      label={label}
      className={className}
      presetIndex={presetIndex}
    />
  );
});
