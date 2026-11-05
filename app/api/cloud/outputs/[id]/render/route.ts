/**
 * POST /api/cloud/outputs/:id/render — re-render an export from the full DNG
 * with edited settings. Body: CloudRenderSettings. Creates a new version row.
 */

import { NextResponse } from "next/server";
import { cloudSupabase, errorMessage } from "@/lib/cloud/server/db";
import { dispatchCloudTask } from "@/lib/cloud/server/dispatch";
import { jsonError, requireCloudKey } from "@/lib/cloud/server/http";
import { cloudOutputName } from "@/lib/cloud/naming";
import { sanitizeRenderSettings } from "@/lib/cloud/settings";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireCloudKey(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  let settings;
  try {
    settings = sanitizeRenderSettings(await request.json());
  } catch (e) {
    return jsonError(errorMessage(e), 400);
  }
  const supabase = cloudSupabase();
  const { data: source } = await supabase
    .from("cloud_outputs")
    .select("id, job_id, item_id, algorithm, status, sample_id, sample_name, final_grading, parent_output_id")
    .eq("id", id)
    .maybeSingle();
  if (!source) return jsonError("Unknown photo.", 404);
  if (!source.sample_id || !source.final_grading) {
    return jsonError("This photo has no stored match to render from.", 409);
  }
  const rootId = (source.parent_output_id as string | null) ?? (source.id as string);
  const [{ data: item }, { data: job }, { data: versions }] = await Promise.all([
    supabase.from("cloud_items").select("idx, dng_path").eq("id", source.item_id).single(),
    supabase.from("cloud_jobs").select("slug").eq("id", source.job_id).single(),
    supabase
      .from("cloud_outputs")
      .select("version")
      .eq("item_id", source.item_id)
      .eq("algorithm", source.algorithm)
      .order("version", { ascending: false })
      .limit(1),
  ]);
  if (!item?.dng_path) return jsonError("The original DNG was cleared from storage.", 410);
  const version = ((versions?.[0]?.version as number | undefined) ?? 0) + 1;
  const name = cloudOutputName(job?.slug as string, item.idx as number, source.algorithm, version);
  const { data: created, error } = await supabase
    .from("cloud_outputs")
    .insert({
      job_id: source.job_id,
      item_id: source.item_id,
      parent_output_id: rootId,
      algorithm: source.algorithm,
      version,
      output_name: name,
      status: "pending",
      sample_id: source.sample_id,
      sample_name: source.sample_name,
      final_grading: source.final_grading,
      look_params: settings.lookParams,
      render_settings: settings,
    })
    .select("id, output_name")
    .single();
  if (error || !created) return jsonError(error?.message ?? "Could not queue the render", 500);
  try {
    await dispatchCloudTask({ kind: "render-cloud-output", outputId: created.id as string });
  } catch (e) {
    await supabase.from("cloud_outputs").update({ status: "failed", error: errorMessage(e) }).eq("id", created.id);
    return jsonError(errorMessage(e), 503);
  }
  return NextResponse.json({ outputId: created.id, name: created.output_name });
}
