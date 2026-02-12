import type { LookParamsMatch } from "@/lib/look-params";
import type {
  BucketName,
  LearnedHeuristics,
} from "@/src/lib/pipeline/heuristicsBuckets";

/**
 * Minimal context needed to apply learned heuristics to match params.
 *
 * The learn job already uses these exact bucket names; callers are
 * responsible for turning ImageStats + source type into these buckets
 * using the helpers from `heuristicsBuckets.ts`.
 */
export interface MatchContext {
  sourceExposureBucket?: BucketName; // exposure:*
  /**
   * Continuous source exposure score in [-1, 1], where:
   * -1 ≈ very underexposed, 0 ≈ normal, +1 ≈ very overexposed.
   * Used for soft weighting between exposure buckets.
   */
  sourceExposureScore?: number | null;
  sourceTypeBucket?: BucketName; // source_type:*
  refExposureBucket?: BucketName; // ref_exposure:*
  /**
   * Continuous reference exposure score in [-1, 1], same semantics as
   * sourceExposureScore. Optional; if absent we fall back to hard buckets.
   */
  refExposureScore?: number | null;
  refColorBucket?: BucketName; // ref_color:*
}

type ParamKey = string;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Clamp a numeric match parameter into a sane range after heuristics.
 *
 * This keeps learned offsets from pushing sliders into obviously bad
 * values. The ranges mirror the UI semantics in `LookParamsMatch`.
 */
function clampMatchParam(key: string, value: number): number {
  switch (key) {
    case "lumaStrength":
    case "colorStrength":
    case "exposureStrength":
      return clamp(value, 0, 2);
    case "colorDensity":
      return clamp(value, 0.1, 3);
    case "blackStrength":
      return clamp(value, 0, 8);
    case "blackRange":
      return clamp(value, 0, 1);
    case "blackPoint":
      // UI slider currently allows up to ~0.6; keep heuristics consistent.
      return clamp(value, 0, 0.6);
    case "bandLowerShadow":
    case "bandUpperShadow":
    case "bandMid":
    case "bandLowerHigh":
    case "bandUpperHigh":
      return clamp(value, 0, 3);
    case "bandLowerShadowHue":
    case "bandUpperShadowHue":
    case "bandMidHue":
    case "bandLowerHighHue":
    case "bandUpperHighHue":
      return clamp(value, -1, 1);
    case "bandLowerShadowSat":
    case "bandUpperShadowSat":
    case "bandMidSat":
    case "bandLowerHighSat":
    case "bandUpperHighSat":
      return clamp(value, 0, 2);
    case "bandLowerShadowLuma":
    case "bandUpperShadowLuma":
    case "bandMidLuma":
    case "bandLowerHighLuma":
    case "bandUpperHighLuma":
      return clamp(value, -0.5, 0.5);
    case "highlightFillStrength":
      return clamp(value, 0, 1);
    case "highlightFillWarmth":
      return clamp(value, -1, 1);
    default:
      // Unknown numeric slider – leave as-is.
      return value;
  }
}

/**
 * Simple regularisation factor for bucket means based on sample count.
 *
 * f(count) = count / (count + K)
 *
 * With K≈3:
 * - count=1  → 0.25
 * - count=3  → 0.5
 * - count=9  → 0.75
 * - count→∞ → 1
 */
function regulariseCount(count: number, k = 3): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return count / (count + k);
}

function gaussianWeight(score: number, center: number, sigma: number): number {
  const d = (score - center) / sigma;
  return Math.exp(-0.5 * d * d);
}

const SOURCE_EXPOSURE_CENTERS: Record<BucketName, number> = {
  "exposure:under": -1,
  "exposure:normal": 0,
  "exposure:over": 1,
  "exposure:unknown": 0,
  // Unused for this axis:
  "ref_exposure:under": 0,
  "ref_exposure:normal": 0,
  "ref_exposure:over": 0,
  "ref_exposure:unknown": 0,
  "ref_color:warm": 0,
  "ref_color:cool": 0,
  "ref_color:neutral": 0,
  "ref_color:foliage": 0,
  "ref_color:brick": 0,
  "ref_color:unknown": 0,
};

const REF_EXPOSURE_CENTERS: Record<BucketName, number> = {
  "ref_exposure:under": -1,
  "ref_exposure:normal": 0,
  "ref_exposure:over": 1,
  "ref_exposure:unknown": 0,
  // Unused for this axis:
  "exposure:under": 0,
  "exposure:normal": 0,
  "exposure:over": 0,
  "exposure:unknown": 0,
  "ref_color:warm": 0,
  "ref_color:cool": 0,
  "ref_color:neutral": 0,
  "ref_color:foliage": 0,
  "ref_color:brick": 0,
  "ref_color:unknown": 0,
};

const SOURCE_EXPOSURE_BUCKETS: BucketName[] = [
  "exposure:under",
  "exposure:normal",
  "exposure:over",
];

const REF_EXPOSURE_BUCKETS: BucketName[] = [
  "ref_exposure:under",
  "ref_exposure:normal",
  "ref_exposure:over",
];

/**
 * Build soft weights over exposure buckets for a given score.
 *
 * If score is null/undefined, we fall back to a hard 1-hot weighting using the
 * supplied fallback bucket (if any).
 */
