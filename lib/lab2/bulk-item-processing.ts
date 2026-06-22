import { buildEngineParamsFromLookParams } from "@/lib/build-engine-params";
import {
  applyLivePostModel2OnlyWithState,
  buildPostModel2BaseFrame,
  clonePixelFrameF32,
  ensureLab2LiveWorkState,
  type Lab2LivePreviewOptions,
  type Lab2LiveWorkState,
} from "@/lib/lab2-live-preview";
import { downscaleLinearFloatMaxEdge, PREVIEW_LIVE_MAX_EDGE } from "@/lib/scale-linear-float-frame";
import {
  buildExposureMapFromFloat,
  pixelFrameF32ToPixelFrameRGBA,
  type PixelFrameF32,
} from "@/src/lib/pipeline";
import type { LookParams as LookParamsT } from "@/lib/look-params";
import { decodeSourceFile } from "./auto-match";
import {
  buildBulkItemFrames,
  mergeBulkItemFrames,
  resolveMatchCandidateFromFrames,
  type BulkItemFrames,
} from "./bulk-frame-registry";
import { cloneLab2LookParams } from "./constants";
import {
  buildMatchPreviews,
  populateMatchCandidateSlots,
  processSourceFileAuto,
} from "./auto-match";
import {
  buildThumbUrlFromFloatFrame,
  cloneRgbaFrame,
  isValidPixelFrameF32,
} from "./canvas-utils";
import type {
  ActiveMatchSelection,
  BulkItem,
  Lab2TileBlend,
  MatchRank,
  RgbaFrame,
} from "./types";

export type BulkItemProcessingResult = Partial<BulkItem> & {
  frames?: BulkItemFrames;
};

const FRAME_DATA_ITEM_KEYS = [
  "decodedSource",
  "decodedRef",
  "postM2Base",
  "postM2PreviewBase",
  "matchCandidates",
  "rankedMatchesByBlend",
] as const satisfies readonly (keyof BulkItem)[];

/** Strip heavy pixel buffers from a bulk item patch — frames live in the registry only. */
export function stripFrameDataFromItemPatch(
  patch: Partial<BulkItem>
): Partial<BulkItem> {
  const next = { ...patch };
  for (const key of FRAME_DATA_ITEM_KEYS) {
    delete next[key];
  }
  return {
    ...next,
    decodedSource: null,
    decodedRef: null,
    postM2Base: null,
    postM2PreviewBase: null,
  };
}

async function resolveSourceFrame(
  item: BulkItem,
  frames: BulkItemFrames | undefined
): Promise<PixelFrameF32> {
  if (frames && isValidPixelFrameF32(frames.decodedSource)) {
    return clonePixelFrameF32(frames.decodedSource);
  }
  if (isValidPixelFrameF32(item.decodedSource)) {
    return clonePixelFrameF32(item.decodedSource);
  }
  return decodeSourceFile(item.file, item.sourceDecodeRd1);
}

export function buildPostModel2ForItem(
  decodedSource: PixelFrameF32,
  decodedRef: PixelFrameF32 | null,
  grading: LookParamsT["grading"],
  lookParams: LookParamsT,
  model2Strength: number,
  model2Robust: boolean
) {
  if (!isValidPixelFrameF32(decodedSource)) {
    throw new Error("Source frame is missing or has invalid dimensions.");
  }
  if (decodedRef != null && !isValidPixelFrameF32(decodedRef)) {
    throw new Error("Reference frame is missing or has invalid dimensions.");
  }

  const engine = buildEngineParamsFromLookParams(lookParams, grading);
  const pipelineParams = {
    strength: model2Strength,
    grading: engine,
    exposureMap: buildExposureMapFromFloat(decodedSource),
    matchModel: 2 as const,
    model2Strength,
    model2RobustSampling: model2Robust,
  };
  const base = buildPostModel2BaseFrame(decodedSource, decodedRef, pipelineParams);
  const preview = downscaleLinearFloatMaxEdge(base, PREVIEW_LIVE_MAX_EDGE);
  if (!isValidPixelFrameF32(preview)) {
    throw new Error("Preview frame has invalid dimensions after downscale.");
  }
  const tempState = ensureLab2LiveWorkState(null, preview.width, preview.height);
  const live = applyLivePostModel2OnlyWithState(preview, engine, tempState, {
    halationPreview: false,
  });
  return { base, preview, live, grading };
}

