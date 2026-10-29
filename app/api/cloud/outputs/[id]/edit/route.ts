/** POST /api/cloud/outputs/:id/edit — start a cloud edit session (preview base for lab2). */

import { NextResponse } from "next/server";
import { cloudSupabase, errorMessage } from "@/lib/cloud/server/db";
import { dispatchCloudTask } from "@/lib/cloud/server/dispatch";
import { jsonError, requireCloudKey } from "@/lib/cloud/server/http";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireCloudKey(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const supabase = cloudSupabase();
  const { data: output } = await supabase
    .from("cloud_outputs")
    .select("id, item_id, status, sample_id")
    .eq("id", id)
    .maybeSingle();
  if (!output) return jsonError("Unknown photo.", 404);
  if (output.status !== "done" || !output.sample_id) {
    return jsonError("This photo has not finished processing.", 409);
  }
  const { data: item } = await supabase
    .from("cloud_items")
    .select("dng_path")
    .eq("id", output.item_id)
    .single();
  if (!item?.dng_path) return jsonError("The original DNG was cleared from storage.", 410);

  const { data: session, error } = await supabase
    .from("cloud_edit_sessions")
    .insert({ output_id: id })
    .select("id")
    .single();
  if (error || !session) return jsonError(error?.message ?? "Could not start editing", 500);
  try {
    await dispatchCloudTask({ kind: "prepare-cloud-edit", sessionId: session.id as string });
  } catch (e) {
    await supabase
      .from("cloud_edit_sessions")
      .update({ status: "failed", error: errorMessage(e) })
      .eq("id", session.id);
    return jsonError(errorMessage(e), 503);
  }
  return NextResponse.json({ sessionId: session.id });
}
