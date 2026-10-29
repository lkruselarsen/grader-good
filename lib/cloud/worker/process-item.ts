import { computeTileEmbeddingsNode } from "@/lib/cloud/node/tile-embeddings";
import { cloudSupabase, errorMessage, uploadObject } from "@/lib/cloud/server/db";
import { cloudOutputName } from "@/lib/cloud/naming";
import { sanitizeJobSettings } from "@/lib/cloud/settings";
import { CLOUD_EXPORT_BUCKET, type CloudRenderSettings } from "@/lib/cloud/types";
import { rollUpJobStatus } from "./job-status";
import { decodeCloudDng, matchReference, renderCloudExport } from "./render";

export type CloudLog = (message: string, extra?: Record<string, unknown>) => void;

const noopLog: CloudLog = () => {};

export function exportPaths(jobId: string, outputName: string) {
  return {
    png: `jobs/${jobId}/${outputName}.png`,
    thumb: `jobs/${jobId}/thumbs/${outputName}.jpg`,
  };
}

/**
 * Batch processing for one uploaded DNG: decode once at full resolution, embed,
 * then match + render + upload one export per selected algorithm. Outputs that
 * are already done are skipped, so retries only redo what failed.
 */
export async function processCloudItem(itemId: string, log: CloudLog = noopLog): Promise<void> {
  const supabase = cloudSupabase();
  const { data: item, error: itemError } = await supabase
    .from("cloud_items")
    .select("id, job_id, idx, dng_path, status")
    .eq("id", itemId)
    .single();
  if (itemError || !item) throw new Error(`Cloud item ${itemId} not found`);
  if (!item.dng_path) throw new Error(`Cloud item ${itemId} has no DNG (cleared?)`);
  const { data: job, error: jobError } = await supabase
    .from("cloud_jobs")
    .select("id, slug, settings")
    .eq("id", item.job_id)
    .single();
  if (jobError || !job) throw new Error(`Cloud job ${item.job_id} not found`);
  const settings = sanitizeJobSettings(job.settings);
  const render: CloudRenderSettings = {
    lookParams: settings.lookParams,
    effectsEnabled: settings.effectsEnabled,
    exportActuance: settings.exportActuance,
    model2Strength: settings.model2Strength,
    model2Robust: settings.model2Robust,
    withGrain: settings.withGrain,
    grain: settings.grain,
    exportScale: settings.exportScale,
  };

  const now = () => new Date().toISOString();
  await supabase.from("cloud_items").update({ status: "processing", error: null, updated_at: now() }).eq("id", itemId);
  await supabase.from("cloud_jobs").update({ status: "processing", updated_at: now() }).eq("id", job.id);

  const outputs = await Promise.all(
    settings.algorithms.map(async (algorithm) => {
      const name = cloudOutputName(job.slug as string, item.idx as number, algorithm);
      const { data: existing } = await supabase
        .from("cloud_outputs")
        .select("id, status")
        .eq("output_name", name)
        .maybeSingle();
      if (existing) return { algorithm, name, id: existing.id as string, done: existing.status === "done" };
      const { data: inserted, error } = await supabase
        .from("cloud_outputs")
        .insert({ job_id: job.id, item_id: itemId, algorithm, output_name: name, status: "pending" })
        .select("id")
        .single();
      if (error || !inserted) throw new Error(`Could not create output ${name}: ${error?.message}`);
      return { algorithm, name, id: inserted.id as string, done: false };
    })
  );
  const todo = outputs.filter((o) => !o.done);

  try {
    if (todo.length > 0) {
      const t0 = Date.now();
      const source = await decodeCloudDng(item.dng_path as string);
      log("decoded", { width: source.width, height: source.height, ms: Date.now() - t0 });
      const t1 = Date.now();
      const embeddings = await computeTileEmbeddingsNode(source);
      log("embedded", { ms: Date.now() - t1 });

      for (const out of todo) {
        const t2 = Date.now();
        await supabase.from("cloud_outputs").update({ status: "processing", error: null, updated_at: now() }).eq("id", out.id);
        try {
          const match = await matchReference(out.algorithm, embeddings);
          const result = await renderCloudExport(source, match.decodedRef, match.grading, render);
          const paths = exportPaths(job.id as string, out.name);
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
              sample_id: match.sample.id,
              sample_name: match.sample.name,
              final_grading: match.grading,
              look_params: settings.lookParams,
              render_settings: render,
              width: result.width,
              height: result.height,
              updated_at: now(),
            })
            .eq("id", out.id);
          log("rendered", { output: out.name, ms: Date.now() - t2 });
        } catch (e) {
          log("output failed", { output: out.name, error: errorMessage(e) });
          await supabase
            .from("cloud_outputs")
            .update({ status: "failed", error: errorMessage(e), updated_at: now() })
            .eq("id", out.id);
        }
      }
    }
    const { data: finalOutputs } = await supabase
      .from("cloud_outputs")
      .select("status")
      .eq("item_id", itemId)
      .eq("version", 0);
    const anyDone = (finalOutputs ?? []).some((o) => o.status === "done");
    await supabase
      .from("cloud_items")
      .update({
        status: anyDone ? "done" : "failed",
        error: anyDone ? null : "All exports failed",
        updated_at: now(),
      })
      .eq("id", itemId);
  } catch (e) {
    await supabase
      .from("cloud_items")
      .update({ status: "failed", error: errorMessage(e), updated_at: now() })
      .eq("id", itemId);
    await rollUpJobStatus(job.id as string);
    throw e;
  }
  await rollUpJobStatus(job.id as string);
}
