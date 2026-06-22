import type { LookParams as LookParamsT } from "@/lib/look-params";
import { engineToGrading } from "@/lib/look-params";
import { yieldToMain } from "@/lib/yield-to-main";
import { decodeToLinearFloat } from "@/src/lib/pipeline/decode";
import { decodeRd1ToLinearFloat } from "@/src/lib/pipeline/decodeRd1";
import type { PixelFrameF32 } from "@/src/lib/pipeline";
import {
  computeSourceTileEmbeddingsInWorker,
  fitLookParamsInWorker,
} from "./auto-match-worker-client";
import { cloneLab2LookParams, LAB2_AUTO_DENSITY_ENABLED } from "./constants";
import {
  ALL_TILE_BLENDS,
  buildTileSearchBody,
  TILE_BLEND_SHORT_LABELS,
  type Lab2TileBlend,
  type MatchCandidate,
  type PrimaryMatchReadyPayload,
  type ProcessSourceResult,
} from "./types";

export async function decodeSourceFile(
  file: File,
  sourceDecodeRd1: boolean
): Promise<PixelFrameF32> {
  if (sourceDecodeRd1) {
    return decodeRd1ToLinearFloat(file);
  }
  return decodeToLinearFloat(file);
}

export async function processSourceFileAuto(
  sourceFile: File,
  runId: number,
  currentRunId: () => number,
  onStatus: (text: string) => void,
  lookParamsSeed: LookParamsT,
  sourceDecodeRd1: boolean,
  opts?: {
    tileBlend?: Lab2TileBlend;
    onPrimaryReady?: (payload: PrimaryMatchReadyPayload) => void | Promise<void>;
  }
): Promise<ProcessSourceResult | null> {
  const primaryBlend = opts?.tileBlend ?? "semantic";
  const isStale = () => runId !== currentRunId();
  let decodedSource: PixelFrameF32 | null = null;
  try {
    onStatus("Decoding source RAW…");
    decodedSource = await decodeSourceFile(sourceFile, sourceDecodeRd1);
    if (isStale()) return null;
    await yieldToMain();

    onStatus("Computing 10x10 tile embeddings…");
    const { semantic: tileEmbeddings, chromatic: chromaTiles } =
      await computeSourceTileEmbeddingsInWorker(decodedSource, (phase, current, total) => {
        if (isStale()) return;
        if (phase === "semantic") {
          onStatus(`Computing 10x10 tile embeddings… ${current}/${total}`);
        } else {
          onStatus(`Computing chroma histograms… ${current}/${total}`);
        }
      });
    if (isStale()) return null;

    onStatus("Searching dataset matches (all algorithms)…");
    const searchResults = await Promise.all(
      ALL_TILE_BLENDS.map(async (blend) => {
        const searchRes = await fetch("/api/dataset/search?limit=3", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            buildTileSearchBody(blend, tileEmbeddings, chromaTiles)
          ),
        });
        const searchData = (await searchRes.json()) as {
          error?: string;
          matches?: Array<{ image_url?: unknown; name?: unknown }>;
        };
        if (!searchRes.ok) {
          throw new Error(
            searchData.error ??
              `Dataset search failed for ${TILE_BLEND_SHORT_LABELS[blend]}.`
          );
        }
        return { blend, matches: searchData.matches ?? [] };
      })
    );
    if (isStale()) return null;

    const primaryMatches =
      searchResults.find((r) => r.blend === primaryBlend)?.matches ?? [];
    if (primaryMatches.length === 0) {
      throw new Error(
        `No dataset matches found for ${TILE_BLEND_SHORT_LABELS[primaryBlend]}.`
      );
    }

    const decodeCache = new Map<string, MatchCandidate>();
    const fetchDecodeMatch = async (
      match: { image_url?: unknown; name?: unknown },
      statusLabel: string
    ): Promise<MatchCandidate | null> => {
      const imageUrl = typeof match.image_url === "string" ? match.image_url : "";
      if (!imageUrl) return null;
      const cached = decodeCache.get(imageUrl);
      if (cached) return cached;

      onStatus(statusLabel);
      const refRes = await fetch(imageUrl);
      if (!refRes.ok) {
        throw new Error(`Failed to fetch matched reference (${refRes.status}).`);
      }
      const refBlob = await refRes.blob();
      if (isStale()) return null;
      const refLabel =
        typeof match.name === "string" && match.name.trim().length > 0
          ? match.name.trim()
          : "dataset match";
      const extFromType = refBlob.type?.split("/")[1] ?? "png";
      const matchedRefFile = new File(
        [refBlob],
        `lab2-auto-reference.${extFromType}`,
        { type: refBlob.type || "image/png" }
      );
      onStatus(`Decoding ${refLabel}…`);
      const decodedRef = await decodeToLinearFloat(matchedRefFile);
      if (isStale()) return null;
      await yieldToMain();
      onStatus(`Fitting look from ${refLabel}…`);
      const engineParams = await fitLookParamsInWorker(decodedRef);
      const grading = engineToGrading(engineParams);
      await yieldToMain();
      const candidate: MatchCandidate = {
        label: refLabel,
        thumbUrl: imageUrl,
        decodedRef,
        grading,
      };
      decodeCache.set(imageUrl, candidate);
      return candidate;
    };

    const rankedMatchesByBlend = {
      semantic: [] as MatchCandidate[],
      tonalHeavy: [] as MatchCandidate[],
      halfHalf: [] as MatchCandidate[],
    };

    const orderedBlends: Lab2TileBlend[] = [
      primaryBlend,
      ...ALL_TILE_BLENDS.filter((blend) => blend !== primaryBlend),
    ];

    const rankLabels = ["2nd", "3rd"] as const;
    let primaryReadyFired = false;

    for (const blend of orderedBlends) {
      const matches =
        searchResults.find((result) => result.blend === blend)?.matches ?? [];
      const startIndex =
        blend === primaryBlend && rankedMatchesByBlend[primaryBlend].length > 0
          ? 1
          : 0;

      for (let i = startIndex; i < Math.min(matches.length, 3); i += 1) {
        try {
          const statusLabel =
            i === 0
              ? `Fetching top ${TILE_BLEND_SHORT_LABELS[blend]} match…`
              : `Fetching ${TILE_BLEND_SHORT_LABELS[blend]} ${rankLabels[i - 1] ?? "alt"} match…`;
          const candidate = await fetchDecodeMatch(matches[i]!, statusLabel);
          if (!candidate) continue;
          rankedMatchesByBlend[blend].push(candidate);

          if (
            !primaryReadyFired &&
            blend === primaryBlend &&
            i === 0 &&
            decodedSource &&
            opts?.onPrimaryReady
          ) {
            primaryReadyFired = true;
            await opts.onPrimaryReady({
              decodedSource,
              decodedRef: candidate.decodedRef,
              grading: candidate.grading,
              lookParamsForRender: cloneLab2LookParams(lookParamsSeed),
              autoMatchedRefLabel: candidate.label,
              matchedReferenceThumbUrl: candidate.thumbUrl,
              primaryTileBlend: primaryBlend,
            });
          }
        } catch {
          /* skip failed alternate ranks */
        }
        await yieldToMain();
      }
    }

    const primary = rankedMatchesByBlend[primaryBlend][0];
    if (!primary) {
      throw new Error(
        `Top ${TILE_BLEND_SHORT_LABELS[primaryBlend]} match could not be decoded.`
      );
    }
    if (isStale()) return null;
    onStatus("Fitting grading from matched reference…");
    if (LAB2_AUTO_DENSITY_ENABLED) {
      // Feature-flagged off by default for now; keep block ready for re-enable.
    }
    return {
      decodedSource,
      decodedRef: primary.decodedRef,
      grading: primary.grading,
      lookParamsForRender: cloneLab2LookParams(lookParamsSeed),
      completionStatus: `Auto match complete (${TILE_BLEND_SHORT_LABELS[primaryBlend]}: ${primary.label}). Post–Model 2 preview is live.`,
      autoMatchedRefLabel: primary.label,
      matchedReferenceThumbUrl: primary.thumbUrl,
      primaryTileBlend: primaryBlend,
      rankedMatchesByBlend,
    };
  } catch (e) {
    if (isStale()) return null;
    const message = e instanceof Error ? e.message : String(e);
    if (!decodedSource) {
      throw e;
    }
    return {
      decodedSource,
      decodedRef: null,
      grading: lookParamsSeed.grading,
      lookParamsForRender: cloneLab2LookParams(lookParamsSeed),
      completionStatus: `Auto embedding match failed: ${message}. Showing source-only preview; use Match / refresh base to retry.`,
      autoMatchedRefLabel: "",
      matchedReferenceThumbUrl: null,
      primaryTileBlend: primaryBlend,
      rankedMatchesByBlend: {
        semantic: [],
        tonalHeavy: [],
        halfHalf: [],
      },
      fallbackError: message,
    };
  }
}

