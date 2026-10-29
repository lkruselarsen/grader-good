"use client";

import { useEffect, useRef, useState } from "react";
import {
  fetchCloudEditSession,
  fetchFloatPreview,
  startCloudEdit,
  type CloudEditSessionView,
} from "@/lib/cloud/client";
import type { PixelFrameF32 } from "@/src/lib/pipeline/types";

const POLL_MS = 2000;

/** One session per output per page load (effects can run twice in development). */
const sessionStarts = new Map<string, Promise<{ sessionId: string }>>();

export type CloudEditPhase = "idle" | "preparing" | "loading" | "ready" | "failed";

/**
 * Opens a cloud edit session for an export: the cloud rebuilds the Model 2
 * base from the full DNG, then this hook downloads the preview-size float
 * frame and hands it to the editor.
 */
export function useCloudEditSession(
  outputId: string | null,
  onReady: (preview: PixelFrameF32, session: CloudEditSessionView) => void
): { phase: CloudEditPhase; message: string; session: CloudEditSessionView | null } {
  const [phase, setPhase] = useState<CloudEditPhase>(outputId ? "preparing" : "idle");
  const [message, setMessage] = useState("");
  const [session, setSession] = useState<CloudEditSessionView | null>(null);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    if (!outputId) return;
    let cancelled = false;
    const run = async () => {
      try {
        let start = sessionStarts.get(outputId);
        if (!start) {
          start = startCloudEdit(outputId);
          sessionStarts.set(outputId, start);
          start.catch(() => sessionStarts.delete(outputId));
        }
        const { sessionId } = await start;
        if (cancelled) return;
        setPhase("preparing");
        setMessage("Preparing your photo in the cloud (10–30 s)…");
        let view: CloudEditSessionView;
        for (;;) {
          view = await fetchCloudEditSession(sessionId);
          if (cancelled) return;
          if (view.status === "ready" || view.status === "failed") break;
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        if (view.status === "failed" || !view.previewUrl || !view.width || !view.height) {
          throw new Error(view.error ?? "The cloud could not prepare this photo.");
        }
        setSession(view);
        setPhase("loading");
        setMessage("Downloading preview…");
        const preview = await fetchFloatPreview(view.previewUrl, view.width, view.height);
        if (cancelled) return;
        onReadyRef.current(preview, view);
        setPhase("ready");
        setMessage("");
      } catch (e) {
        if (cancelled) return;
        setPhase("failed");
        setMessage(e instanceof Error ? e.message : String(e));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [outputId]);

  return { phase, message, session };
}