export function applyBulkItemLivePreview(
  frames: BulkItemFrames,
  lookParams: LookParamsT,
  finalGrading: LookParamsT["grading"],
  workState: Lab2LiveWorkState | null,
  options?: Lab2LivePreviewOptions
): { live: PixelFrameF32; previewRgba: RgbaFrame; workState: Lab2LiveWorkState } {
  const previewBase = frames.postM2PreviewBase;
  if (!isValidPixelFrameF32(previewBase)) {
    throw new Error("Preview base frame is missing or invalid.");
  }
  const engine = buildEngineParamsFromLookParams(lookParams, finalGrading);
  const nextState = ensureLab2LiveWorkState(
    workState,
    previewBase.width,
    previewBase.height
  );
  const live = applyLivePostModel2OnlyWithState(
    previewBase,
    engine,
    nextState,
    options
  );
  const previewRgba = cloneRgbaFrame(pixelFrameF32ToPixelFrameRGBA(live));
  return { live, previewRgba, workState: nextState };
}

export async function processBulkItemAuto(
  item: BulkItem,
  runId: number,
  getRunId: () => number,
  onStatus: (text: string) => void,
  lookParamsSeed: LookParamsT
): Promise<BulkItemProcessingResult> {
  const result = await processSourceFileAuto(
    item.file,
    runId,
    getRunId,
    onStatus,
    lookParamsSeed,
    item.sourceDecodeRd1,
    { tileBlend: item.uploadTileBlend }
  );
  if (!result) return { status: "Cancelled" };

  const { base, preview, live } = buildPostModel2ForItem(
    result.decodedSource,
    result.decodedRef,
    result.grading,
    result.lookParamsForRender,
    item.model2Strength,
    item.model2Robust
  );

  const matchCandidates = populateMatchCandidateSlots(result.rankedMatchesByBlend);
  const matchPreviews = await buildMatchPreviews(
    result.rankedMatchesByBlend,
    buildThumbUrlFromFloatFrame
  );
  const previewRgba = pixelFrameF32ToPixelFrameRGBA(live);
  const thumbUrl = await buildThumbUrlFromFloatFrame(live);

  const frames = buildBulkItemFrames({
    decodedSource: result.decodedSource,
    decodedRef: result.decodedRef,
    postM2Base: base,
    postM2PreviewBase: preview,
    matchCandidates,
    rankedMatchesByBlend: result.rankedMatchesByBlend,
  });

  return {
    frames,
    decodedSource: frames.decodedSource,
    decodedRef: frames.decodedRef,
    postM2Base: frames.postM2Base,
    postM2PreviewBase: frames.postM2PreviewBase,
    previewRgba: cloneRgbaFrame(previewRgba),
    lookParams: cloneLab2LookParams(result.lookParamsForRender),
    liveLookParams: cloneLab2LookParams(result.lookParamsForRender),
    finalGrading: result.grading,
    thumbUrl,
    status: result.completionStatus,
    autoMatchedRefLabel: result.autoMatchedRefLabel,
    processed: true,
    error: result.fallbackError,
    hasBaked: false,
    bakedRgba: null,
    rankedMatchesByBlend: frames.rankedMatchesByBlend,
    matchCandidates: frames.matchCandidates,
    matchPreviews,
    activeMatch: {
      tileBlend: result.primaryTileBlend,
      rank: 1,
    },
    tileBlend: result.primaryTileBlend,
    switchingMatch: false,
  };
}