export async function buildMatchPreviews(
  rankedByBlend: Record<Lab2TileBlend, MatchCandidate[]>,
  buildThumb: (frame: PixelFrameF32) => Promise<string>
): Promise<import("./types").MatchPreview[]> {
  const previews: import("./types").MatchPreview[] = [];
  for (const blend of ALL_TILE_BLENDS) {
    const candidates = rankedByBlend[blend] ?? [];
    for (let idx = 0; idx < candidates.length && idx < 3; idx += 1) {
      const candidate = candidates[idx]!;
      previews.push({
        tileBlend: blend,
        rank: (idx + 1) as 1 | 2 | 3,
        url:
          candidate.thumbUrl || (await buildThumb(candidate.decodedRef)),
        label: candidate.label,
      });
    }
  }
  return previews;
}

function cloneMatchCandidateSlot(candidate: MatchCandidate): MatchCandidate {
  return {
    ...candidate,
    decodedRef: {
      width: candidate.decodedRef.width,
      height: candidate.decodedRef.height,
      data: new Float32Array(candidate.decodedRef.data),
    },
  };
}

export function populateMatchCandidateSlots(
  rankedByBlend: Record<Lab2TileBlend, MatchCandidate[]>
): Record<Lab2TileBlend, (MatchCandidate | null)[]> {
  const slots = {
    semantic: [null, null, null] as (MatchCandidate | null)[],
    tonalHeavy: [null, null, null] as (MatchCandidate | null)[],
    halfHalf: [null, null, null] as (MatchCandidate | null)[],
  };
  for (const blend of ALL_TILE_BLENDS) {
    const candidates = rankedByBlend[blend] ?? [];
    candidates.slice(0, 3).forEach((candidate, idx) => {
      slots[blend][idx] = cloneMatchCandidateSlot(candidate);
    });
  }
  return slots;
}
