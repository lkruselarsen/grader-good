import type { LookParams as LookParamsT } from "@/lib/look-params";
import { halationFromLook, highlightWarmthFromLook } from "@/lib/look-params";
import type { FinishParams } from "@/src/lib/pipeline/finishing/model";
import type { GradingParams } from "@/src/lib/pipeline/types";

/** Finishing params for the preview presenter; null when the effects card is off. */
export function finishParamsFromLook(
  lookParams: LookParamsT,
  effectsEnabled: boolean
): FinishParams | null {
  if (!effectsEnabled) return null;
  const m = lookParams.match;
  return {
    highlightWarmth: highlightWarmthFromLook(m),
    halation: halationFromLook(m),
  };
}

/**
 * Stable key of everything the CPU worker renders (finishing fields removed).
 * Equal keys mean only finishing params changed, so the GPU pass alone is
 * enough.
 */
export function coreEngineKey(engine: GradingParams, renderScale: number): string {
  const core: Partial<GradingParams> = { ...engine };
  delete core.highlightWarmth;
  delete core.halation;
  return `${renderScale}|${JSON.stringify(core)}`;
}
