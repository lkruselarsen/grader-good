import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { ExposureLevel, ChromaDistribution } from "@/src/lib/pipeline/imageStats";
import type { LookParams, LookParamsMatch } from "@/lib/look-params";
import type {
  BucketName,
  LearnedHeuristics,
  LearnedHeuristicsBucket,
} from "@/src/lib/pipeline/heuristicsBuckets";
import {
  bucketForSourceExposure,
  bucketForRefExposure,
  bucketForRefColor,
} from "@/src/lib/pipeline/heuristicsBuckets";

interface ParamDeltaAgg {
  sum: number;
  count: number;
}

type ParamStats = Record<string, Record<BucketName, ParamDeltaAgg>>;

interface CorrectionRow {
  auto_params: LookParams;
  corrected_params: LookParams;
  source_exposure: ExposureLevel | null;
  reference_exposure: ExposureLevel | null;
  reference_chroma_distribution: ChromaDistribution | null;
  source_type: string | null;
}

const MIN_BUCKET_COUNT = 1;
const MIN_ABS_DELTA = 0.001;

function addDelta(
  stats: ParamStats,
  param: string,
  bucket: BucketName,
  delta: number
) {
  if (!Number.isFinite(delta) || delta === 0) return;
  const byBucket = (stats[param] ??= {} as Record<BucketName, ParamDeltaAgg>);
  const agg = (byBucket[bucket] ??= { sum: 0, count: 0 });
  agg.sum += delta;
  agg.count += 1;
}

function meanFromAgg(agg: ParamDeltaAgg): number {
  return agg.count > 0 ? agg.sum / agg.count : 0;
}

function buildHeuristicsFromStats(paramStats: ParamStats): LearnedHeuristics {
  const heuristics: LearnedHeuristics = {};

  for (const [param, buckets] of Object.entries(paramStats)) {
    const keptBuckets: Partial<Record<BucketName, LearnedHeuristicsBucket>> = {};

    for (const [bucketName, agg] of Object.entries(buckets) as [
      BucketName,
      ParamDeltaAgg
    ][]) {
      if (agg.count < MIN_BUCKET_COUNT) continue;
      const meanDelta = meanFromAgg(agg);
      if (!Number.isFinite(meanDelta) || Math.abs(meanDelta) < MIN_ABS_DELTA) {
        continue;
      }
      keptBuckets[bucketName] = {
        meanDelta,
        count: agg.count,
      };
    }

    if (Object.keys(keptBuckets).length === 0) continue;

    const global = keptBuckets["global"];
    heuristics[param] = {
      ...(global && { global }),
      buckets: keptBuckets,
    };
  }

  return heuristics;
}

/**
 * Learn simple parameter deltas from stored grading corrections.
 *
 * This endpoint:
 * - Reads all rows from grading_corrections (auto_params, corrected_params,
 *   source_exposure, reference_exposure, reference_chroma_distribution, source_type)
 * - Computes mean (corrected - auto) per numeric match parameter
 * - Buckets those deltas by:
 *   - source_type
 *   - coarse source exposure bucket (under/normal/over)
 *   - coarse reference exposure bucket
 *   - coarse reference colour/chroma bucket (warm/cool/neutral/foliage/brick)
 *
 * It does NOT mutate any existing data; it only returns a JSON summary, so you
 * can inspect it or wire it into heuristics used by fitLookParamsFromReference.
 *
 * The response contains:
 * - `learned`: raw per-bucket stats (for debugging)
 * - `heuristics`: a compact snapshot with only meaningful buckets retained,
 *    including a `global` bucket per parameter when present. This is where
 *    universal corrections like \"always bump colorStrength by ~+0.5\" live.
 */
export async function GET() {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase not configured on server" },
      { status: 503 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from("grading_corrections")
    .select(
      "auto_params, corrected_params, source_exposure, reference_exposure, reference_chroma_distribution, source_type"
    )
    .returns<CorrectionRow[]>();

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  const rows = data ?? [];
  const paramStats: ParamStats = {};

  for (const row of rows) {
    const autoMatch: LookParamsMatch | undefined = row.auto_params?.match;
    const correctedMatch: LookParamsMatch | undefined =
      row.corrected_params?.match;

    if (!autoMatch || !correctedMatch) continue;

    const expBucket = bucketForSourceExposure(row.source_exposure);
    const refExpBucket = bucketForRefExposure(row.reference_exposure);
    const refColorBucketName = bucketForRefColor(row.reference_chroma_distribution);
    const sourceTypeBucket: BucketName | null = row.source_type
      ? (`source_type:${row.source_type}` as BucketName)
      : null;

    for (const [key, autoVal] of Object.entries(autoMatch)) {
      const correctedVal = (correctedMatch as Record<string, unknown>)[key];
      if (
        typeof autoVal !== "number" ||
        typeof correctedVal !== "number" ||
        !Number.isFinite(autoVal) ||
        !Number.isFinite(correctedVal)
      ) {
        continue;
      }

      const delta = correctedVal - autoVal;
      if (!Number.isFinite(delta) || delta === 0) continue;

      addDelta(paramStats, key, "global", delta);
      addDelta(paramStats, key, expBucket, delta);
      addDelta(paramStats, key, refExpBucket, delta);
      addDelta(paramStats, key, refColorBucketName, delta);
      if (sourceTypeBucket) {
        addDelta(paramStats, key, sourceTypeBucket, delta);
      }
    }
  }

  const summary: Record<
    string,
    {
      buckets: Record<
        BucketName,
        { meanDelta: number; count: number }
      >;
    }
  > = {};

  for (const [param, buckets] of Object.entries(paramStats)) {
    const bucketSummary: Record<
      BucketName,
      { meanDelta: number; count: number }
    > = {};
    for (const [bucketName, agg] of Object.entries(buckets) as [
      BucketName,
      ParamDeltaAgg
    ][]) {
      bucketSummary[bucketName] = {
        meanDelta: meanFromAgg(agg),
        count: agg.count,
      };
    }
    summary[param] = { buckets: bucketSummary };
  }

  const heuristics = buildHeuristicsFromStats(paramStats);

  return NextResponse.json({
    totalCorrections: rows.length,
    thresholds: {
      minBucketCount: MIN_BUCKET_COUNT,
      minAbsDelta: MIN_ABS_DELTA,
    },
    learned: summary,
    heuristics,
  });
}

