import type { LookParams as LookParamsT } from "@/lib/look-params";
import { DEFAULT_LOOK_PARAMS } from "@/lib/look-params";
import type { FinishParams } from "@/src/lib/pipeline/finishing/model";
import type { GradingParams } from "@/src/lib/pipeline/types";

/** Finishing params for the preview presenter; null when the effects card is off. */
export function finishParamsFromLook(
  lookParams: LookParamsT,
  effectsEnabled: boolean
): FinishParams | null {
  if (!effectsEnabled) return null;
  const m = lookParams.match;
  const d = DEFAULT_LOOK_PARAMS.match;
  return {
    highlightWarmth: {
      hue: m.highlightWarmthHue ?? d.highlightWarmthHue ?? 35,
      amount: m.highlightWarmthAmount ?? d.highlightWarmthAmount ?? 0,
      threshold: m.highlightWarmthThreshold ?? d.highlightWarmthThreshold ?? 0.25,
    },
    halation: {
      edge: m.halationEdge ?? d.halationEdge ?? 0.5,
      strength: m.halationStrength ?? d.halationStrength ?? 0,
    },
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
