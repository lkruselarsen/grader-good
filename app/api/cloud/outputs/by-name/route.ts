/** GET /api/cloud/outputs/by-name?name=GG-XXXXX-07-5050 — find an export by its file name. */

import { NextResponse } from "next/server";
import { cloudSupabase } from "@/lib/cloud/server/db";
import { jsonError, requireCloudKey } from "@/lib/cloud/server/http";
import { normalizeCloudOutputName } from "@/lib/cloud/naming";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireCloudKey(request);
  if (denied) return denied;
  const raw = new URL(request.url).searchParams.get("name") ?? "";
  const name = normalizeCloudOutputName(raw);
  if (!name) return jsonError("Enter a file name.", 400);
  const supabase = cloudSupabase();
  const { data: output } = await supabase
    .from("cloud_outputs")
    .select("id, job_id, output_name, status")
    .eq("output_name", name)
    .maybeSingle();
  if (!output) return jsonError(`No photo named ${name}.`, 404);
  const { data: job } = await supabase
    .from("cloud_jobs")
    .select("slug")
    .eq("id", output.job_id)
    .single();
  return NextResponse.json({
    outputId: output.id,
    name: output.output_name,
    status: output.status,
    slug: job?.slug ?? null,
  });
}
