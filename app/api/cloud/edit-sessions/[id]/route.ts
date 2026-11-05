/** GET /api/cloud/edit-sessions/:id — poll a cloud edit session; includes everything lab2 needs. */

import { NextResponse } from "next/server";
import { cloudSupabase } from "@/lib/cloud/server/db";
import { jsonError, requireCloudKey } from "@/lib/cloud/server/http";
import { sanitizeRenderSettings } from "@/lib/cloud/settings";
import { CLOUD_EXPORT_BUCKET } from "@/lib/cloud/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireCloudKey(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const supabase = cloudSupabase();
  const { data: session } = await supabase
    .from("cloud_edit_sessions")
    .select("id, output_id, status, error, preview_path, width, height")
    .eq("id", id)
    .maybeSingle();
  if (!session) return jsonError("Unknown edit session.", 404);
  const { data: output } = await supabase
    .from("cloud_outputs")
    .select("id, job_id, item_id, algorithm, output_name, look_params, final_grading, render_settings, sample_name")
    .eq("id", session.output_id)
    .single();
  if (!output) return jsonError("The photo for this session no longer exists.", 404);
  const { data: job } = await supabase
    .from("cloud_jobs")
    .select("slug")
    .eq("id", output.job_id)
    .single();

  let previewUrl: string | null = null;
  if (session.status === "ready" && session.preview_path) {
    const { data } = await supabase.storage
      .from(CLOUD_EXPORT_BUCKET)
      .createSignedUrl(session.preview_path as string, 60 * 60);
    previewUrl = data?.signedUrl ?? null;
  }
  return NextResponse.json(
    {
      id: session.id,
      status: session.status,
      error: session.error,
      previewUrl,
      width: session.width,
      height: session.height,
      output: {
        id: output.id,
        name: output.output_name,
        algorithm: output.algorithm,
        sampleName: output.sample_name,
        lookParams: output.look_params,
        finalGrading: output.final_grading,
        renderSettings: sanitizeRenderSettings(output.render_settings),
        slug: job?.slug ?? null,
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
