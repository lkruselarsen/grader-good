import {
  buildEngineParamsFromLookParams,
  gateFinishingEffects,
} from "@/lib/build-engine-params";
import type { LookParams as LookParamsT } from "@/lib/look-params";

export type ExportPipelineParamsInput = {
  lookParams: LookParamsT;
  finalGrading: LookParamsT["grading"];
  model2Strength: number;
  model2Robust: boolean;
  /** Include actuance (local contrast) in the export. */
  exportActuance: boolean;
  /** Effects card toggle: include highlight warmth + halation (matches preview). */
  effectsEnabled: boolean;
};

/** Pipeline params for a full-resolution export (browser export worker and cloud worker). */
export function buildExportPipelineParams(input: ExportPipelineParamsInput) {
  const engine = gateFinishingEffects(
    buildEngineParamsFromLookParams(input.lookParams, input.finalGrading),
    input.effectsEnabled
  );
  const grading = input.exportActuance
    ? engine
    : { ...engine, actuanceStrength: 0 };
  return {
    strength: input.model2Strength,
    grading,
    matchModel: 2 as const,
    model2Strength: input.model2Strength,
    model2RobustSampling: input.model2Robust,
  };
}
