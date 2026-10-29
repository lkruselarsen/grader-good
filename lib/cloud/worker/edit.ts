import { gzipSync } from "node:zlib";
import type { LookParams as LookParamsT } from "@/lib/look-params";
import { downscaleLinearFloatMaxEdge, PREVIEW_LIVE_MAX_EDGE } from "@/lib/scale-linear-float-frame";
import { cloudSupabase, errorMessage, uploadObject } from "@/lib/cloud/server/db";
import { sanitizeRenderSettings } from "@/lib/cloud/settings";
import { CLOUD_EXPORT_BUCKET } from "@/lib/cloud/types";
import { rollUpJobStatus } from "./job-status";
import { exportPaths, type CloudLog } from "./process-item";
import {
  buildCloudEditBase,
  decodeCloudDng,
  loadSampleReference,
  renderCloudExport,
} from "./render";

const noopLog: CloudLog = () => {};

async function loadOutputContext(outputId: string) {
  const supabase = cloudSupabase();
  const { data: output, error } = await supabase
    .from("cloud_outputs")
    .select("id, job_id, item_id, output_name, sample_id, final_grading, look_params, render_settings")
    .eq("id", outputId)
    .single();
  if (error || !output) throw new Error(`Cloud output ${outputId} not found`);
  const { data: item } = await supabase
    .from("cloud_items")
    .select("id, dng_path")
    .eq("id", output.item_id)
    .single();
  if (!item?.dng_path) throw new Error("The original DNG has been cleared from storage.");
  if (!output.sample_id || !output.final_grading) {
    throw new Error("This export has no stored match to edit from.");
  }
  return { output, dngPath: item.dng_path as string };
}

/**
 * Cloud edit session: rebuild the Model 2 base frame from the full DNG and the
 * stored match, then publish it at lab2's live-preview size (Float32, gzip).
 * Sliders edit parameters against this view; exports always re-render from the DNG.
 */
export async function prepareCloudEdit(sessionId: string, log: CloudLog = noopLog): Promise<void> {
  const supabase = cloudSupabase();
  const now = () => new Date().toISOString();
  const { data: session } = await supabase
    .from("cloud_edit_sessions")
    .select("id, output_id")
    .eq("id", sessionId)
    .single();
  if (!session) throw new Error(`Edit session ${sessionId} not found`);
  await supabase.from("cloud_edit_sessions").update({ status: "processing", updated_at: now() }).eq("id", sessionId);
  try {
    const { output, dngPath } = await loadOutputContext(session.output_id as string);
    const settings = sanitizeRenderSettings(output.render_settings);
    const source = await decodeCloudDng(dngPath);
    const { decodedRef } = await loadSampleReference(output.sample_id as string);
    const base = buildCloudEditBase(
      source,
      decodedRef,
      output.look_params as LookParamsT,
      output.final_grading as LookParamsT["grading"],
      settings.model2Strength,
      settings.model2Robust
    );
    const preview = downscaleLinearFloatMaxEdge(base, PREVIEW_LIVE_MAX_EDGE);
    const raw = Buffer.from(preview.data.buffer, preview.data.byteOffset, preview.data.byteLength);
    const gz = gzipSync(raw, { level: 6 });
    const path = `edits/${sessionId}/base.f32.gz`;
    await uploadObject(CLOUD_EXPORT_BUCKET, path, gz, "application/octet-stream");
    await supabase
      .from("cloud_edit_sessions")
      .update({
        status: "ready",
        preview_path: path,
        preview_bytes: gz.byteLength,
        width: preview.width,
        height: preview.height,
        updated_at: now(),
      })
      .eq("id", sessionId);
    log("edit ready", { sessionId, width: preview.width, height: preview.height });
  } catch (e) {
    await supabase
      .from("cloud_edit_sessions")
      .update({ status: "failed", error: errorMessage(e), updated_at: now() })
      .eq("id", sessionId);
    throw e;
  }
}

/** Full-resolution re-render of an edited export into its own (versioned) output row. */
export async function renderCloudOutput(outputId: string, log: CloudLog = noopLog): Promise<void> {
  const supabase = cloudSupabase();
  const now = () => new Date().toISOString();
  await supabase.from("cloud_outputs").update({ status: "processing", updated_at: now() }).eq("id", outputId);
  try {
    const { output, dngPath } = await loadOutputContext(outputId);
    const settings = sanitizeRenderSettings(output.render_settings);
    const source = await decodeCloudDng(dngPath);
    const { decodedRef } = await loadSampleReference(output.sample_id as string);
    const result = await renderCloudExport(
      source,
      decodedRef,
      output.final_grading as LookParamsT["grading"],
      settings
    );
    const paths = exportPaths(output.job_id as string, output.output_name as string);
    await uploadObject(CLOUD_EXPORT_BUCKET, paths.png, result.png, "image/png");
    await uploadObject(CLOUD_EXPORT_BUCKET, paths.thumb, result.thumb, "image/jpeg");
    await supabase
      .from("cloud_outputs")
      .update({
        status: "done",
        png_path: paths.png,
        png_bytes: result.png.byteLength,
        thumb_path: paths.thumb,
        thumb_bytes: result.thumb.byteLength,
        width: result.width,
        height: result.height,
        updated_at: now(),
      })
      .eq("id", outputId);
    log("re-render done", { output: output.output_name });
    await rollUpJobStatus(output.job_id as string);
  } catch (e) {
    await supabase
      .from("cloud_outputs")
      .update({ status: "failed", error: errorMessage(e), updated_at: now() })
      .eq("id", outputId);
    throw e;
  }
}
