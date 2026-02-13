import type {
  ExposureLevel,
  ChromaDistribution,
} from "@/src/lib/pipeline/imageStats";

/**
 * Shared bucket and heuristics types for correction learning.
 *
 * This module is used both by the offline learn job
 * (`app/api/corrections/learn/route.ts`) and by the runtime
 * heuristics adapter inside the matching pipeline.
 */

export type BucketName =
  | "global"
  | "exposure:under"
  | "exposure:normal"
  | "exposure:over"
  | "exposure:unknown"
  | "ref_exposure:under"
  | "ref_exposure:normal"
  | "ref_exposure:over"
  | "ref_exposure:unknown"
  | "ref_color:warm"
  | "ref_color:cool"
  | "ref_color:neutral"
  | "ref_color:foliage"
  | "ref_color:brick"
  | "ref_color:unknown"
  | `source_type:${string}`;

export interface LearnedHeuristicsBucket {
  meanDelta: number;
  count: number;
}

export type LearnedHeuristics = Record<
  string,
  {
    global?: LearnedHeuristicsBucket;
    buckets: Partial<Record<BucketName, LearnedHeuristicsBucket>>;
  }
>;

/**
 * Map an exposure level (median L) to a coarse bucket for the SOURCE image.
 */
export function bucketForSourceExposure(
  exposure: ExposureLevel | null
): BucketName {
  const medianL = exposure?.medianL;
  if (typeof medianL !== "number" || !Number.isFinite(medianL)) {
    return "exposure:unknown";
  }
  if (medianL < 0.35) return "exposure:under";
  if (medianL > 0.65) return "exposure:over";
  return "exposure:normal";
}

/**
 * Map an exposure level (median L) to a coarse bucket for the REFERENCE image.
 */
export function bucketForRefExposure(
  exposure: ExposureLevel | null
): BucketName {
  const medianL = exposure?.medianL;
  if (typeof medianL !== "number" || !Number.isFinite(medianL)) {
    return "ref_exposure:unknown";
  }
  if (medianL < 0.35) return "ref_exposure:under";
  if (medianL > 0.65) return "ref_exposure:over";
  return "ref_exposure:normal";
}

/**
 * Coarse reference colour/chroma classification.
 *
 * Uses global mean a/b/C from the OKLab chroma distribution to decide whether
 * the reference is warm/cool/neutral and to spot foliage- or brick-heavy
 * scenes. These buckets are intentionally simple – they are only used as
 * coarse context for heuristics.
 */
export function bucketForRefColor(
  chroma: ChromaDistribution | null
): BucketName {
  if (!chroma) return "ref_color:unknown";

  const { meanA, meanB, meanC } = chroma;
  if (
    !Number.isFinite(meanA) ||
    !Number.isFinite(meanB) ||
    !Number.isFinite(meanC)
  ) {
    return "ref_color:unknown";
  }

  const c = Math.abs(meanC);
  const a = meanA;
  const b = meanB;

  const lowChroma = c < 0.02;
  if (lowChroma) {
    return "ref_color:neutral";
  }

  const isFoliage = a < -0.02 && b > 0.01;
  if (isFoliage) {
    return "ref_color:foliage";
  }

  const isBrick = a > 0.02 && b > 0.01;
  if (isBrick) {
    return "ref_color:brick";
  }

  if (b > 0.01) {
    return "ref_color:warm";
  }
  if (b < -0.01) {
    return "ref_color:cool";
  }

  return "ref_color:neutral";
}