export async function applyBulkItemMatch(
  item: BulkItem,
  tileBlend: Lab2TileBlend,
  rank: MatchRank,
  frames: BulkItemFrames | undefined
): Promise<BulkItemProcessingResult> {
  if (!frames) {
    return {
      switchingMatch: false,
      status: "Image data unavailable — re-open or re-upload to switch matches.",
      error: "Missing frame registry",
    };
  }

  const candidate = resolveMatchCandidateFromFrames(frames, tileBlend, rank);
  if (!candidate) {
    return {
      switchingMatch: false,
      status: "Match data unavailable for this reference.",
    };
  }
  if (!isValidPixelFrameF32(candidate.decodedRef)) {
    return {
      switchingMatch: false,
      status: "Reference frame is invalid for this match.",
      error: "Invalid reference frame",
    };
  }

  const sourceFrame = await resolveSourceFrame(item, frames);
  const refFrame = clonePixelFrameF32(candidate.decodedRef);
  const lookParams = item.liveLookParams ?? item.lookParams;

  const { base, preview, live, grading } = buildPostModel2ForItem(
    sourceFrame,
    refFrame,
    candidate.grading,
    lookParams,
    item.model2Strength,
    item.model2Robust
  );

  const previewRgba = pixelFrameF32ToPixelFrameRGBA(live);
  const thumbUrl = await buildThumbUrlFromFloatFrame(live);

  const nextFrames = mergeBulkItemFrames(frames, {
    decodedSource: sourceFrame,
    decodedRef: refFrame,
    postM2Base: base,
    postM2PreviewBase: preview,
  });

  return {
    frames: nextFrames,
    decodedSource: nextFrames.decodedSource,
    decodedRef: nextFrames.decodedRef,
    postM2Base: nextFrames.postM2Base,
    postM2PreviewBase: nextFrames.postM2PreviewBase,
    previewRgba: cloneRgbaFrame(previewRgba),
    finalGrading: grading,
    thumbUrl,
    autoMatchedRefLabel: candidate.label,
    activeMatch: { tileBlend, rank } satisfies ActiveMatchSelection,
    status: `Applied match #${rank} (${candidate.label}).`,
    switchingMatch: false,
  };
}

export async function applyBulkItemModel2Settings(
  item: BulkItem,
  frames: BulkItemFrames,
  model2Strength: number,
  model2Robust: boolean
): Promise<BulkItemProcessingResult> {
  const active = item.activeMatch;
  const candidate = resolveMatchCandidateFromFrames(
    frames,
    active.tileBlend,
    active.rank
  );
  if (!candidate) {
    throw new Error("Active match reference is unavailable.");
  }

  const sourceFrame = await resolveSourceFrame(item, frames);
  const refFrame = clonePixelFrameF32(candidate.decodedRef);
  const lookParams = item.liveLookParams ?? item.lookParams;

  const { base, preview, live, grading } = buildPostModel2ForItem(
    sourceFrame,
    refFrame,
    candidate.grading,
    lookParams,
    model2Strength,
    model2Robust
  );

  const previewRgba = pixelFrameF32ToPixelFrameRGBA(live);
  const thumbUrl = await buildThumbUrlFromFloatFrame(live);
  const nextFrames = mergeBulkItemFrames(frames, {
    decodedSource: sourceFrame,
    decodedRef: refFrame,
    postM2Base: base,
    postM2PreviewBase: preview,
  });

  return {
    frames: nextFrames,
    decodedSource: nextFrames.decodedSource,
    decodedRef: nextFrames.decodedRef,
    postM2Base: nextFrames.postM2Base,
    postM2PreviewBase: nextFrames.postM2PreviewBase,
    previewRgba: cloneRgbaFrame(previewRgba),
    finalGrading: grading,
    thumbUrl,
    model2Strength,
    model2Robust,
    status: "Model 2 settings updated.",
    switchingMatch: false,
  };
}
