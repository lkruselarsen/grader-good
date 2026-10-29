/**
 * POST /api/cloud/items/:id/uploaded — the browser finished uploading this DNG.
 * Verifies the object landed, then queues processing for this item.
 */

import { NextResponse } from "next/server";
import { cloudSupabase, errorMessage } from "@/lib/cloud/server/db";
import { dispatchCloudTask } from "@/lib/cloud/server/dispatch";
import { jsonError, requireCloudKey } from "@/lib/cloud/server/http";
import { CLOUD_DNG_BUCKET } from "@/lib/cloud/types";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireCloudKey(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const supabase = cloudSupabase();
  const { data: item } = await supabase
    .from("cloud_items")
    .select("id, job_id, dng_path, dng_bytes, status")
    .eq("id", id)
    .maybeSingle();
  if (!item?.dng_path) return jsonError("Unknown upload.", 404);
  if (item.status !== "pending" && item.status !== "failed") {
    return NextResponse.json({ ok: true, status: item.status });
  }

  const path = item.dng_path as string;
  const slash = path.lastIndexOf("/");
  const { data: listed, error } = await supabase.storage
    .from(CLOUD_DNG_BUCKET)
    .list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 1 });
  const object = listed?.find((o) => o.name === path.slice(slash + 1));
  if (error || !object) return jsonError("Upload not found in storage yet.", 409);
  const size = Number((object.metadata as { size?: number } | null)?.size ?? 0);
  if (size <= 0) return jsonError("Uploaded file is empty.", 409);

  await supabase
    .from("cloud_items")
    .update({ status: "uploaded", dng_bytes: size, error: null, updated_at: new Date().toISOString() })
    .eq("id", id);
  try {
    await dispatchCloudTask({ kind: "process-cloud-item", itemId: id });
  } catch (e) {
    await supabase.from("cloud_items").update({ status: "failed", error: errorMessage(e) }).eq("id", id);
    return jsonError(errorMessage(e), 503);
  }
  return NextResponse.json({ ok: true, status: "uploaded" });
}
