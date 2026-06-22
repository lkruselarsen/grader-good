import { clonePixelFrameF32 } from "@/lib/lab2-live-preview";
import type { PixelFrameF32 } from "@/src/lib/pipeline";
import { isValidPixelFrameF32 } from "./canvas-utils";
import type { Lab2TileBlend, MatchCandidate } from "./types";

export type BulkItemFrames = {
  decodedSource: PixelFrameF32;
  decodedRef: PixelFrameF32 | null;
  postM2Base: PixelFrameF32;
  postM2PreviewBase: PixelFrameF32;
  matchCandidates: Record<Lab2TileBlend, (MatchCandidate | null)[]>;
  rankedMatchesByBlend: Record<Lab2TileBlend, MatchCandidate[]>;
};

function cloneMatchCandidate(candidate: MatchCandidate): MatchCandidate {
  return {
    ...candidate,
    decodedRef: clonePixelFrameF32(candidate.decodedRef),
  };
}

function cloneMatchCandidateSlots(
  slots: Record<Lab2TileBlend, (MatchCandidate | null)[]>
): Record<Lab2TileBlend, (MatchCandidate | null)[]> {
  return {
    semantic: slots.semantic.map((c) => (c ? cloneMatchCandidate(c) : null)),
    tonalHeavy: slots.tonalHeavy.map((c) => (c ? cloneMatchCandidate(c) : null)),
    halfHalf: slots.halfHalf.map((c) => (c ? cloneMatchCandidate(c) : null)),
  };
}

function cloneRankedMatches(
  ranked: Record<Lab2TileBlend, MatchCandidate[]>
): Record<Lab2TileBlend, MatchCandidate[]> {
  return {
    semantic: (ranked.semantic ?? []).map(cloneMatchCandidate),
    tonalHeavy: (ranked.tonalHeavy ?? []).map(cloneMatchCandidate),
    halfHalf: (ranked.halfHalf ?? []).map(cloneMatchCandidate),
  };
}

export function buildBulkItemFrames(input: {
  decodedSource: PixelFrameF32;
  decodedRef: PixelFrameF32 | null;
  postM2Base: PixelFrameF32;
  postM2PreviewBase: PixelFrameF32;
  matchCandidates: Record<Lab2TileBlend, (MatchCandidate | null)[]>;
  rankedMatchesByBlend: Record<Lab2TileBlend, MatchCandidate[]>;
}): BulkItemFrames {
  if (!isValidPixelFrameF32(input.decodedSource)) {
    throw new Error("Cannot store bulk frames: invalid source.");
  }
  if (!isValidPixelFrameF32(input.postM2Base)) {
    throw new Error("Cannot store bulk frames: invalid post-M2 base.");
  }
  if (!isValidPixelFrameF32(input.postM2PreviewBase)) {
    throw new Error("Cannot store bulk frames: invalid preview base.");
  }
  return {
    decodedSource: clonePixelFrameF32(input.decodedSource),
    decodedRef: input.decodedRef ? clonePixelFrameF32(input.decodedRef) : null,
    postM2Base: clonePixelFrameF32(input.postM2Base),
    postM2PreviewBase: clonePixelFrameF32(input.postM2PreviewBase),
    matchCandidates: cloneMatchCandidateSlots(input.matchCandidates),
    rankedMatchesByBlend: cloneRankedMatches(input.rankedMatchesByBlend),
  };
}

export function mergeBulkItemFrames(
  existing: BulkItemFrames | undefined,
  patch: Partial<BulkItemFrames>
): BulkItemFrames {
  if (!existing) {
    if (
      !patch.decodedSource ||
      !patch.postM2Base ||
      !patch.postM2PreviewBase ||
      !patch.matchCandidates ||
      !patch.rankedMatchesByBlend
    ) {
      throw new Error("Cannot create bulk frames from incomplete patch.");
    }
    return buildBulkItemFrames({
      decodedSource: patch.decodedSource,
      decodedRef: patch.decodedRef ?? null,
      postM2Base: patch.postM2Base,
      postM2PreviewBase: patch.postM2PreviewBase,
      matchCandidates: patch.matchCandidates,
      rankedMatchesByBlend: patch.rankedMatchesByBlend,
    });
  }

  // Match-switch updates only touch active source/ref + post-M2 bases — keep
  // candidate slots by reference to avoid recloning every reference decode.
  const decodedSource = patch.decodedSource
    ? clonePixelFrameF32(patch.decodedSource)
    : existing.decodedSource;
  const decodedRef =
    patch.decodedRef !== undefined
      ? patch.decodedRef
        ? clonePixelFrameF32(patch.decodedRef)
        : null
      : existing.decodedRef;
  const postM2Base = patch.postM2Base
    ? clonePixelFrameF32(patch.postM2Base)
    : existing.postM2Base;
  const postM2PreviewBase = patch.postM2PreviewBase
    ? clonePixelFrameF32(patch.postM2PreviewBase)
    : existing.postM2PreviewBase;

  if (
    !isValidPixelFrameF32(decodedSource) ||
    !isValidPixelFrameF32(postM2Base) ||
    !isValidPixelFrameF32(postM2PreviewBase)
  ) {
    throw new Error("Cannot merge bulk frames: invalid dimensions.");
  }

  return {
    decodedSource,
    decodedRef,
    postM2Base,
    postM2PreviewBase,
    matchCandidates: patch.matchCandidates ?? existing.matchCandidates,
    rankedMatchesByBlend:
      patch.rankedMatchesByBlend ?? existing.rankedMatchesByBlend,
  };
}

export function resolveMatchCandidateFromFrames(
  frames: BulkItemFrames,
  tileBlend: Lab2TileBlend,
  rank: number
): MatchCandidate | null {
  const slot = frames.matchCandidates[tileBlend]?.[rank - 1];
  if (slot && isValidPixelFrameF32(slot.decodedRef)) return slot;

  const ranked = frames.rankedMatchesByBlend[tileBlend]?.[rank - 1];
  if (ranked && isValidPixelFrameF32(ranked.decodedRef)) return ranked;

  return null;
}
