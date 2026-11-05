import { buildEngineParamsFromLookParams } from "@/lib/build-engine-params";
import { buildPostModel2BaseFrame } from "@/lib/lab2-live-preview";
import { buildExportPipelineParams } from "@/lib/lab2/export-pipeline-params";
import type { LookParams as LookParamsT } from "@/lib/look-params";
import { processFramesFloat } from "@/src/lib/pipeline/processFrames";
import { pixelFrameF32ToPixelFrameRGBA, type PixelFrameF32 } from "@/src/lib/pipeline/types";
import { decodeBufferToLinearFloat } from "@/src/lib/pipeline/decodeNode";
import { encodeCloudExport } from "@/lib/cloud/node/export-encode";
import { fetchReferenceLinearFloat } from "@/lib/cloud/node/reference";
import type { CloudRenderSettings } from "@/lib/cloud/types";
import { cloudSupabase, downloadObject } from "@/lib/cloud/server/db";
import { CLOUD_DNG_BUCKET } from "@/lib/cloud/types";

/** Full-resolution 16-bit linear decode of an uploaded DNG; never capped. */
export async function decodeCloudDng(dngPath: string): Promise<PixelFrameF32> {
  const buf = await downloadObject(CLOUD_DNG_BUCKET, dngPath);
  return decodeBufferToLinearFloat(buf);
}

export async function loadSampleReference(
  sampleId: string
): Promise<{ decodedRef: PixelFrameF32; name: string | null }> {
  const { data, error } = await cloudSupabase()
    .from("grading_samples")
    .select("id, name, image_url")
    .eq("id", sampleId)
    .single();
  if (error || !data?.image_url) {
    throw new Error(`Matched reference ${sampleId} is no longer available.`);
  }
  return {
    decodedRef: await fetchReferenceLinearFloat(data.image_url as string),
    name: (data.name as string | null) ?? null,
  };
}

/** Same chain as lab2's full export: float grade → 8-bit → grain → scale → PNG. */
export async function renderCloudExport(
  source: PixelFrameF32,
  reference: PixelFrameF32 | null,
  finalGrading: LookParamsT["grading"],
  settings: CloudRenderSettings
) {
  const params = buildExportPipelineParams({
    lookParams: settings.lookParams,
    finalGrading,
    model2Strength: settings.model2Strength,
    model2Robust: settings.model2Robust,
    exportActuance: settings.exportActuance,
    effectsEnabled: settings.effectsEnabled,
  });
  const graded = processFramesFloat(source, reference, params);
  const rgba = pixelFrameF32ToPixelFrameRGBA(graded);
  return encodeCloudExport(rgba, {
    withGrain: settings.withGrain,
    grain: settings.grain,
    scale: settings.exportScale,
  });
}

/** Model 2 base frame used by lab2's live sliders (same params as the page). */
export function buildCloudEditBase(
  source: PixelFrameF32,
  reference: PixelFrameF32 | null,
  lookParams: LookParamsT,
  finalGrading: LookParamsT["grading"],
  model2Strength: number,
  model2Robust: boolean
): PixelFrameF32 {
  const engine = buildEngineParamsFromLookParams(lookParams, finalGrading);
  return buildPostModel2BaseFrame(source, reference, {
    strength: model2Strength,
    grading: engine,
    matchModel: 2,
    model2Strength,
    model2RobustSampling: model2Robust,
  });
}
