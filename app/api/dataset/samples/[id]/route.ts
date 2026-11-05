/**
 * GET /api/dataset/samples/:id — tile embedding count for one reference.
 * DELETE /api/dataset/samples/:id — remove a reference from the dataset:
 * the grading_samples row (its grading_tiles embeddings cascade) plus the
 * original image and library thumbnail in storage. Requires the cloud passphrase.
 */

import { NextResponse } from "next/server";
import { cloudSupabase, errorMessage } from "@/lib/cloud/server/db";
import { jsonError, requireCloudKey } from "@/lib/cloud/server/http";
import { SAMPLES_BUCKET, samplesObjectPath } from "@/lib/dataset/sample-thumbs";

export const runtime = "nodejs";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { count, error } = await cloudSupabase()
    .from("grading_tiles")
    .select("id", { count: "exact", head: true })
    .eq("sample_id", id);
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ tileCount: count ?? 0 });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireCloudKey(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const supabase = cloudSupabase();
  const { data: sample } = await supabase
    .from("grading_samples")
    .select("id, image_url, thumb_url")
    .eq("id", id)
    .maybeSingle();
  if (!sample) return jsonError("Sample not found.", 404);

  const { error } = await supabase.from("grading_samples").delete().eq("id", id);
  if (error) return jsonError(error.message, 500);

  const paths = [samplesObjectPath(sample.image_url as string), samplesObjectPath(sample.thumb_url as string)]
    .filter((p): p is string => !!p);
  let storageError: string | null = null;
  if (paths.length > 0) {
    try {
      const { error: rmErr } = await supabase.storage.from(SAMPLES_BUCKET).remove(paths);
      if (rmErr) storageError = rmErr.message;
    } catch (e) {
      storageError = errorMessage(e);
    }
  }
  return NextResponse.json({ deleted: id, storageError });
}
