"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  decode,
  decodeDngLinear,
} from "@/src/lib/pipeline/decode";
import {
  frameToImageData,
  buildExposureMapFromSrgb,
  buildExposureMapFromLinearRgb,
  computeImageStats,
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

type PairFiles = { source: File | null; reference: File | null };

const CAMERA_OPTIONS = ["Leica M10", "Epson R-D1", "Sony A7", "Generic", "Other"];

function initPairs(): PairFiles[] {
  return Array.from({ length: MAX_PAIRS }, () => ({
    source: null,
    reference: null,
  }));
}

function isDng(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "image/x-adobe-dng" || type === "image/dng") return true;
  const name = (file.name || "").toLowerCase();
  return name.endsWith(".dng");
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

    const maxIter = Math.max(5, Math.min(100, iterations));
    setMaxIterations(maxIter);
    const camType = cameraTypeValue.trim() || null;

    try {
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
        const initialMatch = { ...DEFAULT_LOOK_PARAMS.match };
        let currentParams: LookParams = {
          match: initialMatch,
          grading: fittedGrading,
        };

        const referenceBase64 = await frameToPngBase64(
          decodedRef,
          IMAGE_MAX_EDGE
        );

        let lastDeltas: Record<string, number> = { one: 1 };
        let iterCount = 0;

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
          });
          const resultBase641 = await frameToPngBase64(result1, IMAGE_MAX_EDGE);

          const res1 = await fetch("/api/train/openai-deltas", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              result_base64: resultBase641,
              reference_base64: referenceBase64,
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
            currentParams = applyGradingDeltas(currentParams, nonHalationDeltas);
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
  }, [completePairs, iterations, cameraTypeValue]);

  return (
    <div className="p-4 md:p-6 max-w-2xl">
      <div className="mb-6">
        <Link
          href="/"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Home
        </Link>
      </div>

      <h1 className="text-2xl font-semibold mb-2">Train AI</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Run the OpenAI Vision training loop in your browser, using the same
        full-resolution RAW pipeline as the Lab. The AI compares each result to
        its reference and suggests parameter adjustments; corrections are saved.
      </p>

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
              className="grid grid-cols-2 gap-2 p-2 rounded-md border border-input/50"
            >
              <button
                type="button"
                onClick={() => triggerSourcePick(idx)}
                disabled={status === "training"}
                className="h-9 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:pointer-events-none disabled:opacity-50 text-left truncate"
              >
                {pair.source ? pair.source.name : `Pair ${idx + 1} source…`}
              </button>
              <button
                type="button"
                onClick={() => triggerReferencePick(idx)}
                disabled={status === "training"}
                className="h-9 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:pointer-events-none disabled:opacity-50 text-left truncate"
              >
                {pair.reference ? pair.reference.name : `Pair ${idx + 1} ref…`}
              </button>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <Label htmlFor="train-camera">Camera type</Label>
          <select
            id="train-camera"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            value={cameraType}
            onChange={(e) => setCameraType(e.target.value)}
            disabled={status === "training"}
          >
            {CAMERA_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
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

        <Button onClick={handleStart} disabled={!canStart}>
          {status === "training" ? "Training…" : "Start training"}
        </Button>

        {status === "training" && maxIterations > 0 && (
          <div className="space-y-1">
            <div className="h-1.5 w-full max-w-[280px] rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{
                  width: `${Math.max(
                    0,
                    Math.min(100, (100 * currentIteration) / maxIterations)
                  ).toFixed(1)}%`,
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {totalPairs > 1
                ? `Pair ${currentPair + 1} of ${totalPairs} — iteration ${currentIteration} of ${maxIterations}`
                : `Processing iteration ${currentIteration} of ${maxIterations}`}
            </p>
            <p className="text-xs text-muted-foreground">{message}</p>
          </div>
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
