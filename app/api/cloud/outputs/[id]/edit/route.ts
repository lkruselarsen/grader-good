/**
 * POST /api/cloud/outputs/:id/edit — start a cloud edit session (preview base for lab2).
 * When the batch already cached this export's base the session is ready at once;
 * the cloud task only runs to build whatever reference choices are still missing.
 */

import { NextResponse } from "next/server";
import { cloudSupabase, errorMessage } from "@/lib/cloud/server/db";
import { dispatchCloudTask } from "@/lib/cloud/server/dispatch";
import { jsonError, requireCloudKey } from "@/lib/cloud/server/http";
import { sanitizeRenderSettings } from "@/lib/cloud/settings";
import { ALL_TILE_BLENDS, type Lab2TileBlend } from "@/lib/lab2/types";

export const runtime = "nodejs";

type CandidateLists = Partial<Record<Lab2TileBlend, Array<{ sampleId: string }>>>;

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireCloudKey(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const supabase = cloudSupabase();
  const { data: output } = await supabase
    .from("cloud_outputs")
    .select("id, item_id, status, sample_id, render_settings")
    .eq("id", id)
    .maybeSingle();
  if (!output) return jsonError("Unknown photo.", 404);
  if (output.status !== "done" || !output.sample_id) {
    return jsonError("This photo has not finished processing.", 409);
  }
  const { data: item } = await supabase
    .from("cloud_items")
    .select("dng_path, match_candidates")
    .eq("id", output.item_id)
    .single();
  if (!item?.dng_path) return jsonError("The original DNG was cleared from storage.", 410);

  let settings;
  try {
    settings = sanitizeRenderSettings(output.render_settings);
  } catch (e) {
    return jsonError(errorMessage(e), 409);
  }
  const { data: bases } = await supabase
    .from("cloud_edit_bases")
    .select("sample_id, status, preview_path, preview_bytes, width, height, channels")
    .eq("item_id", output.item_id)
    .eq("model2_strength", settings.model2Strength)
    .eq("model2_robust", settings.model2Robust);
  const ready = new Map(
    (bases ?? []).filter((b) => b.status === "ready" && b.preview_path).map((b) => [b.sample_id as string, b])
  );
  const primary = ready.get(output.sample_id as string);
  const lists = item.match_candidates as CandidateLists | null;
  const wanted = lists
    ? new Set(ALL_TILE_BLENDS.flatMap((a) => (lists[a] ?? []).map((c) => c.sampleId)))
    : null;
  const allReady = !!primary && !!wanted && [...wanted].every((s) => ready.has(s));

  const { data: session, error } = await supabase
    .from("cloud_edit_sessions")
    .insert(
      primary
        ? {
            output_id: id,
            status: "ready",
            preview_path: primary.preview_path,
            preview_bytes: primary.preview_bytes,
            width: primary.width,
            height: primary.height,
            channels: primary.channels,
            warm_status: allReady ? "done" : "pending",
          }
        : { output_id: id, warm_status: "pending" }
    )
    .select("id")
    .single();
  if (error || !session) return jsonError(error?.message ?? "Could not start editing", 500);
  if (allReady) return NextResponse.json({ sessionId: session.id });
  try {
    await dispatchCloudTask({ kind: "prepare-cloud-edit", sessionId: session.id as string });
  } catch (e) {
    await supabase
      .from("cloud_edit_sessions")
      .update(primary ? { warm_status: "failed" } : { status: "failed", error: errorMessage(e) })
      .eq("id", session.id);
    if (!primary) return jsonError(errorMessage(e), 503);
  }
  return NextResponse.json({ sessionId: session.id });
}
