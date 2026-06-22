"use client";

import { useCallback, useRef, useState } from "react";
import { PageHeader } from "@/components/app/page-header";
import { LoadingButton } from "@/components/app/loading-button";
import { ProgressWithLabel } from "@/components/app/progress-with-label";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  decode,
  decodeDngLinear,
} from "@/src/lib/pipeline/decode";
import {
  frameToImageData,
  buildExposureMapFromSrgb,
  buildExposureMapFromLinearRgb,
  computeImageStats,
  computeBandAnchorsFromFrame,
} from "@/src/lib/pipeline";
import { runProcessOneInWorker } from "@/src/lib/pipeline/runProcessOneInWorker";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";
import {
  engineToGrading,
  DEFAULT_LOOK_PARAMS,
} from "@/lib/look-params";
import { buildEngineParamsFromLookParams } from "@/lib/build-engine-params";
import {
  applyGradingDeltas,
  filterNonHalationDeltas,
  filterHalationDeltas,
  ensureFullMatch,
} from "@/lib/apply-grading-deltas";
import type { LookParams, LookParamsGrading } from "@/lib/look-params";
import type { PixelFrameRGBA } from "@/src/lib/pipeline/types";
import type { ExposureMap } from "@/src/lib/pipeline/exposureMap";

const MAX_PAIRS = 6;
const IMAGE_MAX_EDGE = 2048; // For OpenAI evaluation

type PairFiles = {
  source: File | null;
  reference: File | null;
  refSourceSameScene?: boolean;
};

const CAMERA_OPTIONS = ["Leica M10", "Epson R-D1", "Sony A7", "Generic", "Other"];

function initPairs(): PairFiles[] {
  return Array.from({ length: MAX_PAIRS }, () => ({
    source: null,
    reference: null,
    refSourceSameScene: true,
  }));
}

function isDng(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "image/x-adobe-dng" || type === "image/dng") return true;
  const name = (file.name || "").toLowerCase();
  return name.endsWith(".dng");
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 =
        typeof dataUrl === "string" && dataUrl.includes(",")
          ? dataUrl.split(",")[1] ?? ""
          : "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Convert a PixelFrameRGBA to base64 PNG, optionally scaled to maxEdge. */
async function frameToPngBase64(
  frame: PixelFrameRGBA,
  maxEdge?: number
): Promise<string> {
  const { width, height } = frame;
  const scale =
    maxEdge && Math.max(width, height) > maxEdge
      ? maxEdge / Math.max(width, height)
      : 1;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = width;
  srcCanvas.height = height;
  const srcCtx = srcCanvas.getContext("2d");
  if (!srcCtx) throw new Error("Could not get 2D context");
  srcCtx.putImageData(frameToImageData(frame), 0, 0);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) throw new Error("Could not get 2D context");
  outCtx.drawImage(srcCanvas, 0, 0, width, height, 0, 0, w, h);

  const dataUrl = outCanvas.toDataURL("image/png");
  const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  return base64 ?? "";
}