function buildExposureWeights(
  score: number | null | undefined,
  centers: Record<BucketName, number>,
  buckets: BucketName[],
  fallbackBucket?: BucketName
): Array<[BucketName, number]> {
  // No continuous score → fall back to hard bucket if provided.
  if (score == null || !Number.isFinite(score)) {
    if (fallbackBucket && buckets.includes(fallbackBucket)) {
      return [[fallbackBucket, 1]];
    }
    // No sensible fallback – return uniform weights so that axis is neutral.
    const uniform = 1 / buckets.length;
    return buckets.map((b) => [b, uniform]);
  }

  const sigma = 0.7; // Fairly broad so regimes blend smoothly.
  const rawWeights: number[] = [];
  for (const bucket of buckets) {
    const center = centers[bucket];
    rawWeights.push(gaussianWeight(score, center, sigma));
  }
  let sum = rawWeights.reduce((acc, w) => acc + w, 0);

  // Extremely small sum → fall back to hard bucket, if we have one.
  if (!Number.isFinite(sum) || sum < 1e-6) {
    if (fallbackBucket && buckets.includes(fallbackBucket)) {
      return [[fallbackBucket, 1]];
    }
    const uniform = 1 / buckets.length;
    return buckets.map((b) => [b, uniform]);
  }

  return buckets.map(
    (bucket, idx): [BucketName, number] => [bucket, rawWeights[idx] / sum]
  );
}

/**
 * Apply learned heuristics to a base match parameter set.
 *
 * - Starts from `baseMatch` (analytic defaults from reference).
 * - Adds any global mean delta for each numeric key.
 * - Adds deltas for all applicable buckets in the provided context, using:
 *   - soft weights over exposure / ref_exposure buckets based on continuous
 *     exposure scores, and
 *   - count-based regularisation so single examples cannot dominate.
 * - Clamps the final value back into a sane range.
 *
 * When `heuristics` is null/undefined, this is a no-op.
 */
export function applyHeuristicsToMatch(
  baseMatch: LookParamsMatch,
  heuristics: LearnedHeuristics | null | undefined,
  ctx: MatchContext
): LookParamsMatch {
  if (!heuristics) return baseMatch;

  const result: LookParamsMatch = { ...baseMatch };

  for (const [key, baseVal] of Object.entries(baseMatch)) {
    if (typeof baseVal !== "number") continue;

    const paramHeuristics = heuristics[key];
    if (!paramHeuristics) continue;

    const global = paramHeuristics.global;
    const globalDelta =
      global?.meanDelta != null && Number.isFinite(global.meanDelta)
        ? global.meanDelta * regulariseCount(global.count)
        : 0;

    let totalDelta = globalDelta;

    const globalMeanForBuckets = global?.meanDelta ?? 0;

    // 1) Source exposure axis (soft-weighted over exposure:under/normal/over).
    if (ctx.sourceExposureBucket || ctx.sourceExposureScore != null) {
      const weights = buildExposureWeights(
        ctx.sourceExposureScore,
        SOURCE_EXPOSURE_CENTERS,
        SOURCE_EXPOSURE_BUCKETS,
        ctx.sourceExposureBucket
      );
      for (const [bucketName, weight] of weights) {
        if (weight <= 0) continue;
        const bucket = paramHeuristics.buckets[bucketName];
        if (!bucket) continue;
        const regularised =
          (bucket.meanDelta - globalMeanForBuckets) *
          regulariseCount(bucket.count);
        totalDelta += weight * regularised;
      }
    }

    // 2) Reference exposure axis (soft-weighted over ref_exposure:* buckets).
    if (ctx.refExposureBucket || ctx.refExposureScore != null) {
      const weights = buildExposureWeights(
        ctx.refExposureScore,
        REF_EXPOSURE_CENTERS,
        REF_EXPOSURE_BUCKETS,
        ctx.refExposureBucket
      );
      for (const [bucketName, weight] of weights) {
        if (weight <= 0) continue;
        const bucket = paramHeuristics.buckets[bucketName];
        if (!bucket) continue;
        const regularised =
          (bucket.meanDelta - globalMeanForBuckets) *
          regulariseCount(bucket.count);
        totalDelta += weight * regularised;
      }
    }

    // 3) Source type bucket – categorical, so hard 1-hot weighting.
    if (ctx.sourceTypeBucket) {
      const bucket = paramHeuristics.buckets[ctx.sourceTypeBucket];
      if (bucket) {
        const regularised =
          (bucket.meanDelta - globalMeanForBuckets) *
          regulariseCount(bucket.count);
        totalDelta += regularised;
      }
    }

    // 4) Reference colour bucket – still categorical for now.
    if (ctx.refColorBucket) {
      const bucket = paramHeuristics.buckets[ctx.refColorBucket];
      if (bucket) {
        const regularised =
          (bucket.meanDelta - globalMeanForBuckets) *
          regulariseCount(bucket.count);
        totalDelta += regularised;
      }
    }

    const value = baseVal + totalDelta;
    (result as Record<string, unknown>)[key] = clampMatchParam(key, value);
  }

  return result;
}

