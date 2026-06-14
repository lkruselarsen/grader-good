import { buildEngineParamsFromLookParams } from "@/lib/build-engine-params";
import {
  applyLivePostModel2OnlyWithState,
  createLab2LiveWorkState,
  type Lab2LiveWorkState,
} from "@/lib/lab2-live-preview";
import type { LookParams } from "@/lib/look-params";
import {
  frameToImageData,
  pixelFrameF32ToPixelFrameRGBA,
  type PixelFrameF32,
} from "@/src/lib/pipeline";
import { linearRgbToOklab } from "@/src/lib/pipeline/stages/oklab";
import { scoreImageNaturalness } from "@/src/lib/qualityScorer";

export type AutoDensityCandidateScore = {
  density: number;
  totalScore: number;
  modelScore: number;
  penalty: number;
};

export type AutoDensityResult = {
  bestDensity: number;
  debugScores: AutoDensityCandidateScore[];
  usedModel: boolean;
};

type FrameMetrics = {
  clipRatio: number;
  meanC: number;
  p95C: number;
  meanA: number;
  meanB: number;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function uniqueSorted(vals: number[]): number[] {
  return Array.from(new Set(vals.map((v) => Math.round(v * 1000) / 1000))).sort(
    (a, b) => a - b
  );
}

function denseRange(start: number, end: number, count: number): number[] {
  if (count <= 1) return [start];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    out.push(start + (end - start) * t);
  }
  return out;
}

function computeFrameMetrics(frame: PixelFrameF32): FrameMetrics {
  const d = frame.data;
  const sampleEvery = 2;
  const width = frame.width;
  const height = frame.height;
  const chroma: number[] = [];
  let clipCount = 0;
  let count = 0;
  let sumA = 0;
  let sumB = 0;
  let sumC = 0;

  for (let y = 0; y < height; y += sampleEvery) {
    for (let x = 0; x < width; x += sampleEvery) {
      const i = (y * width + x) * 4;
      const r = d[i] ?? 0;
      const g = d[i + 1] ?? 0;
      const b = d[i + 2] ?? 0;
      if (r <= 0 || r >= 1 || g <= 0 || g >= 1 || b <= 0 || b >= 1) clipCount++;
      const lab = linearRgbToOklab(r, g, b);
      const c = Math.hypot(lab.a, lab.b);
      chroma.push(c);
      sumA += lab.a;
      sumB += lab.b;
      sumC += c;
      count++;
    }
  }

  if (count === 0) {
    return { clipRatio: 0, meanC: 0, p95C: 0, meanA: 0, meanB: 0 };
  }

  chroma.sort((a, b) => a - b);
  const p95Idx = Math.min(chroma.length - 1, Math.floor(chroma.length * 0.95));
  return {
    clipRatio: clipCount / count,
    meanC: sumC / count,
    p95C: chroma[p95Idx] ?? 0,
    meanA: sumA / count,
    meanB: sumB / count,
  };
}

function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

function computePenalty(metrics: FrameMetrics, baseline: FrameMetrics): number {
  const clipPenalty = clamp((metrics.clipRatio - 0.01) * 2.5, 0, 0.65);
  const lowChromaPenalty = clamp((0.045 - metrics.meanC) * 7, 0, 0.25);
  const highChromaPenalty = clamp((metrics.meanC - 0.23) * 5.5, 0, 0.4);
  const p95Penalty = clamp((metrics.p95C - 0.42) * 2, 0, 0.35);

  const baseHue = Math.atan2(baseline.meanB, baseline.meanA);
  const hue = Math.atan2(metrics.meanB, metrics.meanA);
  const hueDriftDeg = (angleDelta(hue, baseHue) * 180) / Math.PI;
  const huePenalty = clamp((hueDriftDeg - 10) / 30, 0, 0.15);

  return clamp(
    clipPenalty + lowChromaPenalty + highChromaPenalty + p95Penalty + huePenalty,
    0,
    0.95
  );
}

async function scoreFrameNaturalness(frame: PixelFrameF32): Promise<number | null> {
  const rgba = pixelFrameF32ToPixelFrameRGBA(frame);
  const imageData = frameToImageData(rgba);
  return scoreImageNaturalness(imageData, { timeoutMs: 5000 });
}