export default function TrainPage() {
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const pendingSourceRowRef = useRef<number>(0);
  const pendingRefRowRef = useRef<number>(0);
  const [pairs, setPairs] = useState<PairFiles[]>(initPairs);
  const [cameraType, setCameraType] = useState("Generic");
  const [cameraTypeOther, setCameraTypeOther] = useState("");
  const [iterations, setIterations] = useState(20);
  const [status, setStatus] = useState<"idle" | "training" | "done" | "error">(
    "idle"
  );
  const [message, setMessage] = useState<string>("");
  const [finalImageUrl, setFinalImageUrl] = useState<string | null>(null);
  const [finalBlobRef, setFinalBlobRef] = useState<Blob | null>(null);
  const [currentIteration, setCurrentIteration] = useState<number>(0);
  const [maxIterations, setMaxIterations] = useState<number>(0);
  const [currentPair, setCurrentPair] = useState<number>(0);
  const [totalPairs, setTotalPairs] = useState<number>(0);
  const [useServerFlow, setUseServerFlow] = useState<boolean>(false);
  const [usePhasedApproach, setUsePhasedApproach] = useState<boolean>(false);
  const [matchModel2, setMatchModel2] = useState<boolean>(false);

  const completePairs = pairs.filter(
    (p) => p.source != null && p.reference != null
  );
  const cameraTypeValue = cameraType === "Other" ? cameraTypeOther : cameraType;
  const canStart =
    completePairs.length > 0 &&
    status !== "training" &&
    (cameraType !== "Other" || cameraTypeOther.trim().length > 0);

  const triggerSourcePick = useCallback(
    (row: number) => {
      if (status === "training") return;
      pendingSourceRowRef.current = row;
      sourceInputRef.current?.click();
    },
    [status]
  );
  const triggerReferencePick = useCallback(
    (row: number) => {
      if (status === "training") return;
      pendingRefRowRef.current = row;
      referenceInputRef.current?.click();
    },
    [status]
  );
  const onSourceChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    const row = pendingSourceRowRef.current;
    setPairs((prev) =>
      prev.map((p, i) => (i === row ? { ...p, source: file } : p))
    );
    e.target.value = "";
  }, []);
  const onReferenceChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null;
      const row = pendingRefRowRef.current;
      setPairs((prev) =>
        prev.map((p, i) => (i === row ? { ...p, reference: file } : p))
      );
      e.target.value = "";
    },
    []
  );

  const handleStart = useCallback(async () => {
    if (completePairs.length === 0) return;
    setStatus("training");
    setMessage("");
    setFinalImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setFinalBlobRef(null);
    setCurrentIteration(0);
    setMaxIterations(0);
    setCurrentPair(0);
    setTotalPairs(completePairs.length);

    const maxIter = usePhasedApproach
      ? iterations < 10
        ? Math.max(5, Math.min(9, iterations))
        : iterations <= 15
          ? 10
          : iterations <= 30
            ? 20
            : 40
      : Math.max(5, Math.min(100, iterations));
    const getPhasedScheduleForTotal = (n: number) =>
      n < 10
        ? { itersPerPhase: n, numRuns: 1 }
        : n <= 15
          ? { itersPerPhase: 5, numRuns: 2 }
          : n <= 30
            ? { itersPerPhase: 10, numRuns: 2 }
            : { itersPerPhase: 10, numRuns: 4 };
    const phasedTotalSteps = usePhasedApproach
      ? (() => {
          const { itersPerPhase, numRuns } = getPhasedScheduleForTotal(maxIter);
          const numPhases = matchModel2 ? 3 : 8;
          return numRuns * numPhases * itersPerPhase;
        })()
      : maxIter;
    setMaxIterations(phasedTotalSteps);
    const camType = cameraTypeValue.trim() || null;

    try {
      if (useServerFlow) {
        setMessage("Uploading pairs…");
        const pairsPayload = await Promise.all(
          completePairs.map(async (p) => {
            if (!p.source || !p.reference) throw new Error("Missing pair");
            return {
              source_base64: await fileToBase64(p.source),
              reference_base64: await fileToBase64(p.reference),
              ref_source_same_scene: p.refSourceSameScene ?? true,
            };
          })
        );
        const res = await fetch("/api/train/openai-loop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pairs: pairsPayload,
            max_iterations: maxIter,
            camera_type: camType,
            use_libraw: true,
            phased: usePhasedApproach,
            model2: matchModel2,
          }),
        });
        if (!res.ok) {
          const err = (await res.json()) as { error?: string };
          throw new Error(err.error ?? "Failed to start server run");
        }
        const { run_id } = (await res.json()) as { run_id?: string };
        if (!run_id) throw new Error("No run_id returned");

        setMessage("Server run started. Polling status…");
        const pollInterval = 2500;
        let done = false;

        async function fetchStatusWithRetries(): Promise<Response> {
          let lastErr: Error | null = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            const res = await fetch(`/api/train/status?run_id=${run_id}`);
            if (res.ok) return res;
            const errBody = await res.json().catch(() => ({}));
            lastErr = new Error(
              (errBody as { error?: string }).error ?? "Status poll failed"
            );
            if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
          }
          throw lastErr!;
        }

        while (!done) {
          await new Promise((r) => setTimeout(r, pollInterval));
          const statusRes = await fetchStatusWithRetries();
          const data = (await statusRes.json()) as {
            status: string;
            current_iteration?: number;
            max_iterations?: number;
            current_pair?: number;
            total_pairs?: number;
            error?: string;
            final_image_urls?: string[];
          };
          setCurrentIteration(data.current_iteration ?? 0);
          setCurrentPair(data.current_pair ?? 0);
          if (data.status === "error") {
            throw new Error(data.error ?? "Server run failed");
          }
          if (data.status === "done") {
            done = true;
            const imgUrl = data.final_image_urls?.[0];
            if (imgUrl) {
              const imgRes = await fetch(imgUrl);
              const blob = await imgRes.blob();
              const url = URL.createObjectURL(blob);
              setFinalImageUrl((prev) => {
                if (prev) URL.revokeObjectURL(prev);
                return url;
              });
              setFinalBlobRef(blob);
              setMessage(
                completePairs.length > 1
                  ? `Done. ${completePairs.length} pairs processed.`
                  : "Done."
              );
            } else {
              setMessage(
                "Done, but final image not available (upload may have failed)."
              );
            }
            setStatus("done");
          }
        }
        return;
      }

      for (let pairIndex = 0; pairIndex < completePairs.length; pairIndex++) {
        const pair = completePairs[pairIndex];
        if (!pair.source || !pair.reference) continue;

        setCurrentPair(pairIndex);
        setMessage(`Pair ${pairIndex + 1}: Decoding…`);

        const decodedSource = await decode(pair.source);
        const decodedRef = await decode(pair.reference);

        const linearSource = await decodeDngLinear(pair.source);
        const exposureMap: ExposureMap =
          linearSource != null
            ? buildExposureMapFromLinearRgb(
                linearSource.width,
                linearSource.height,
                new Uint8Array(linearSource.data),
                4
              )
            : buildExposureMapFromSrgb(decodedSource);

        const refImageData = new ImageData(
          new Uint8ClampedArray(decodedRef.data),
          decodedRef.width,
          decodedRef.height
        );
        const engineParams = fitLookParamsFromReference(refImageData);
        const fittedGrading: LookParamsGrading = engineToGrading(engineParams);
        const refBlackL = fittedGrading.refBlackL ?? 0.2;
        const initialMatch = {
          ...DEFAULT_LOOK_PARAMS.match,
          blackPoint: refBlackL,
        };
        let currentParams: LookParams = {
          match: initialMatch,
          grading: fittedGrading,
        };

        const referenceBase64 = await frameToPngBase64(
          decodedRef,
          IMAGE_MAX_EDGE
        );
        const sourceBase64 = await frameToPngBase64(
          decodedSource,
          IMAGE_MAX_EDGE
        );

        let lastDeltas: Record<string, number> = { one: 1 };
        let iterCount = 0;

        const getPhasedSchedule = (n: number) =>
          n < 10
            ? { itersPerPhase: n, numRuns: 1 }
            : n <= 15
              ? { itersPerPhase: 5, numRuns: 2 }
              : n <= 30
                ? { itersPerPhase: 10, numRuns: 2 }
                : { itersPerPhase: 10, numRuns: 4 };

        if (usePhasedApproach) {
          const { itersPerPhase, numRuns } = getPhasedSchedule(maxIter);
          const phasesTotal = matchModel2 ? 3 : 8;
          const phaseNames: Record<number, string> = matchModel2
            ? {
                1: "Exposure+Density+Acutance",
                2: "Per-band",
                3: "Halation",
              }
            : {
                1: "Exposure",
                2: "Contrast",
                3: "Color density",
                4: "Overall grading",
                5: "Per-band",
                6: "Refraction",
                7: "Actuance",
                8: "Halation",
              };
          let globalIterCount = 0;
          let bandAnchors: number[] | null = null;
          let secondLastResultBase64: string | null = null;
          let secondLastParams: Record<string, unknown> | null = null;
          for (let runIdx = 0; runIdx < numRuns; runIdx++) {
            for (let phase = 1; phase <= phasesTotal; phase++) {
              for (let phaseIter = 0; phaseIter < itersPerPhase; phaseIter++) {
                globalIterCount++;
                iterCount = globalIterCount;
                setCurrentIteration(globalIterCount);
                setMessage(
                  `Run ${runIdx + 1}/${numRuns}, Phase ${phase} (${phaseNames[phase] ?? phase}), iter ${phaseIter + 1}/${itersPerPhase}…`
                );
                const useHalation = phase === (matchModel2 ? 3 : 8);
                const paramsForPhase: LookParams = useHalation
                  ? currentParams
                  : {
                      match: {
                        ...currentParams.match,
                        highlightFillStrength: 0,
                      },
                      grading: currentParams.grading,
                    };
                const enginePhase = buildEngineParamsFromLookParams(
                  paramsForPhase,
                  fittedGrading
                );
                const sourceCopy: PixelFrameRGBA = {
                  ...decodedSource,
                  data: new Uint8ClampedArray(decodedSource.data),
                };
                const refCopy: PixelFrameRGBA | null = decodedRef
                  ? {
                      ...decodedRef,
                      data: new Uint8ClampedArray(decodedRef.data),
                    }
                  : null;
                const resultPhase = await runProcessOneInWorker(
                  sourceCopy,
                  refCopy,
                  {
                    strength: 1,
                    grading: enginePhase,
                    exposureMap: useHalation ? exposureMap : undefined,
                    colorBandAnchors: bandAnchors ?? undefined,
                    ...(matchModel2
                      ? {
                          matchModel: 2 as const,
                          model2Strength: 1,
                          model2RobustSampling: true,
                        }
                      : {}),
                  }
                );
                if (phase === 1 && phaseIter === itersPerPhase - 1) {
                  bandAnchors = computeBandAnchorsFromFrame(resultPhase);
                }
                const resultBase64Phase = await frameToPngBase64(
                  resultPhase,
                  IMAGE_MAX_EDGE
                );
                const hasSecondLast = secondLastResultBase64 != null;
                const resPhase = await fetch("/api/train/openai-deltas", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    result_base64: resultBase64Phase,
                    reference_base64: referenceBase64,
                    ref_black_l: refBlackL,
                    ...(phase === 1 && !hasSecondLast
                      ? { source_base64: sourceBase64 }
                      : {}),
                    ...(hasSecondLast
                      ? {
                          second_last_base64: secondLastResultBase64,
                          second_last_params: secondLastParams ?? {},
                        }
                      : {}),
                    phase,
                    run: runIdx + 1,
                    num_runs: numRuns,
                    phase_iteration: phaseIter + 1,
                    iters_per_phase: itersPerPhase,
                    last_deltas: lastDeltas,
                    current_match: currentParams.match,
                    initial_match: initialMatch,
                    model2: matchModel2,
                  }),
                });
                if (!resPhase.ok) {
                  const err = (await resPhase.json()) as { error?: string };
                  throw new Error(err.error ?? "OpenAI phase request failed");
                }
                const dataPhase = (await resPhase.json()) as {
                  deltas?: Record<string, number>;
                };
                const deltasPhase = dataPhase.deltas ?? {};
                secondLastResultBase64 = resultBase64Phase;
                secondLastParams = { ...currentParams.match };
                if (Object.keys(deltasPhase).length > 0) {
                  currentParams = applyGradingDeltas(
                    currentParams,
                    deltasPhase,
                    matchModel2
                      ? { model2: true, model2Phase: phase as 1 | 2 | 3 }
                      : undefined
                  );
                }
                lastDeltas = deltasPhase;
              }
            }
          }
        } else {
        while (
          Object.keys(lastDeltas).length > 0 &&
          iterCount < maxIter
        ) {
          iterCount++;
          setCurrentIteration(iterCount);
          setMessage(
            `Pair ${pairIndex + 1}: Iteration ${iterCount} of ${maxIter}…`
          );

          // Substep 1: non-halation
          // Pass copies of the buffers — transfer neuters the originals, so we
          // keep decodedSource / decodedRef intact for subsequent iterations.
          const paramsSubstep1: LookParams = {
            match: { ...currentParams.match, highlightFillStrength: 0 },
            grading: currentParams.grading,
          };
          const engine1 = buildEngineParamsFromLookParams(
            paramsSubstep1,
            fittedGrading
          );
          const sourceCopy1: PixelFrameRGBA = {
            ...decodedSource,
            data: new Uint8ClampedArray(decodedSource.data),
          };
          const refCopy1: PixelFrameRGBA | null = decodedRef
            ? { ...decodedRef, data: new Uint8ClampedArray(decodedRef.data) }
            : null;
          const result1 = await runProcessOneInWorker(sourceCopy1, refCopy1, {
            strength: 1,
            grading: engine1,
            exposureMap: undefined,
            ...(matchModel2
              ? {
                  matchModel: 2 as const,
                  model2Strength: 1,
                  model2RobustSampling: true,
                }
              : {}),
          });
          const resultBase641 = await frameToPngBase64(result1, IMAGE_MAX_EDGE);

          const res1 = await fetch("/api/train/openai-deltas", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              result_base64: resultBase641,
              reference_base64: referenceBase64,
              ref_black_l: refBlackL,
              substep: 1,
              iteration: iterCount,
              max_iterations: maxIter,
              last_deltas: lastDeltas,
              current_match: currentParams.match,
              initial_match: initialMatch,
            }),
          });
          if (!res1.ok) {
            const err = (await res1.json()) as { error?: string };
            throw new Error(err.error ?? "OpenAI substep 1 failed");
          }
          const data1 = (await res1.json()) as { deltas?: Record<string, number> };
          const deltas1 = data1.deltas ?? {};
          const nonHalationDeltas = filterNonHalationDeltas(deltas1);
          if (Object.keys(nonHalationDeltas).length > 0) {
            currentParams = applyGradingDeltas(
              currentParams,
              nonHalationDeltas,
              matchModel2 ? { model2: true } : undefined
            );
          }

          // Substep 2: halation
          const engine2 = buildEngineParamsFromLookParams(
            currentParams,
            fittedGrading
          );
          const sourceCopy2: PixelFrameRGBA = {
            ...decodedSource,
            data: new Uint8ClampedArray(decodedSource.data),
          };
          const refCopy2: PixelFrameRGBA | null = decodedRef
            ? { ...decodedRef, data: new Uint8ClampedArray(decodedRef.data) }
            : null;
          const result2 = await runProcessOneInWorker(sourceCopy2, refCopy2, {
            strength: 1,
            grading: engine2,
            exposureMap,
            ...(matchModel2
              ? {
                  matchModel: 2 as const,
                  model2Strength: 1,
                  model2RobustSampling: true,
                }
              : {}),
          });
          const resultBase642 = await frameToPngBase64(result2, IMAGE_MAX_EDGE);

          const res2 = await fetch("/api/train/openai-deltas", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              result_base64: resultBase642,
              reference_base64: referenceBase64,
              substep: 2,
              iteration: iterCount,
              max_iterations: maxIter,
              last_deltas: lastDeltas,
              current_match: currentParams.match,
              model2: matchModel2,
            }),
          });
          if (!res2.ok) {
            const err = (await res2.json()) as { error?: string };
            throw new Error(err.error ?? "OpenAI substep 2 failed");
          }
          const data2 = (await res2.json()) as { deltas?: Record<string, number> };
          const deltas2 = data2.deltas ?? {};
          const halationDeltas = filterHalationDeltas(deltas2);
          if (Object.keys(halationDeltas).length > 0) {
            currentParams = applyGradingDeltas(currentParams, halationDeltas);
          }

          lastDeltas = { ...nonHalationDeltas, ...halationDeltas };
          if (Object.keys(lastDeltas).length === 0) break;
        }
        }

        const sourceStats = computeImageStats(frameToImageData(decodedSource));
        const refStats = computeImageStats(frameToImageData(decodedRef));

        const engineFinal = buildEngineParamsFromLookParams(
          currentParams,
          fittedGrading
        );
        const sourceCopyFinal: PixelFrameRGBA = {
          ...decodedSource,
          data: new Uint8ClampedArray(decodedSource.data),
        };
        const refCopyFinal: PixelFrameRGBA | null = decodedRef
          ? { ...decodedRef, data: new Uint8ClampedArray(decodedRef.data) }
          : null;
        const finalFrame = await runProcessOneInWorker(
          sourceCopyFinal,
          refCopyFinal,
          {
            strength: 1,
            grading: engineFinal,
            exposureMap,
            ...(matchModel2
              ? {
                  matchModel: 2 as const,
                  model2Strength: 1,
                  model2RobustSampling: true,
                }
              : {}),
          }
        );

        const canvas = document.createElement("canvas");
        canvas.width = finalFrame.width;
        canvas.height = finalFrame.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not get 2D context");
        ctx.putImageData(frameToImageData(finalFrame), 0, 0);

        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
            "image/png"
          );
        });
        const url = URL.createObjectURL(blob);
        setFinalImageUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        setFinalBlobRef(blob);

        const sourceId = `${pair.source.name}:${pair.source.size}:${pair.source.lastModified}`;
        const referenceId = `${pair.reference.name}:${pair.reference.size}:${pair.reference.lastModified}`;

        const correctionPayload = {
          sourceId,
          referenceId,
          sourceFilename: pair.source.name,
          referenceFilename: pair.reference.name,
          autoParams: {
            match: ensureFullMatch(initialMatch),
            grading: fittedGrading,
          },
          correctedParams: {
            match: ensureFullMatch(currentParams.match),
            grading: currentParams.grading,
          },
          source_exposure: sourceStats.exposureLevel,
          source_chroma_distribution: sourceStats.chromaDistribution,
          reference_exposure: refStats.exposureLevel,
          reference_chroma_distribution: refStats.chromaDistribution,
          source_type: isDng(pair.source) ? "dng" : "png",
          camera_type: camType,
          completed_iterations: iterCount,
        };

        const corrRes = await fetch("/api/corrections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(correctionPayload),
        });
        if (!corrRes.ok) {
          const errData = (await corrRes.json()) as { error?: string };
          console.error("[train] POST corrections failed:", errData.error);
        }
      }

      setStatus("done");
      setMessage(
        completePairs.length > 1
          ? `Done. ${completePairs.length} corrections saved.`
          : "Done. Correction posted."
      );
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, [completePairs, iterations, cameraTypeValue, useServerFlow, usePhasedApproach, matchModel2]);

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Train"
        href="/train"
        description="Run the OpenAI Vision training loop in your browser, using the same full-resolution RAW pipeline as the Lab. The AI compares each result to its reference and suggests parameter adjustments; corrections are saved."
      />

      <Card className="p-6 space-y-4">
        <input
          ref={sourceInputRef}
          type="file"
          accept=".dng,.raw,.cr2,.nef,.arw,image/png,image/jpeg,image/jpg"
          onChange={onSourceChange}
          className="hidden"
          aria-hidden
        />
        <input
          ref={referenceInputRef}
          type="file"
          accept="image/jpeg,image/png,image/tiff,.jpg,.jpeg,.png,.tiff,.tif"
          onChange={onReferenceChange}
          className="hidden"
          aria-hidden
        />
        <div className="space-y-3">
          <Label>Pairs (source + reference, max 6)</Label>
          {pairs.map((pair, idx) => (
            <div
              key={idx}
              className="space-y-2 p-2 rounded-md border border-input/50"
            >
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => triggerSourcePick(idx)}
                  disabled={status === "training"}
                  className="justify-start truncate"
                >
                  {pair.source ? pair.source.name : `Pair ${idx + 1} source…`}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => triggerReferencePick(idx)}
                  disabled={status === "training"}
                  className="justify-start truncate"
                >
                  {pair.reference ? pair.reference.name : `Pair ${idx + 1} ref…`}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`pair-same-scene-${idx}`}
                  checked={pair.refSourceSameScene ?? true}
                  onCheckedChange={(checked) =>
                    setPairs((prev) =>
                      prev.map((p, i) =>
                        i === idx
                          ? { ...p, refSourceSameScene: checked === true }
                          : p
                      )
                    )
                  }
                  disabled={status === "training"}
                />
                <Label htmlFor={`pair-same-scene-${idx}`} className="text-sm">
                  Ref, source same scene
                </Label>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <Label htmlFor="train-camera">Camera type</Label>
          <Select
            value={cameraType}
            onValueChange={setCameraType}
            disabled={status === "training"}
          >
            <SelectTrigger id="train-camera" className="w-full">
              <SelectValue placeholder="Select camera" />
            </SelectTrigger>
            <SelectContent>
              {CAMERA_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {cameraType === "Other" && (
            <Input
              placeholder="e.g. Canon R5"
              value={cameraTypeOther}
              onChange={(e) => setCameraTypeOther(e.target.value)}
              disabled={status === "training"}
              className="mt-2"
            />
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="train-iterations">Iterations (5–100)</Label>
          <Input
            id="train-iterations"
            type="number"
            min={5}
            max={100}
            value={iterations}
            onChange={(e) => setIterations(Number(e.target.value) || 20)}
            disabled={status === "training"}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id="use-server-flow"
              checked={useServerFlow}
              onCheckedChange={(checked) => setUseServerFlow(checked === true)}
              disabled={status === "training"}
            />
            <Label htmlFor="use-server-flow" className="text-sm">
              Run on server (LibRaw)
            </Label>
          </div>
          {useServerFlow && (
            <p className="text-xs text-muted-foreground">
              Server mode uploads full source/reference; large files may be slow.
            </p>
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              id="use-phased-approach"
              checked={usePhasedApproach}
              onCheckedChange={(checked) =>
                setUsePhasedApproach(checked === true)
              }
              disabled={status === "training"}
            />
            <Label htmlFor="use-phased-approach" className="text-sm">
              Phased Approach
            </Label>
          </div>
          {usePhasedApproach && (
            <p className="text-xs text-muted-foreground">
              {matchModel2
                ? "3 phases (Exposure+Contrast+Density+Acutance, Per-band, Halation). Iterations map to 10 (30 steps), 20 (60 steps), or 40 (120 steps)."
                : "8 phases (exposure, contrast, color density, grading, per-band, refraction, actuance, halation). Iterations map to 10 (80 steps), 20 (160 steps), or 40 (320 steps)."}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              id="match-model-2"
              checked={matchModel2}
              onCheckedChange={(checked) => setMatchModel2(checked === true)}
              disabled={status === "training"}
            />
            <Label htmlFor="match-model-2" className="text-sm">
              Model 2
            </Label>
          </div>
          {matchModel2 && (
            <p className="text-xs text-muted-foreground">
              Uses Reinhard-style match (fixed 1.0) and 3 phases: Exposure+Contrast+Density+Acutance, 5-band hue/temp, Halation.
            </p>
          )}
        </div>

        <LoadingButton
          onClick={handleStart}
          disabled={!canStart}
          loading={status === "training"}
          loadingText="Training…"
        >
          Start training
        </LoadingButton>

        {status === "training" && maxIterations > 0 && (
          <ProgressWithLabel
            className="max-w-[280px]"
            value={Math.max(
              0,
              Math.min(100, (100 * currentIteration) / maxIterations)
            )}
            label={`${
              totalPairs > 1
                ? `Pair ${currentPair + 1} of ${totalPairs} — iteration ${currentIteration} of ${maxIterations}`
                : `Processing iteration ${currentIteration} of ${maxIterations}`
            }${message ? ` — ${message}` : ""}`}
          />
        )}

        {status === "done" && (
          <>
            <p className="text-sm text-green-600 dark:text-green-400">
              {message}
            </p>
            {finalImageUrl && (
              <div className="space-y-2 pt-2">
                <Label>Final result (full resolution)</Label>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={finalImageUrl}
                  alt="Training result"
                  className="max-w-full rounded-md border border-input object-contain max-h-[400px]"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const blob = finalBlobRef;
                    if (!blob) return;
                    const objectUrl = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = objectUrl;
                    link.download = `train-result-${Date.now()}.png`;
                    link.click();
                    URL.revokeObjectURL(objectUrl);
                  }}
                >
                  Download result
                </Button>
              </div>
            )}
          </>
        )}
        {status === "error" && (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{message}</p>
          </div>
        )}
      </Card>
    </div>
  );
}
