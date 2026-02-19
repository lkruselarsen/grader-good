/**
 * Learned predictor: (context, baseline match params) → adjusted match params.
 * Phase 4: Currently uses heuristics adapter (Option A). Can be replaced with
 * a small NN (Option B) or tile-aware predictor (Option C) trained on
 * grading_corrections data.
 *
 * At apply time: run this with source/ref stats (and optionally tile embeddings)
 * to get final match params before processOne.
 */

import type { LookParamsMatch } from "@/lib/look-params";
import type { LearnedHeuristics } from "@/src/lib/pipeline/heuristicsBuckets";
import type { MatchContext } from "@/src/lib/pipeline/heuristicsAdapter";
import { applyHeuristicsToMatch } from "@/src/lib/pipeline/heuristicsAdapter";

/**
 * Predict match parameter adjustments from baseline and learned heuristics.
 * Uses context (source exposure/type, ref exposure/color) to apply global and
 * bucketed deltas. Returns a new LookParamsMatch (clamped to valid ranges).
 *
 * When tile embeddings are available (Phase 2), a future version could
 * use (source tiles, ref tiles, stats) as input to a small NN and return
 * deltas or full params.
 */
export function predictMatchParams(
  baselineMatch: LookParamsMatch,
  heuristics: LearnedHeuristics | null,
  context: MatchContext
): LookParamsMatch {
  return applyHeuristicsToMatch(baselineMatch, heuristics, context);
}
