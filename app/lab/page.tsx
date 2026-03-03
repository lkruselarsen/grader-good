"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  type LookParams,
  type RefractionWheel,
  DEFAULT_LOOK_PARAMS,
  engineToGrading,
  defaultRefractionWheel,
  default7HandleIdentity,
  defaultExposureCurve,
  defaultColorDensityCurve,
  defaultContrastCurve,
} from "@/lib/look-params";
import {
  runPipeline as runPipelineFn,
  previewSource,
  exportBaselinePngBlob,
  exportGradedPngBlob,
} from "@/lib/run-pipeline";
import { imageToSemanticEmbedding } from "@/src/lib/semanticEmbeddings";
import { imageToColClipTileEmbeddings } from "@/src/lib/colclipEmbeddings";
import {
  frameToImageData,
  computeImageStats,
  type ImageStats,
  type ExposureLevel,
  type ChromaDistribution,
} from "@/src/lib/pipeline";
import { decode } from "@/src/lib/pipeline/decode";
import { LEARNED_HEURISTICS } from "@/src/config/learnedHeuristics";
import {
  applyHeuristicsToMatch,
  type MatchContext,
} from "@/src/lib/pipeline/heuristicsAdapter";
import {
  bucketForSourceExposure,
  bucketForRefExposure,
  bucketForRefColor,
  type BucketName,
} from "@/src/lib/pipeline/heuristicsBuckets";

type ImgFile = { id: string; file: File; url: string };

function uuid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

function isDngFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "image/x-adobe-dng" || type === "image/dng") return true;
  const name = (file.name || "").toLowerCase();
  return name.endsWith(".dng");
}

function exposureScoreFromLevel(
  exposure: ExposureLevel | null | undefined
): number | null {
  const medianL = exposure?.medianL;
  if (typeof medianL !== "number" || !Number.isFinite(medianL)) {
    return null;
  }
  // Map medianL in [0, 1] to a score in [-1, 1] with a soft centre around 0.5.
  // Values ~0.3 → ≈ -1 (under), ~0.5 → 0 (normal), ~0.7 → ≈ +1 (over).
  const mid = 0.5;
  const span = 0.2;
  const raw = (medianL - mid) / span;
  const score = Math.max(-1, Math.min(1, raw));
  return Number.isFinite(score) ? score : null;
}

async function sourceFileForProcessing(
  file: File,
  canvas: HTMLCanvasElement | null
): Promise<File> {
  if (!isDngFile(file) || !canvas) return file;

  return new Promise<File>((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(file);
          return;
        }
        const safeName = file.name.replace(/\.dng$/i, ".png");
        resolve(
          new File([blob], safeName, {
            type: "image/png",
          })
        );
      },
      "image/png",
      0.95
    );
  });
}

/** Data-driven parameter sections; add halation/grain here later without refactoring layout. */
const PARAM_SECTIONS: Array<{
  id: keyof Pick<LookParams, "match" | "grading" | "halation" | "grain">;
  label: string;
  params: Array<{
    key: string;
    label: string;
    min: number;
    max: number;
    step: number;
  }>;
}> = [
  {
    id: "match",
    label: "Match",
    params: [
      {
        key: "exposureStrength",
        label: "Exposure match",
        min: 0,
        max: 2,
        step: 0.01,
      },
      {
        key: "lumaStrength",
        label: "Luma match",
        min: 0,
        max: 2,
        step: 0.01,
      },
      {
        key: "colorStrength",
        label: "Color match",
        min: 0,
        max: 2,
        step: 0.01,
      },
      {
        key: "blackStrength",
        label: "Black match strength",
        min: 0,
        max: 8,
        step: 0.05,
      },
      {
        key: "blackRange",
        label: "Black range",
        min: 0.2,
        max: 1.8,
        step: 0.01,
      },
      {
        key: "bandLowerShadow",
        label: "Lower shadow color",
        min: 0,
        max: 2,
        step: 0.05,
      },
      {
        key: "bandUpperShadow",
        label: "Upper shadow color",
        min: 0,
        max: 2,
        step: 0.05,
      },
      {
        key: "bandMid",
        label: "Mid color",
        min: 0,
        max: 2,
        step: 0.05,
      },
      {
        key: "bandLowerHigh",
        label: "Lower highlight color",
        min: 0,
        max: 2,
        step: 0.05,
      },
      {
        key: "bandUpperHigh",
        label: "Upper highlight color",
        min: 0,
        max: 2,
        step: 0.05,
      },
      { key: "colorDensity", label: "Color density", min: 0.5, max: 2, step: 0.05 },
      {
        key: "actuanceStrength",
        label: "Actuance strength",
        min: 0.75,
        max: 2,
        step: 0.05,
      },
      {
        key: "actuanceRadius",
        label: "Actuance radius",
        min: 0.5,
        max: 5,
        step: 0.5,
      },
    ],
  },
  {
    id: "match",
    label: "Halation",
    params: [
      {
        key: "highlightFillStrength",
        label: "Strength",
        min: 0,
        max: 2,
        step: 0.01,
      },
      {
        key: "highlightFillWarmth",
        label: "Warmth",
        min: -1,
        max: 1,
        step: 0.05,
      },
      {
        key: "halationTailGamma",
        label: "Tail gamma (ultra-highlight bias)",
        min: 2,
        max: 6,
        step: 0.1,
      },
      {
        key: "halationContrastGate",
        label: "Contrast gate (dark-neighbor)",
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        key: "halationRimStrength",
        label: "Rim strength (thin edge)",
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        key: "halationBloomStrength",
        label: "Bloom strength (soft halo)",
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        key: "halationRimRadius",
        label: "Rim radius (% short edge)",
        min: 0,
        max: 2,
        step: 0.05,
      },
      {
        key: "halationBloomRadius",
        label: "Bloom radius (% short edge)",
        min: 0,
        max: 10,
        step: 0.1,
      },
    ],
  },
];

