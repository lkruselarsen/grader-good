"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchCloudEditSession,
  fetchFloatPreview,
  startCloudEdit,
  type CloudEditSessionView,
} from "@/lib/cloud/client";
import type { CloudEditCandidateView } from "@/lib/cloud/types";
import type { PixelFrameF32 } from "@/src/lib/pipeline/types";

const POLL_MS = 2000;
const WARM_POLL_MS = 3000;
const CANDIDATE_WAIT_MS = 5 * 60 * 1000;

/** One session per output per page load (effects can run twice in development). */
const sessionStarts = new Map<string, Promise<{ sessionId: string }>>();

export type CloudEditPhase = "idle" | "preparing" | "loading" | "ready" | "failed";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function warmDone(view: CloudEditSessionView): boolean {
  if (view.warmStatus === "done" || view.warmStatus === "failed") return true;
  return view.candidates.every((c) => c.status === "ready" || c.status === "failed");
}

/**
 * Opens a cloud edit session for an export. The base for the export's own
 * reference is usually cached by the batch, so only the download is waited
 * on; otherwise the cloud rebuilds it from the full DNG first. The other
 * reference choices are prepared in the cloud in the background and become
 * selectable as they finish. Downloaded bases stay in memory for this page.
 */
export function useCloudEditSession(
  outputId: string | null,
  onReady: (preview: PixelFrameF32, session: CloudEditSessionView) => void
): {
  phase: CloudEditPhase;
  message: string;
  session: CloudEditSessionView | null;
  candidates: CloudEditCandidateView[];
  loadCandidate: (sampleId: string) => Promise<{ preview: PixelFrameF32; candidate: CloudEditCandidateView }>;
} {
  const [phase, setPhase] = useState<CloudEditPhase>(outputId ? "preparing" : "idle");
  const [message, setMessage] = useState("");
  const [session, setSession] = useState<CloudEditSessionView | null>(null);
  const [candidates, setCandidates] = useState<CloudEditCandidateView[]>([]);
  const candidatesRef = useRef<CloudEditCandidateView[]>([]);
  const previews = useRef(new Map<string, Promise<PixelFrameF32>>());
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  const applyView = useCallback((view: CloudEditSessionView) => {
    candidatesRef.current = view.candidates;
    setCandidates(view.candidates);
  }, []);

  useEffect(() => {
    if (!outputId) return;
    let cancelled = false;
    previews.current.clear();
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
          applyView(view);
          if (view.status === "ready" || view.status === "failed") break;
          await sleep(POLL_MS);
        }
        if (view.status === "failed" || !view.previewUrl || !view.width || !view.height) {
          throw new Error(view.error ?? "The cloud could not prepare this photo.");
        }
        setSession(view);
        setPhase("loading");
        setMessage("Downloading preview…");
        const primary = fetchFloatPreview(view.previewUrl, view.width, view.height, view.channels);
        if (view.output.sampleId) previews.current.set(view.output.sampleId, primary);
        const preview = await primary;
        if (cancelled) return;
        onReadyRef.current(preview, view);
        setPhase("ready");
        setMessage("");
        while (!cancelled && !warmDone(view)) {
          await sleep(WARM_POLL_MS);
          if (cancelled) return;
          view = await fetchCloudEditSession(sessionId).catch(() => view);
          if (!cancelled) applyView(view);
        }
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
  }, [applyView, outputId]);

  /** Resolves once the candidate's base is prepared in the cloud and downloaded. */
  const loadCandidate = useCallback(async (sampleId: string) => {
    const deadline = Date.now() + CANDIDATE_WAIT_MS;
    let candidate = candidatesRef.current.find((c) => c.sampleId === sampleId);
    while (!candidate || candidate.status !== "ready" || !candidate.previewUrl) {
      if (candidate?.status === "failed") throw new Error("The cloud could not prepare this reference.");
      if (Date.now() > deadline) throw new Error("Timed out waiting for this reference.");
      await sleep(1000);
      candidate = candidatesRef.current.find((c) => c.sampleId === sampleId);
    }
    let pending = previews.current.get(sampleId);
    if (!pending) {
      pending = fetchFloatPreview(candidate.previewUrl, candidate.width!, candidate.height!, candidate.channels);
      previews.current.set(sampleId, pending);
      pending.catch(() => previews.current.delete(sampleId));
    }
    return { preview: await pending, candidate };
  }, []);

  return { phase, message, session, candidates, loadCandidate };
}
