/**
 * GET    /api/cloud/storage — used bytes (DNGs vs exports) against the quota.
 * DELETE /api/cloud/storage?scope=dngs|exports|all — remove stored files.
 */

import { NextResponse } from "next/server";
import { cloudSupabase } from "@/lib/cloud/server/db";
import { jsonError, requireCloudKey } from "@/lib/cloud/server/http";
import {
  CLOUD_DNG_BUCKET,
  CLOUD_EXPORT_BUCKET,
  type CloudStorageUsage,
} from "@/lib/cloud/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = 1000;
const REMOVE_CHUNK = 500;

async function selectAll<T>(
  table: string,
  columns: string,
  notNullColumn: string
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await cloudSupabase()
      .from(table)
      .select(columns)
      .not(notNullColumn, "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

async function usage(): Promise<CloudStorageUsage> {
  const [items, outputs, sessions] = await Promise.all([
    selectAll<{ dng_bytes: number }>("cloud_items", "dng_bytes", "dng_path"),
    selectAll<{ png_bytes: number; thumb_bytes: number }>("cloud_outputs", "png_bytes, thumb_bytes", "png_path"),
    selectAll<{ preview_bytes: number }>("cloud_edit_sessions", "preview_bytes", "preview_path"),
  ]);
  const dngBytes = items.reduce((s, r) => s + Number(r.dng_bytes ?? 0), 0);
  const exportBytes =
    outputs.reduce((s, r) => s + Number(r.png_bytes ?? 0) + Number(r.thumb_bytes ?? 0), 0) +
    sessions.reduce((s, r) => s + Number(r.preview_bytes ?? 0), 0);
  const quotaGb = Number(process.env.CLOUD_STORAGE_QUOTA_GB ?? 100) || 100;
  return { dngBytes, exportBytes, usedBytes: dngBytes + exportBytes, quotaBytes: quotaGb * 1024 ** 3 };
}

async function removePaths(bucket: string, paths: string[]) {
  for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
    const { error } = await cloudSupabase().storage.from(bucket).remove(paths.slice(i, i + REMOVE_CHUNK));
    if (error) throw new Error(error.message);
  }
}

async function clearDngs() {
  const items = await selectAll<{ id: string; dng_path: string }>("cloud_items", "id, dng_path", "dng_path");
  await removePaths(CLOUD_DNG_BUCKET, items.map((i) => i.dng_path));
  if (items.length) {
    await cloudSupabase()
      .from("cloud_items")
      .update({ dng_path: null, dng_bytes: 0 })
      .not("dng_path", "is", null);
  }
  return items.length;
}

async function clearExports() {
  const [outputs, sessions] = await Promise.all([
    selectAll<{ png_path: string; thumb_path: string | null }>("cloud_outputs", "png_path, thumb_path", "png_path"),
    selectAll<{ preview_path: string }>("cloud_edit_sessions", "preview_path", "preview_path"),
  ]);
  await removePaths(CLOUD_EXPORT_BUCKET, [
    ...outputs.flatMap((o) => [o.png_path, o.thumb_path].filter((p): p is string => !!p)),
    ...sessions.map((s) => s.preview_path),
  ]);
  const supabase = cloudSupabase();
  await supabase
    .from("cloud_outputs")
    .update({ png_path: null, png_bytes: 0, thumb_path: null, thumb_bytes: 0 })
    .not("png_path", "is", null);
  await supabase
    .from("cloud_edit_sessions")
    .update({ preview_path: null, preview_bytes: 0 })
    .not("preview_path", "is", null);
  return outputs.length;
}

export async function GET(request: Request) {
  const denied = requireCloudKey(request);
  if (denied) return denied;
  return NextResponse.json(await usage(), { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request) {
  const denied = requireCloudKey(request);
  if (denied) return denied;
  const scope = new URL(request.url).searchParams.get("scope");
  if (scope !== "dngs" && scope !== "exports" && scope !== "all") {
    return jsonError("scope must be dngs, exports or all", 400);
  }
  const removed = { dngs: 0, exports: 0 };
  if (scope === "dngs" || scope === "all") removed.dngs = await clearDngs();
  if (scope === "exports" || scope === "all") removed.exports = await clearExports();
  return NextResponse.json({ removed, usage: await usage() });
}