export default function LabPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [source, setSource] = useState<ImgFile | null>(null);
  const [refs, setRefs] = useState<ImgFile[]>([]);
  const [activeRefId, setActiveRefId] = useState<string | null>(null);
  const [lookParams, setLookParams] = useState<LookParams>(DEFAULT_LOOK_PARAMS);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [isUsingEmbeddings, setIsUsingEmbeddings] = useState(false);
  const [applySuccess, setApplySuccess] = useState(false);
  const [correctionStatus, setCorrectionStatus] = useState<string | null>(null);
  const [hasAppliedHeuristics, setHasAppliedHeuristics] = useState(false);
  const [lastSourceStats, setLastSourceStats] = useState<ImageStats | null>(null);
  const [lastRefStats, setLastRefStats] = useState<ImageStats | null>(null);
  const [sourceType, setSourceType] = useState<"raw" | "png" | null>(null);
  const [useTileSearch, setUseTileSearch] = useState(false);
  /** Progress during "Use embeddings": phase label and optional tile count (e.g. "5 of 100 tiles"). */
  const [embeddingProgress, setEmbeddingProgress] = useState<{
    phase: string;
    current?: number;
    total?: number;
  } | null>(null);
  /** Phase text during "Apply" pipeline (e.g. "Decoding…", "Applying grade…"). */
  const [applyProgress, setApplyProgress] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);

  const previewAbortRef = useRef<AbortController | null>(null);
  const autoParamsRef = useRef<LookParams | null>(null);
  const lastMatchRef = useRef<{
    reference_exposure?: unknown;
    reference_chroma_distribution?: unknown;
  } | null>(null);

  const activeRef = useMemo(
    () => refs.find((r) => r.id === activeRefId) ?? null,
    [refs, activeRefId]
  );

  const applyPipeline = useCallback(async () => {
    previewAbortRef.current?.abort();
    setApplyError(null);
    setApplySuccess(false);
    if (!source) {
      setApplyError("No source image");
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      setApplyError("Canvas not ready");
      return;
    }
    setIsApplying(true);
    setApplyProgress(null);
    try {
      // Use original source so we grade the source image, not whatever is on the canvas.
      const result = await runPipelineFn(
        source.file,
        activeRef?.file ?? null,
        lookParams,
        canvas,
        { onProgress: (phase) => setApplyProgress(phase) }
      );
      if (result.sourceStats) {
        setLastSourceStats(result.sourceStats);
      }
      if (result.refStats) {
        setLastRefStats(result.refStats);
      }
      if (result.fittedGrading) {
        setLookParams((prev) => {
          // Use an explicit blackPoint in match so corrections/heuristics can learn it.
          const effectiveBlackPoint =
            prev.match.blackPoint ??
            result.fittedGrading?.refBlackL ??
            0.05;
          const nextMatch = {
            ...prev.match,
            blackPoint: effectiveBlackPoint,
          };
          const next: LookParams = {
            ...prev,
            match: nextMatch,
            grading: result.fittedGrading!,
          };
          autoParamsRef.current = next;
          return next;
        });
      }
      setHasAppliedHeuristics(false);
      setApplySuccess(true);
      setTimeout(() => setApplySuccess(false), 2500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setApplyError(message);
    } finally {
      setIsApplying(false);
      setApplyProgress(null);
    }
  }, [source, activeRef?.file, lookParams]);

  const runEmbeddingSearch = useCallback(async () => {
    previewAbortRef.current?.abort();
    setApplyError(null);
    setApplySuccess(false);
    if (!source) {
      setApplyError("No source image");
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      setApplyError("Canvas not ready");
      return;
    }
    setIsUsingEmbeddings(true);
    setHasAppliedHeuristics(false);
    setEmbeddingProgress(null);
    try {
      let body: { embeddingSemantic?: number[]; tileEmbeddings?: Array<{ tile_index: number; embedding: number[] }> };
      if (useTileSearch) {
        setEmbeddingProgress({ phase: "Decoding…" });
        const sourceFrame = await decode(source.file);
        const imageData = frameToImageData(sourceFrame);
        setEmbeddingProgress({ phase: "Tiles", current: 0, total: 100 });
        const tileEmbeddings = await imageToColClipTileEmbeddings(
          imageData,
          10,
          10,
          (current, total) => setEmbeddingProgress({ phase: "Tiles", current, total })
        );
        body = {
          tileEmbeddings: tileEmbeddings.map((vec, i) => ({ tile_index: i, embedding: vec })),
        };
      } else {
        setEmbeddingProgress({ phase: "Computing embedding…" });
        const processingFile = await sourceFileForProcessing(source.file, canvas);
        const embeddingSemantic = await imageToSemanticEmbedding(processingFile);
        body = { embeddingSemantic };
      }
      setEmbeddingProgress({ phase: "Searching…" });
      const res = await fetch("/api/dataset/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Search failed");
      }
      const matches = data.matches ?? [];
      if (matches.length === 0) {
        throw new Error("No matches. Add samples in Dataset first.");
      }
      const top = matches[0];
      lastMatchRef.current = {
        reference_exposure: top.reference_exposure ?? undefined,
        reference_chroma_distribution: top.reference_chroma_distribution ?? undefined,
      };
      const grading = engineToGrading(top.look_params);
      // Pull black/shadow and band strengths from the embedding when present.
      const embedded = top.look_params ?? {};
      const baseMatch = lookParams.match;
      // Anchor blackPoint to the effective reference black so auto/heuristics can learn from it.
      const effectiveBlackPoint =
        baseMatch.blackPoint ?? grading.refBlackL ?? 0.05;
      const nextMatch = {
        ...baseMatch,
        blackPoint: effectiveBlackPoint,
        blackStrength:
          typeof embedded.blackStrength === "number"
            ? embedded.blackStrength
            : baseMatch.blackStrength,
        blackRange:
          typeof embedded.blackRange === "number"
            ? embedded.blackRange
            : baseMatch.blackRange,
        bandLowerShadow:
          typeof embedded.colorBandStrengths?.lowerShadow === "number"
            ? embedded.colorBandStrengths.lowerShadow
            : baseMatch.bandLowerShadow,
        bandUpperShadow:
          typeof embedded.colorBandStrengths?.upperShadow === "number"
            ? embedded.colorBandStrengths.upperShadow
            : baseMatch.bandUpperShadow,
        bandMid:
          typeof embedded.colorBandStrengths?.mid === "number"
            ? embedded.colorBandStrengths.mid
            : baseMatch.bandMid,
        bandLowerHigh:
          typeof embedded.colorBandStrengths?.lowerHigh === "number"
            ? embedded.colorBandStrengths.lowerHigh
            : baseMatch.bandLowerHigh,
        bandUpperHigh:
          typeof embedded.colorBandStrengths?.upperHigh === "number"
            ? embedded.colorBandStrengths.upperHigh
            : baseMatch.bandUpperHigh,
      };
      const nextParams: LookParams = {
        ...lookParams,
        match: nextMatch,
        grading,
      };
      setLookParams(nextParams);
      autoParamsRef.current = nextParams;
      setEmbeddingProgress({ phase: "Applying grade…" });
      const pipelineResult = await runPipelineFn(
        source.file,
        null,
        nextParams,
        canvas,
        { onProgress: (phase) => setEmbeddingProgress({ phase }) }
      );
      if (pipelineResult.sourceStats) {
        setLastSourceStats(pipelineResult.sourceStats);
      }
      setLastRefStats(null);
      setApplySuccess(true);
      setTimeout(() => setApplySuccess(false), 2500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setApplyError(message);
    } finally {
      setIsUsingEmbeddings(false);
      setEmbeddingProgress(null);
    }
  }, [source, lookParams, useTileSearch]);

  const runEmbeddingSearchWithCorrections = useCallback(async () => {
    previewAbortRef.current?.abort();
    setApplyError(null);
    setApplySuccess(false);
    if (!source) {
      setApplyError("No source image");
      return;
    }
    if (!LEARNED_HEURISTICS) {
      setApplyError("No learned heuristics. Train corrections first.");
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      setApplyError("Canvas not ready");
      return;
    }
    setIsUsingEmbeddings(true);
    setHasAppliedHeuristics(false);
    setEmbeddingProgress(null);
    try {
      let body: { embeddingSemantic?: number[]; tileEmbeddings?: Array<{ tile_index: number; embedding: number[] }> };
      if (useTileSearch) {
        setEmbeddingProgress({ phase: "Decoding…" });
        const sourceFrame = await decode(source.file);
        const imageData = frameToImageData(sourceFrame);
        setEmbeddingProgress({ phase: "Tiles", current: 0, total: 100 });
        const tileEmbeddings = await imageToColClipTileEmbeddings(
          imageData,
          10,
          10,
          (current, total) => setEmbeddingProgress({ phase: "Tiles", current, total })
        );
        body = {
          tileEmbeddings: tileEmbeddings.map((vec, i) => ({ tile_index: i, embedding: vec })),
        };
      } else {
        setEmbeddingProgress({ phase: "Computing embedding…" });
        const processingFile = await sourceFileForProcessing(source.file, canvas);
        const embeddingSemantic = await imageToSemanticEmbedding(processingFile);
        body = { embeddingSemantic };
      }
      setEmbeddingProgress({ phase: "Searching…" });
      const res = await fetch("/api/dataset/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Search failed");
      }
      const matches = data.matches ?? [];
      if (matches.length === 0) {
        throw new Error("No matches. Add samples in Dataset first.");
      }
      const top = matches[0];
      lastMatchRef.current = {
        reference_exposure: top.reference_exposure ?? undefined,
        reference_chroma_distribution: top.reference_chroma_distribution ?? undefined,
      };
      const grading = engineToGrading(top.look_params);
      const embedded = top.look_params ?? {};
      const baseMatch = lookParams.match;
      const effectiveBlackPoint =
        baseMatch.blackPoint ?? grading.refBlackL ?? 0.05;
      let nextMatch = {
        ...baseMatch,
        blackPoint: effectiveBlackPoint,
        blackStrength:
          typeof embedded.blackStrength === "number"
            ? embedded.blackStrength
            : baseMatch.blackStrength,
        blackRange:
          typeof embedded.blackRange === "number"
            ? embedded.blackRange
            : baseMatch.blackRange,
        bandLowerShadow:
          typeof embedded.colorBandStrengths?.lowerShadow === "number"
            ? embedded.colorBandStrengths.lowerShadow
            : baseMatch.bandLowerShadow,
        bandUpperShadow:
          typeof embedded.colorBandStrengths?.upperShadow === "number"
            ? embedded.colorBandStrengths.upperShadow
            : baseMatch.bandUpperShadow,
        bandMid:
          typeof embedded.colorBandStrengths?.mid === "number"
            ? embedded.colorBandStrengths.mid
            : baseMatch.bandMid,
        bandLowerHigh:
          typeof embedded.colorBandStrengths?.lowerHigh === "number"
            ? embedded.colorBandStrengths.lowerHigh
            : baseMatch.bandLowerHigh,
        bandUpperHigh:
          typeof embedded.colorBandStrengths?.upperHigh === "number"
            ? embedded.colorBandStrengths.upperHigh
            : baseMatch.bandUpperHigh,
      };
      setEmbeddingProgress({ phase: "Applying corrections…" });
      const sourceFrame = await decode(source.file);
      const sourceStats = computeImageStats(frameToImageData(sourceFrame));
      const sourceExposureLevel = sourceStats.exposureLevel;
      const sourceExposureBucket = bucketForSourceExposure(sourceExposureLevel);
      const sourceExposureScore = exposureScoreFromLevel(sourceExposureLevel);
      const sourceTypeBucket: BucketName | undefined = sourceType
        ? (`source_type:${sourceType}` as BucketName)
        : undefined;
      const refExposureSource: ExposureLevel | null =
        (top.reference_exposure as ExposureLevel | null) ?? null;
      const refColorSource: ChromaDistribution | null =
        (top.reference_chroma_distribution as ChromaDistribution | null) ?? null;
      const refExposureBucket = bucketForRefExposure(refExposureSource);
      const refExposureScore = exposureScoreFromLevel(refExposureSource);
      const refColorBucket = bucketForRefColor(refColorSource);
      const ctx: MatchContext = {
        sourceExposureBucket,
        sourceExposureScore,
        sourceTypeBucket,
        refExposureBucket,
        refExposureScore,
        refColorBucket,
      };
      const adjustedMatch = applyHeuristicsToMatch(nextMatch, LEARNED_HEURISTICS, ctx);
      nextMatch = { ...nextMatch, ...adjustedMatch };
      const nextParams: LookParams = {
        ...lookParams,
        match: nextMatch,
        grading,
      };
      setLookParams(nextParams);
      autoParamsRef.current = nextParams;
      setLastSourceStats(sourceStats);
      setLastRefStats(null);
      setHasAppliedHeuristics(true);
      setEmbeddingProgress({ phase: "Applying grade…" });
      const pipelineResult = await runPipelineFn(
        source.file,
        null,
        nextParams,
        canvas,
        { onProgress: (phase) => setEmbeddingProgress({ phase }) }
      );
      if (pipelineResult.sourceStats) {
        setLastSourceStats(pipelineResult.sourceStats);
      }
      setApplySuccess(true);
      setTimeout(() => setApplySuccess(false), 2500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setApplyError(message);
    } finally {
      setIsUsingEmbeddings(false);
      setEmbeddingProgress(null);
    }
  }, [source, lookParams, useTileSearch, sourceType]);

  // Show raw source preview when source is uploaded (no grading applied)
  useEffect(() => {
    if (!source || !canvasRef.current) return;
    previewAbortRef.current?.abort();
    const ctrl = new AbortController();
    previewAbortRef.current = ctrl;
    void previewSource(source.file, canvasRef.current, ctrl.signal).finally(
      () => {
        if (previewAbortRef.current === ctrl) previewAbortRef.current = null;
      }
    );
    return () => ctrl.abort();
  }, [source]);

  async function onPickSource(file: File | null) {
    if (!file) return;
    const url = await fileToDataUrl(file);
    setSource({ id: uuid(), file, url });
    setSourceType(isDngFile(file) ? "raw" : "png");
    setLastSourceStats(null);
    setLastRefStats(null);
    lastMatchRef.current = null;
    setHasAppliedHeuristics(false);
  }

  async function onPickRefs(files: FileList | null) {
    if (!files || files.length === 0) return;
    const items: ImgFile[] = [];
    for (const f of Array.from(files)) {
      const url = await fileToDataUrl(f);
      items.push({ id: uuid(), file: f, url });
    }
    setRefs((prev) => [...prev, ...items]);
    if (!activeRefId && items[0]) setActiveRefId(items[0].id);
  }

  function setParam(
    sectionId: keyof LookParams,
    paramKey: string,
    value: number
  ) {
    setLookParams((prev) => {
      const section = prev[sectionId];
      if (!section || typeof section !== "object") return prev;
      return {
        ...prev,
        [sectionId]: { ...section, [paramKey]: value },
      };
    });
  }

  async function onExport() {
    if (!source) return;
    setIsExporting(true);
    setExportProgress("Decoding…");
    try {
      const blob = await exportGradedPngBlob(
        source.file,
        activeRef?.file ?? null,
        lookParams,
        { onProgress: (p) => setExportProgress(p) }
      );
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `graded_${source.file.name.replace(/\.[^.]+$/, "")}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      console.error("Export failed", err);
    } finally {
      setIsExporting(false);
      setExportProgress(null);
    }
  }

  async function onExportBaseline() {
    if (!source) return;
    try {
      const blob = await exportBaselinePngBlob(source.file);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `baseline_${source.file.name.replace(/\.[^.]+$/, "")}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      // Swallow debug export errors; they shouldn't block normal usage.
    }
  }

  async function onUploadCorrection() {
    setCorrectionStatus(null);
    if (!source) {
      setCorrectionStatus("No source image to associate with this correction.");
      return;
    }
    const autoParams = autoParamsRef.current ?? lookParams;
    try {
      const sourceFrame = await decode(source.file);
      const sourceStats = computeImageStats(frameToImageData(sourceFrame));
      const source_type = source.file.name.toLowerCase().endsWith(".dng")
        ? "raw"
        : "png";

      let reference_exposure: typeof sourceStats.exposureLevel | null = null;
      let reference_chroma_distribution: typeof sourceStats.chromaDistribution | null = null;

      if (activeRef?.file) {
        const refFrame = await decode(activeRef.file);
        const refStats = computeImageStats(frameToImageData(refFrame));
        reference_exposure = refStats.exposureLevel;
        reference_chroma_distribution = refStats.chromaDistribution;
      } else if (lastMatchRef.current?.reference_exposure && lastMatchRef.current?.reference_chroma_distribution) {
        reference_exposure = lastMatchRef.current.reference_exposure as typeof sourceStats.exposureLevel;
        reference_chroma_distribution = lastMatchRef.current.reference_chroma_distribution as typeof sourceStats.chromaDistribution;
      }

      const payload = {
        sourceId: `${source.file.name}:${source.file.size}:${source.file.lastModified}`,
        referenceId: activeRef?.id ?? null,
        sourceFilename: source.file.name,
        referenceFilename: activeRef?.file.name ?? null,
        autoParams,
        correctedParams: lookParams,
        source_exposure: sourceStats.exposureLevel,
        source_chroma_distribution: sourceStats.chromaDistribution,
        reference_exposure,
        reference_chroma_distribution,
        source_type,
      };
      const res = await fetch("/api/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to upload correction");
      }
      setCorrectionStatus("Correction uploaded.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCorrectionStatus(`Upload failed: ${message}`);
    }
  }

  function onApplyHeuristics() {
    if (!LEARNED_HEURISTICS) return;
    if (!source) return;
    if (hasAppliedHeuristics) return;

    const baseMatch = lookParams.match;

    const sourceExposureLevel = lastSourceStats?.exposureLevel ?? null;
    const sourceExposureBucket = bucketForSourceExposure(sourceExposureLevel);
    const sourceExposureScore = exposureScoreFromLevel(sourceExposureLevel);

    const sourceTypeBucket: BucketName | undefined = sourceType
      ? (`source_type:${sourceType}` as BucketName)
      : undefined;

    const refExposureSource: ExposureLevel | null =
      (lastMatchRef.current?.reference_exposure as ExposureLevel | null) ??
      lastRefStats?.exposureLevel ??
      null;
    const refColorSource: ChromaDistribution | null =
      (lastMatchRef.current
        ?.reference_chroma_distribution as ChromaDistribution | null) ??
      lastRefStats?.chromaDistribution ??
      null;

    const refExposureBucket = bucketForRefExposure(refExposureSource);
    const refExposureScore = exposureScoreFromLevel(refExposureSource);
    const refColorBucket = bucketForRefColor(refColorSource);

    const ctx: MatchContext = {
      sourceExposureBucket,
       // Soft weighting between exposure buckets
      sourceExposureScore,
      sourceTypeBucket,
      refExposureBucket,
      refExposureScore,
      refColorBucket,
    };

    const adjustedMatch = applyHeuristicsToMatch(
      baseMatch,
      LEARNED_HEURISTICS,
      ctx
    );

    setLookParams((prev) => ({
      ...prev,
      match: adjustedMatch,
    }));
    setHasAppliedHeuristics(true);
  }

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Lab</h1>
        <a href="/dataset" className="text-sm text-muted-foreground hover:underline">
          Dataset
        </a>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(320px,400px)_1fr] gap-4 lg:gap-6">
        <Card className="p-4 flex flex-col border bg-card overflow-hidden">
          <ScrollArea className="flex-1 max-h-[calc(100vh-12rem)] lg:max-h-[calc(100vh-10rem)]">
            <div className="space-y-4 pr-4">
              <section className="space-y-2">
                <h2 className="text-sm font-medium text-muted-foreground">
                  Source
                </h2>
                <Input
                  type="file"
                  accept="image/png,image/jpeg,image/dng,image/x-adobe-dng,.dng"
                  onChange={(e) => onPickSource(e.target.files?.[0] ?? null)}
                />
              </section>

              <Separator />

              <section className="space-y-2">
                <h2 className="text-sm font-medium text-muted-foreground">
                  References
                </h2>
                <Input
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/dng,image/x-adobe-dng,.dng"
                  onChange={(e) => onPickRefs(e.target.files)}
                />
                <div className="space-y-1">
                  <div className="flex flex-wrap gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void runEmbeddingSearch()}
                      disabled={!source || isApplying || isUsingEmbeddings}
                    >
                      {isUsingEmbeddings ? "Searching…" : "Use embeddings"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void runEmbeddingSearchWithCorrections()}
                      disabled={
                        !source ||
                        isApplying ||
                        isUsingEmbeddings ||
                        !LEARNED_HEURISTICS
                      }
                    >
                      Use embeddings + corrections
                    </Button>
                  </div>
                  {isUsingEmbeddings && embeddingProgress && (
                    <>
                      <div className="h-1.5 w-full max-w-[200px] rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full bg-primary transition-all duration-300 ${
                            embeddingProgress.total == null || embeddingProgress.total <= 0
                              ? "w-full animate-pulse"
                              : ""
                          }`}
                          style={
                            embeddingProgress.total != null && embeddingProgress.total > 0
                              ? {
                                  width: `${(100 * (embeddingProgress.current ?? 0)) / embeddingProgress.total}%`,
                                }
                              : { width: "100%" }
                          }
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {embeddingProgress.phase}
                        {embeddingProgress.total != null &&
                          embeddingProgress.total > 0 &&
                          ` — ${embeddingProgress.current ?? 0} of ${embeddingProgress.total} tiles`}
                      </p>
                    </>
                  )}
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={useTileSearch}
                    onChange={(e) => setUseTileSearch(e.target.checked)}
                    disabled={isUsingEmbeddings}
                  />
                  Use tile search (10×10, slower)
                </label>

                {refs.length > 0 && (
                  <Tabs
                    value={activeRefId ?? ""}
                    onValueChange={(v) => setActiveRefId(v)}
                  >
                    <TabsList className="flex flex-wrap gap-1 h-auto p-1">
                      {refs.map((r, idx) => (
                        <TabsTrigger
                          key={r.id}
                          value={r.id}
                          className="flex flex-col items-center gap-0.5 p-2 data-[state=active]:ring-2"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={r.url}
                            alt={`Ref ${idx + 1}`}
                            className="size-12 object-cover rounded border"
                          />
                          <span className="text-xs">Ref {idx + 1}</span>
                        </TabsTrigger>
                      ))}
                    </TabsList>
                    {refs.map((r) => (
                      <TabsContent
                        key={r.id}
                        value={r.id}
                        className="pt-3 space-y-1"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={r.url}
                          alt="reference"
                          className="w-full max-h-40 object-contain rounded-md border"
                        />
                        <p className="text-xs text-muted-foreground truncate">
                          {r.file.name}
                        </p>
                      </TabsContent>
                    ))}
                  </Tabs>
                )}
              </section>

              <Separator />

              <section className="space-y-3">
                <h2 className="text-sm font-medium text-muted-foreground">
                  Parameters
                </h2>
                {PARAM_SECTIONS.map((section) => {
                  const sectionParams = lookParams[section.id];
                  if (!sectionParams || typeof sectionParams !== "object")
                    return null;
                  return (
                    <div key={`${section.id}-${section.label}`} className="space-y-3">
                      <h3 className="text-xs font-medium text-muted-foreground/80">
                        {section.label}
                      </h3>
                      {section.params.map((param) => {
                        const raw =
                          (sectionParams as Record<string, number>)[param.key];
                        const value = typeof raw === "number" ? raw : undefined;
                        if (value === undefined) return null;
                        return (
                          <div key={param.key} className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <Label className="text-xs">{param.label}</Label>
                              <span className="text-[10px] tabular-nums text-muted-foreground">
                                {value.toFixed(3)}
                              </span>
                            </div>
                            <Slider
                              value={[value]}
                              min={param.min}
                              max={param.max}
                              step={param.step}
                              onValueChange={(v) =>
                                setParam(
                                  section.id,
                                  param.key,
                                  v[0] ?? param.min
                                )
                              }
                            />
                          </div>
                        );
                      })}
                      {section.id === "match" && (
                        <>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Black point</Label>
                            <div className="flex items-center gap-2">
                              <Slider
                                className="flex-1"
                                value={[
                                  lookParams.match.blackPoint ??
                                    lookParams.grading.refBlackL ??
                                    0.05,
                                ]}
                                min={0}
                                max={0.6}
                                step={0.005}
                                onValueChange={(v) =>
                                  setParam("match", "blackPoint", v[0] ?? 0.05)
                                }
                              />
                              <Input
                                type="number"
                                className="w-16 h-8 text-xs"
                                min={0}
                                max={0.6}
                                step={0.005}
                                value={
                                  lookParams.match.blackPoint ??
                                  lookParams.grading.refBlackL ??
                                  0.05
                                }
                                onChange={(e) => {
                                  const n = parseFloat(e.target.value);
                                  if (!Number.isNaN(n))
                                    setParam(
                                      "match",
                                      "blackPoint",
                                      Math.max(0, Math.min(0.6, n))
                                    );
                                }}
                              />
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                              Reference black anchor (overrides fitted value)
                            </p>
                          </div>

                          {/* Advanced per-band controls: hue / saturation / luma */}
                          <div className="mt-3 space-y-2 border-t pt-2">
                            <h4 className="text-[11px] font-medium text-muted-foreground/80">
                              Band overrides (advanced)
                            </h4>
                            <p className="text-[10px] text-muted-foreground">
                              Fine-tune hue, saturation, and tone per band on top of the
                              automatic 5-band match.
                            </p>
                            {[
                              {
                                id: "lowerShadow",
                                label: "Lower shadow",
                              },
                              {
                                id: "upperShadow",
                                label: "Upper shadow",
                              },
                              {
                                id: "mid",
                                label: "Mid",
                              },
                              {
                                id: "lowerHigh",
                                label: "Lower highlight",
                              },
                              {
                                id: "upperHigh",
                                label: "Upper highlight",
                              },
                            ].map((band) => {
                              const hueKey = `band${band.id[0].toUpperCase()}${band.id.slice(
                                1
                              )}Hue`;
                              const satKey = `band${band.id[0].toUpperCase()}${band.id.slice(
                                1
                              )}Sat`;
                              const lumaKey = `band${
                                band.id[0].toUpperCase() + band.id.slice(1)
                              }Luma`;
                              const matchSection =
                                lookParams.match as unknown as Record<string, number>;
                              const hueVal = matchSection[hueKey] ?? 0;
                              const satVal = matchSection[satKey] ?? 1;
                              const lumaVal = matchSection[lumaKey] ?? 0;
                              const tempKey = `band${
                                band.id[0].toUpperCase() + band.id.slice(1)
                              }Temp`;
                              const tempVal = matchSection[tempKey] ?? 0;
                              return (
                                <div
                                  key={band.id}
                                  className="space-y-1.5 rounded-md bg-muted/30 p-2"
                                >
                                  <div className="text-[11px] font-medium text-muted-foreground/90">
                                    {band.label}
                                  </div>
                                  <div className="space-y-1.5">
                                    <div className="flex items-center justify-between gap-2">
                                      <Label className="text-[10px]">Hue</Label>
                                      <span className="text-[10px] tabular-nums text-muted-foreground">
                                        {hueVal.toFixed(2)}
                                      </span>
                                    </div>
                                    <Slider
                                      value={[hueVal]}
                                      min={-1}
                                      max={1}
                                      step={0.01}
                                      onValueChange={(v) =>
                                        setParam(
                                          "match",
                                          hueKey,
                                          v[0] ?? 0
                                        )
                                      }
                                    />
                                  </div>
                                  <div className="space-y-1.5">
                                    <div className="flex items-center justify-between gap-2">
                                      <Label className="text-[10px]">
                                        Saturation
                                      </Label>
                                      <span className="text-[10px] tabular-nums text-muted-foreground">
                                        {satVal.toFixed(2)}
                                      </span>
                                    </div>
                                    <Slider
                                      value={[satVal]}
                                      min={0}
                                      max={2}
                                      step={0.05}
                                      onValueChange={(v) =>
                                        setParam(
                                          "match",
                                          satKey,
                                          v[0] ?? 1
                                        )
                                      }
                                    />
                                  </div>
                                  <div className="space-y-1.5">
                                    <div className="flex items-center justify-between gap-2">
                                      <Label className="text-[10px]">
                                        Tone
                                      </Label>
                                      <span className="text-[10px] tabular-nums text-muted-foreground">
                                        {lumaVal.toFixed(3)}
                                      </span>
                                    </div>
                                    <Slider
                                      value={[lumaVal]}
                                      min={-0.2}
                                      max={0.2}
                                      step={0.005}
                                      onValueChange={(v) =>
                                        setParam(
                                          "match",
                                          lumaKey,
                                          v[0] ?? 0
                                        )
                                      }
                                    />
                                  </div>
                                  <div className="space-y-1.5">
                                    <div className="flex items-center justify-between gap-2">
                                      <Label className="text-[10px]">
                                        Temp (cold ↔ warm)
                                      </Label>
                                      <span className="text-[10px] tabular-nums text-muted-foreground">
                                        {tempVal.toFixed(2)}
                                      </span>
                                    </div>
                                    <Slider
                                      value={[tempVal]}
                                      min={-1}
                                      max={1}
                                      step={0.01}
                                      onValueChange={(v) =>
                                        setParam(
                                          "match",
                                          tempKey,
                                          v[0] ?? 0
                                        )
                                      }
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>

                          {/* Refraction: shadow/highlight wheels + split */}
                          <details className="mt-3 border-t pt-2">
                            <summary className="text-[11px] font-medium text-muted-foreground/80 cursor-pointer">
                              Refraction (shadow / highlight wheels)
                            </summary>
                            <p className="text-[10px] text-muted-foreground mt-1">
                              H = hue in degrees (0–360). Red=0, Yellow=60, Green=120, Teal=180, Blue=240, Purple=300. S = saturation multiplier (0–3, 1 = normal).
                            </p>
                            <div className="mt-2 space-y-2">
                              <div className="text-[10px] font-medium">Shadow wheel</div>
                              {(lookParams.match.refractionShadow ?? defaultRefractionWheel()).map((node, i) => (
                                <div key={`shadow-${i}`} className="flex gap-2 items-center flex-wrap">
                                  <span className="text-[10px] w-14">{["R", "Y", "G", "T", "B", "P"][i]}</span>
                                  <Label className="text-[10px] w-6">H</Label>
                                  <Input type="number" className="w-14 h-7 text-xs" min={0} max={360} step={1} value={node.hue} onChange={(e) => {
                                    const v = parseFloat(e.target.value); if (!Number.isNaN(v)) { setLookParams(prev => { const w = prev.match.refractionShadow ?? defaultRefractionWheel(); const next = [...w] as RefractionWheel; next[i] = { ...next[i], hue: Math.max(0, Math.min(360, v)) }; return { ...prev, match: { ...prev.match, refractionShadow: next } }; }); }
                                  }} />
                                  <Label className="text-[10px] w-6">S</Label>
                                  <Input type="number" className="w-14 h-7 text-xs" min={0} max={3} step={0.1} value={node.sat} onChange={(e) => {
                                    const v = parseFloat(e.target.value); if (!Number.isNaN(v)) { setLookParams(prev => { const w = prev.match.refractionShadow ?? defaultRefractionWheel(); const next = [...w] as RefractionWheel; next[i] = { ...next[i], sat: Math.max(0, Math.min(3, v)) }; return { ...prev, match: { ...prev.match, refractionShadow: next } }; }); }
                                  }} />
                                </div>
                              ))}
                              <div className="text-[10px] font-medium mt-2">Highlight wheel</div>
                              {(lookParams.match.refractionHighlight ?? defaultRefractionWheel()).map((node, i) => (
                                <div key={`high-${i}`} className="flex gap-2 items-center flex-wrap">
                                  <span className="text-[10px] w-14">{["R", "Y", "G", "T", "B", "P"][i]}</span>
                                  <Label className="text-[10px] w-6">H</Label>
                                  <Input type="number" className="w-14 h-7 text-xs" min={0} max={360} step={1} value={node.hue} onChange={(e) => {
                                    const v = parseFloat(e.target.value); if (!Number.isNaN(v)) { setLookParams(prev => { const w = prev.match.refractionHighlight ?? defaultRefractionWheel(); const next = [...w] as RefractionWheel; next[i] = { ...next[i], hue: Math.max(0, Math.min(360, v)) }; return { ...prev, match: { ...prev.match, refractionHighlight: next } }; }); }
                                  }} />
                                  <Label className="text-[10px] w-6">S</Label>
                                  <Input type="number" className="w-14 h-7 text-xs" min={0} max={3} step={0.1} value={node.sat} onChange={(e) => {
                                    const v = parseFloat(e.target.value); if (!Number.isNaN(v)) { setLookParams(prev => { const w = prev.match.refractionHighlight ?? defaultRefractionWheel(); const next = [...w] as RefractionWheel; next[i] = { ...next[i], sat: Math.max(0, Math.min(3, v)) }; return { ...prev, match: { ...prev.match, refractionHighlight: next } }; }); }
                                  }} />
                                </div>
                              ))}
                              <div className="flex items-center gap-2 mt-2">
                                <Label className="text-[10px]">Split L</Label>
                                <Slider className="w-24" value={[lookParams.match.refractionSplitL ?? 0.5]} min={0} max={1} step={0.05} onValueChange={(v) => setParam("match", "refractionSplitL", v[0] ?? 0.5)} />
                                <span className="text-[10px] tabular-nums">{(lookParams.match.refractionSplitL ?? 0.5).toFixed(2)}</span>
                              </div>
                            </div>
                          </details>

                          {/* Exposure curve (7-handle) */}
                          <details className="mt-3 border-t pt-2">
                            <summary className="text-[11px] font-medium text-muted-foreground/80 cursor-pointer">
                              Exposure curve (7-handle)
                            </summary>
                            <p className="text-[10px] text-muted-foreground mt-1">
                              Per-band exposure multiplier. 1 = neutral; 0..2 scales exposure
                              match by tonal zone from deepest shadows (0) to brightest
                              highlights (6).
                            </p>
                            <div className="mt-2 space-y-1">
                              {(lookParams.match.exposureCurve ?? defaultExposureCurve()).L_out.map((_, idx) => {
                                const curve = lookParams.match.exposureCurve ?? defaultExposureCurve();
                                const exposure = curve.L_out[idx] ?? 1;
                                return (
                                  <div key={idx} className="flex gap-2 items-center text-[10px]">
                                    <span className="w-4">{idx}</span>
                                    <Label className="text-[10px] w-14">Exposure</Label>
                                    <Input
                                      type="number"
                                      className="w-16 h-6 text-xs"
                                      min={0}
                                      max={2}
                                      step={0.05}
                                      value={exposure}
                                      onChange={(e) => {
                                        const v = parseFloat(e.target.value);
                                        if (Number.isNaN(v)) return;
                                        const def = defaultExposureCurve();
                                        const base = lookParams.match.exposureCurve ?? def;
                                        const L_in = base.L_in.length
                                          ? [...base.L_in]
                                          : [...def.L_in];
                                        const L_out = [...(base.L_out.length ? base.L_out : def.L_out)];
                                        L_out[idx] = Math.max(0, Math.min(2, v));
                                        setLookParams((prev) => ({
                                          ...prev,
                                          match: {
                                            ...prev.match,
                                            exposureCurve: { L_in, L_out },
                                          },
                                        }));
                                      }}
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          </details>

                          {/* Contrast curve (7-handle) */}
                          <details className="mt-3 border-t pt-2">
                            <summary className="text-[11px] font-medium text-muted-foreground/80 cursor-pointer">
                              Contrast curve (7-handle)
                            </summary>
                            <p className="text-[10px] text-muted-foreground mt-1">
                              Filmic contrast by zone. Defaults (H1:-5 … H7:+5) = no change. Bezier interpolated between handles.
                            </p>
                            <div className="mt-2 space-y-1">
                              {(lookParams.match.contrastCurve ?? defaultContrastCurve()).values.map((_, idx) => {
                                const cur = lookParams.match.contrastCurve ?? defaultContrastCurve();
                                const value = cur.values[idx] ?? 0;
                                const labels = ["H1 (shadow)", "H2", "H3", "H4 (mid)", "H5", "H6", "H7 (highlight)"];
                                return (
                                  <div key={idx} className="flex gap-2 items-center text-[10px]">
                                    <span className="w-20">{labels[idx]}</span>
                                    <Label className="text-[10px] w-8">Val</Label>
                                    <Input
                                      type="number"
                                      className="w-16 h-6 text-xs"
                                      min={-5}
                                      max={5}
                                      step={0.25}
                                      value={value}
                                      onChange={(e) => {
                                        const v = parseFloat(e.target.value);
                                        if (Number.isNaN(v)) return;
                                        const def = defaultContrastCurve();
                                        const base = lookParams.match.contrastCurve ?? def;
                                        const L_anchors = base.L_anchors?.length ? [...base.L_anchors] : [...def.L_anchors];
                                        const values = [...(base.values?.length ? base.values : def.values)];
                                        values[idx] = Math.max(-5, Math.min(5, v));
                                        setLookParams((prev) => ({
                                          ...prev,
                                          match: {
                                            ...prev.match,
                                            contrastCurve: { L_anchors, values },
                                          },
                                        }));
                                      }}
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          </details>

                          {/* Color density curve (7-handle) */}
                          <details className="mt-3 border-t pt-2">
                            <summary className="text-[11px] font-medium text-muted-foreground/80 cursor-pointer">
                              Color density curve (7-handle)
                            </summary>
                            <p className="text-[10px] text-muted-foreground mt-1">L_anchors and scale per anchor.</p>
                            <div className="mt-2 space-y-1">
                              {(lookParams.match.colorDensityCurve ?? defaultColorDensityCurve()).L_anchors.map((_, idx) => {
                                const cur = lookParams.match.colorDensityCurve ?? defaultColorDensityCurve();
                                const L = cur.L_anchors[idx] ?? 0;
                                const scale = cur.scale[idx] ?? 1;
                                return (
                                  <div key={idx} className="flex gap-2 items-center text-[10px]">
                                    <span className="w-4">{idx}</span>
                                    <Input type="number" className="w-14 h-6 text-xs" min={0} max={1} step={0.05} value={L} onChange={(e) => {
                                      const v = parseFloat(e.target.value); if (Number.isNaN(v)) return; const def = defaultColorDensityCurve(); const L_anchors = [...(lookParams.match.colorDensityCurve?.L_anchors ?? def.L_anchors)]; L_anchors[idx] = Math.max(0, Math.min(1, v)); setLookParams(prev => ({ ...prev, match: { ...prev.match, colorDensityCurve: { L_anchors, scale: prev.match.colorDensityCurve?.scale ?? def.scale } } }));
                                    }} />
                                    <Input type="number" className="w-14 h-6 text-xs" min={0} max={2} step={0.1} value={scale} onChange={(e) => {
                                      const v = parseFloat(e.target.value); if (Number.isNaN(v)) return; const def = defaultColorDensityCurve(); const scale = [...(lookParams.match.colorDensityCurve?.scale ?? def.scale)]; scale[idx] = Math.max(0, Math.min(2, v)); setLookParams(prev => ({ ...prev, match: { ...prev.match, colorDensityCurve: { L_anchors: prev.match.colorDensityCurve?.L_anchors ?? def.L_anchors, scale } } }));
                                    }} />
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        </>
                      )}
                    </div>
                  );
                })}
              </section>

              {/* Tone curve (grading): 7-handle */}
              <details className="border rounded-md p-2">
                <summary className="text-[11px] font-medium text-muted-foreground/80 cursor-pointer">
                  Tone curve (grading, 7-handle)
                </summary>
                <p className="text-[10px] text-muted-foreground mt-1">L_in → L_out. Affects grading tone curve.</p>
                <div className="mt-2 space-y-1">
                  {(lookParams.grading.toneCurve ?? default7HandleIdentity()).L_in.map((_, idx) => {
                    const curve = lookParams.grading.toneCurve ?? default7HandleIdentity();
                    const L_in = curve.L_in[idx] ?? 0;
                    const L_out = curve.L_out[idx] ?? 0;
                    return (
                      <div key={idx} className="flex gap-2 items-center text-[10px]">
                        <span className="w-4">{idx}</span>
                        <Input type="number" className="w-14 h-6 text-xs" min={0} max={1} step={0.05} value={L_in} onChange={(e) => {
                          const v = parseFloat(e.target.value); if (Number.isNaN(v)) return; const def = default7HandleIdentity(); const L_in = [...(lookParams.grading.toneCurve?.L_in ?? def.L_in)]; L_in[idx] = Math.max(0, Math.min(1, v)); setLookParams(prev => ({ ...prev, grading: { ...prev.grading, toneCurve: { L_in, L_out: prev.grading.toneCurve?.L_out ?? def.L_out } } }));
                        }} />
                        <span>→</span>
                        <Input type="number" className="w-14 h-6 text-xs" min={0} max={1} step={0.05} value={L_out} onChange={(e) => {
                          const v = parseFloat(e.target.value); if (Number.isNaN(v)) return; const def = default7HandleIdentity(); const L_out = [...(lookParams.grading.toneCurve?.L_out ?? def.L_out)]; L_out[idx] = Math.max(0, Math.min(1, v)); setLookParams(prev => ({ ...prev, grading: { ...prev.grading, toneCurve: { L_in: prev.grading.toneCurve?.L_in ?? def.L_in, L_out } } }));
                        }} />
                      </div>
                    );
                  })}
                </div>
              </details>

              <Separator />

              <section className="flex gap-2 flex-wrap items-center">
                <div className="flex flex-col gap-1 min-w-0">
                  <Button
                    onClick={() => void applyPipeline()}
                    disabled={!source || isApplying || isUsingEmbeddings}
                    size="sm"
                  >
                    {isApplying ? "Processing…" : "Apply"}
                  </Button>
                  {isApplying && (
                    <>
                      <div className="h-1.5 w-full max-w-[200px] rounded-full bg-muted overflow-hidden">
                        <div className="h-full w-full min-w-[30%] bg-primary animate-pulse" />
                      </div>
                      {applyProgress && (
                        <p className="text-xs text-muted-foreground">{applyProgress}</p>
                      )}
                    </>
                  )}
                </div>
                <Button
                  variant="outline"
                  onClick={() => onApplyHeuristics()}
                  disabled={
                    !source ||
                    isApplying ||
                    isUsingEmbeddings ||
                    !LEARNED_HEURISTICS ||
                    hasAppliedHeuristics
                  }
                  size="sm"
                >
                  Apply heuristics
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void onExport()}
                  disabled={!source || isApplying || isUsingEmbeddings || isExporting}
                  size="sm"
                >
                  {isExporting ? (exportProgress ?? "Exporting…") : "Export full-res"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void onExportBaseline()}
                  disabled={!source || isApplying || isUsingEmbeddings}
                  size="sm"
                >
                  Export baseline PNG
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void onUploadCorrection()}
                  disabled={!source || isApplying || isUsingEmbeddings}
                  size="sm"
                >
                  Upload correction
                </Button>
                {(isApplying || isUsingEmbeddings) && (
                  <span className="text-xs text-muted-foreground">
                    {isUsingEmbeddings ? "Searching…" : "Running pipeline…"}
                  </span>
                )}
                {applySuccess && !isApplying && (
                  <span className="text-xs text-green-600 dark:text-green-400">
                    Applied
                  </span>
                )}
                {applyError && (
                  <p className="w-full text-xs text-destructive">
                    Apply failed: {applyError}
                  </p>
                )}
                {correctionStatus && (
                  <p className="w-full text-xs text-muted-foreground">
                    {correctionStatus}
                  </p>
                )}
              </section>
            </div>
          </ScrollArea>
        </Card>

        <Card className="p-4 flex flex-col min-h-[320px]">
          <h2 className="text-sm font-medium text-muted-foreground mb-2">
            Result
          </h2>
          <div className="flex-1 flex items-center justify-center rounded-md border bg-muted/30 min-h-[280px]">
            <canvas
              ref={canvasRef}
              className="max-w-full max-h-[calc(100vh-14rem)] object-contain"
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
