import type { LookParams as LookParamsT } from "@/lib/look-params";
import type { PixelFrameF32 } from "@/src/lib/pipeline";
import type { pixelFrameF32ToPixelFrameRGBA } from "@/src/lib/pipeline";

export type RgbaFrame = ReturnType<typeof pixelFrameF32ToPixelFrameRGBA>;

/** Tile match preset at enqueue/auto-match time — semantic-only vs hybrid weights. */
export type Lab2TileBlend = "semantic" | "halfHalf" | "tonalHeavy";

export const ALL_TILE_BLENDS: Lab2TileBlend[] = ["semantic", "tonalHeavy", "halfHalf"];

export const TILE_BLEND_SHORT_LABELS: Record<Lab2TileBlend, string> = {
  semantic: "Standard",
  tonalHeavy: "10/90",
  halfHalf: "50/50",
};

export type MatchRank = 1 | 2 | 3;

export type MatchCandidate = {
  label: string;
  thumbUrl: string;
  decodedRef: PixelFrameF32;
  grading: LookParamsT["grading"];
};

export type MatchCandidateMeta = {
  label: string;
  thumbUrl: string;
  imageUrl: string;
  grading: LookParamsT["grading"];
};

export type MatchPreview = {
  tileBlend: Lab2TileBlend;
  rank: MatchRank;
  url: string;
  label: string;
};

export type ActiveMatchSelection = {
  tileBlend: Lab2TileBlend;
  rank: MatchRank;
};

export type ProcessSourceResult = {
  decodedSource: PixelFrameF32;
  decodedRef: PixelFrameF32 | null;
  grading: LookParamsT["grading"];
  lookParamsForRender: LookParamsT;
  completionStatus: string;
  autoMatchedRefLabel: string;
  matchedReferenceThumbUrl: string | null;
  primaryTileBlend: Lab2TileBlend;
  rankedMatchesByBlend: Record<Lab2TileBlend, MatchCandidate[]>;
  fallbackError?: string;
};

/** Fired when the top primary-blend match is decoded — before alternate ranks load. */
export type PrimaryMatchReadyPayload = {
  decodedSource: PixelFrameF32;
  decodedRef: PixelFrameF32;
  grading: LookParamsT["grading"];
  lookParamsForRender: LookParamsT;
  autoMatchedRefLabel: string;
  matchedReferenceThumbUrl: string;
  primaryTileBlend: Lab2TileBlend;
};

export type BulkItem = {
  id: string;
  file: File;
  originalName: string;
  thumbUrl: string | null;
  status: string;
  error?: string;
  processed: boolean;
  autoMatchedRefLabel: string;
  tileBlend: Lab2TileBlend;
  lookParams: LookParamsT;
  liveLookParams: LookParamsT;
  finalGrading: LookParamsT["grading"];
  decodedSource: PixelFrameF32 | null;
  decodedRef: PixelFrameF32 | null;
  postM2Base: PixelFrameF32 | null;
  postM2PreviewBase: PixelFrameF32 | null;
  previewRgba: RgbaFrame | null;
  hasBaked: boolean;
  bakedRgba: RgbaFrame | null;
  rankedMatchesByBlend?: Record<Lab2TileBlend, MatchCandidate[]>;
  matchCandidates?: Record<Lab2TileBlend, (MatchCandidate | null)[]>;
  activeMatch: ActiveMatchSelection;
  matchPreviews: MatchPreview[];
  switchingMatch: boolean;
  uploadTileBlend: Lab2TileBlend;
  sourceDecodeRd1: boolean;
  model2Strength: number;
  model2Robust: boolean;
};

export type BulkQueueProgress = {
  running: boolean;
  currentIndex: number;
  total: number;
  phase: string;
  etaMinutes: number | null;
};

export function emptyMatchCandidateSlots(): Record<
  Lab2TileBlend,
  (MatchCandidate | null)[]
> {
  return {
    semantic: [null, null, null],
    tonalHeavy: [null, null, null],
    halfHalf: [null, null, null],
  };
}

export function buildTileSearchBody(
  blend: Lab2TileBlend,
  tileEmbeddings: number[][],
  chromaTiles: number[][]
) {
  const tiles = tileEmbeddings.map((embedding, idx) => ({
    tile_index: idx,
    embedding,
    embedding_tonal_chroma: chromaTiles[idx]!,
  }));
  if (blend === "semantic") {
    return {
      tileEmbeddings: tileEmbeddings.map((embedding, idx) => ({
        tile_index: idx,
        embedding,
      })),
    };
  }
  if (blend === "tonalHeavy") {
    return {
      combineTileTonal: true,
      w_semantic: 0.1,
      w_tonal: 0.9,
      tileEmbeddings: tiles,
    };
  }
  return {
    combineTileTonal: true,
    tileEmbeddings: tiles,
  };
}

/** Coarse pipeline phases used for loader animation rotation in Lab 2. */
export const LAB2_PROCESSING_PHASES = [
  "Decoding…",
  "Tile embeddings…",
  "Searching…",
  "Fetching match…",
  "Applying match…",
  "Processing…",
] as const;

export type Lab2ProcessingPhase = (typeof LAB2_PROCESSING_PHASES)[number];

export function mapStatusToPhase(status: string): Lab2ProcessingPhase {
  const s = status.toLowerCase().trim();
  if (!s) return "Processing…";
  if (
    s.includes("decoding source") ||
    s === "decoding…" ||
    s.includes("decoding reference")
  ) {
    return "Decoding…";
  }
  if (s.includes("embedding") || s.includes("chroma")) return "Tile embeddings…";
  if (s.includes("search")) return "Searching…";
  if (s.includes("fetch")) return "Fetching match…";
  if (
    s.includes("fit") ||
    s.includes("grading from") ||
    s.includes("applying") ||
    s.includes("model 2 match")
  ) {
    return "Applying match…";
  }
  // Named reference decode during auto-match (e.g. "Decoding IMG_1234…")
  if (s.includes("decod")) return "Applying match…";
  if (s.includes("match")) return "Applying match…";
  return "Processing…";
}

export function createBulkItem(
  file: File,
  idx: number,
  lookParams: LookParamsT,
  tileBlend: Lab2TileBlend,
  sourceDecodeRd1: boolean
): BulkItem {
  return {
    id: `bulk-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    originalName: file.name,
    thumbUrl: null,
    status: "queued",
    processed: false,
    autoMatchedRefLabel: "",
    tileBlend,
    lookParams: JSON.parse(JSON.stringify(lookParams)) as LookParamsT,
    liveLookParams: JSON.parse(JSON.stringify(lookParams)) as LookParamsT,
    finalGrading: lookParams.grading,
    decodedSource: null,
    decodedRef: null,
    postM2Base: null,
    postM2PreviewBase: null,
    previewRgba: null,
    hasBaked: false,
    bakedRgba: null,
    matchCandidates: emptyMatchCandidateSlots(),
    activeMatch: { tileBlend, rank: 1 },
    matchPreviews: [],
    switchingMatch: false,
    uploadTileBlend: tileBlend,
    sourceDecodeRd1,
    model2Strength: 1,
    model2Robust: true,
  };
}