export async function findBestAutoDensityForLab2(input: {
  /** Preview-resolution post–M2 base (aligned with live UI). */
  postModel2PreviewBase: PixelFrameF32;
  lookParams: LookParams;
  finalGrading: LookParams["grading"];
  halationPreviewEnabled: boolean;
  workingState?: Lab2LiveWorkState | null;
  onPhase?: (label: string) => void;
  isStale?: () => boolean;
  minDensity?: number;
  maxDensity?: number;
}): Promise<AutoDensityResult> {
  const minDensity = input.minDensity ?? 0.85;
  const maxDensity = input.maxDensity ?? 2.15;
  const baselineDensity = clamp(
    input.lookParams.match.colorDensityCurveMasterMul ?? 1.5,
    minDensity,
    maxDensity
  );
  const coarse = denseRange(minDensity, maxDensity, 9);
  const candidates = uniqueSorted([baselineDensity, ...coarse]);
  const work =
    input.workingState ??
    createLab2LiveWorkState(input.postModel2PreviewBase.width, input.postModel2PreviewBase.height);

  const baselineLook: LookParams = {
    ...input.lookParams,
    match: {
      ...input.lookParams.match,
      colorDensityCurveMasterMul: baselineDensity,
    },
  };
  const baselineEngine = buildEngineParamsFromLookParams(
    baselineLook,
    input.finalGrading
  );
  const baselineFrame = applyLivePostModel2OnlyWithState(
    input.postModel2PreviewBase,
    baselineEngine,
    work,
    { halationPreview: input.halationPreviewEnabled }
  );
  const baselineMetrics = computeFrameMetrics(baselineFrame);

  const debug: AutoDensityCandidateScore[] = [];
  let sawModelScore = false;

  for (const density of candidates) {
    if (input.isStale?.()) break;
    input.onPhase?.(`Auto density scoring… ${density.toFixed(2)}`);
    const candidateLook: LookParams = {
      ...input.lookParams,
      match: {
        ...input.lookParams.match,
        colorDensityCurveMasterMul: density,
      },
    };
    const engine = buildEngineParamsFromLookParams(candidateLook, input.finalGrading);
    const frame = applyLivePostModel2OnlyWithState(
      input.postModel2PreviewBase,
      engine,
      work,
      { halationPreview: input.halationPreviewEnabled }
    );
    const modelScoreRaw = await scoreFrameNaturalness(frame);
    if (input.isStale?.()) break;
    if (modelScoreRaw != null) sawModelScore = true;
    const modelScore = modelScoreRaw ?? 0.5;
    const metrics = computeFrameMetrics(frame);
    const penalty = computePenalty(metrics, baselineMetrics);
    debug.push({
      density,
      modelScore,
      penalty,
      totalScore: modelScore - penalty,
    });
  }

  if (debug.length === 0) {
    return { bestDensity: baselineDensity, debugScores: [], usedModel: false };
  }

  debug.sort((a, b) => b.totalScore - a.totalScore);
  const coarseBest = debug[0];
  const refine = uniqueSorted([
    clamp(coarseBest.density - 0.12, minDensity, maxDensity),
    clamp(coarseBest.density - 0.06, minDensity, maxDensity),
    coarseBest.density,
    clamp(coarseBest.density + 0.06, minDensity, maxDensity),
    clamp(coarseBest.density + 0.12, minDensity, maxDensity),
  ]);

  for (const density of refine) {
    if (input.isStale?.()) break;
    if (debug.some((d) => Math.abs(d.density - density) < 1e-4)) continue;
    input.onPhase?.(`Auto density tuning… ${density.toFixed(2)}`);
    const candidateLook: LookParams = {
      ...input.lookParams,
      match: {
        ...input.lookParams.match,
        colorDensityCurveMasterMul: density,
      },
    };
    const engine = buildEngineParamsFromLookParams(candidateLook, input.finalGrading);
    const frame = applyLivePostModel2OnlyWithState(
      input.postModel2PreviewBase,
      engine,
      work,
      { halationPreview: input.halationPreviewEnabled }
    );
    const modelScoreRaw = await scoreFrameNaturalness(frame);
    if (input.isStale?.()) break;
    if (modelScoreRaw != null) sawModelScore = true;
    const modelScore = modelScoreRaw ?? 0.5;
    const metrics = computeFrameMetrics(frame);
    const penalty = computePenalty(metrics, baselineMetrics);
    debug.push({
      density,
      modelScore,
      penalty,
      totalScore: modelScore - penalty,
    });
  }

  debug.sort((a, b) => b.totalScore - a.totalScore);
  const bestDensity = clamp(debug[0]?.density ?? baselineDensity, minDensity, maxDensity);
  return {
    bestDensity,
    debugScores: debug,
    usedModel: sawModelScore,
  };
}
