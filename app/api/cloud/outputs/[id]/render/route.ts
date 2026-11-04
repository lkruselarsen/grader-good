/**
 * POST /api/cloud/outputs/:id/render — re-render an export from the full DNG
 * with edited settings. Body: CloudRenderSettings & { sampleId? }. A sampleId
 * switches the reference to another of the item's matched choices; the new
 * version lands in that reference's algorithm folder. Creates a new version row.
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
  let sampleId: string | null = null;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    settings = sanitizeRenderSettings(body);
    if (typeof body?.sampleId === "string" && body.sampleId) sampleId = body.sampleId;
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
  let reference = {
    algorithm: source.algorithm as string,
    sampleId: source.sample_id as string,
    sampleName: source.sample_name as string | null,
    finalGrading: source.final_grading as unknown,
  };
  if (sampleId && sampleId !== source.sample_id) {
    const { data: base } = await supabase
      .from("cloud_edit_bases")
      .select("algorithm, sample_id, sample_name, final_grading")
      .eq("item_id", source.item_id)
      .eq("sample_id", sampleId)
      .not("final_grading", "is", null)
      .limit(1)
      .maybeSingle();
    if (!base) return jsonError("That reference is not one of this photo's matches.", 400);
    reference = {
      algorithm: base.algorithm as string,
      sampleId: base.sample_id as string,
      sampleName: (base.sample_name as string | null) ?? null,
      finalGrading: base.final_grading,
    };
  }
  const rootId = (source.parent_output_id as string | null) ?? (source.id as string);
  const [{ data: item }, { data: job }, { data: versions }] = await Promise.all([
    supabase.from("cloud_items").select("idx, dng_path").eq("id", source.item_id).single(),
    supabase.from("cloud_jobs").select("slug").eq("id", source.job_id).single(),
    supabase
      .from("cloud_outputs")
      .select("version")
      .eq("item_id", source.item_id)
      .eq("algorithm", reference.algorithm)
      .order("version", { ascending: false })
      .limit(1),
  ]);
  if (!item?.dng_path) return jsonError("The original DNG was cleared from storage.", 410);
  const version = ((versions?.[0]?.version as number | undefined) ?? 0) + 1;
  const name = cloudOutputName(
    job?.slug as string,
    item.idx as number,
    reference.algorithm as typeof source.algorithm,
    version
  );
  const { data: created, error } = await supabase
    .from("cloud_outputs")
    .insert({
      job_id: source.job_id,
      item_id: source.item_id,
      parent_output_id: rootId,
      algorithm: reference.algorithm,
      version,
      output_name: name,
      status: "pending",
      sample_id: reference.sampleId,
      sample_name: reference.sampleName,
      final_grading: reference.finalGrading,
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
