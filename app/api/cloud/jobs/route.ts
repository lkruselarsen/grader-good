/**
 * POST /api/cloud/jobs — create a cloud batch.
 * Body: { settings: CloudJobSettings, files: [{ name, size }] }
 * Returns the download URL plus one signed upload URL per DNG.
 */

import { NextResponse } from "next/server";
import { cloudSupabase, errorMessage } from "@/lib/cloud/server/db";
import { cloudRunnerConfigured } from "@/lib/cloud/server/dispatch";
import { jsonError, publicOrigin, requireCloudKey } from "@/lib/cloud/server/http";
import { randomCloudSlug } from "@/lib/cloud/naming";
import { sanitizeJobSettings } from "@/lib/cloud/settings";
import { CLOUD_DNG_BUCKET, CLOUD_MAX_FILES } from "@/lib/cloud/types";

export const runtime = "nodejs";

const MAX_DNG_BYTES = 200 * 1024 * 1024;

function safeFilePart(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .slice(0, 60) || "photo"
  );
}

export async function POST(request: Request) {
  const denied = requireCloudKey(request);
  if (denied) return denied;
  if (!cloudRunnerConfigured()) {
    return jsonError("Cloud processing is not configured on the server (TRIGGER_SECRET_KEY).", 503);
  }

  let body: { settings?: unknown; files?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }
  let settings;
  try {
    settings = sanitizeJobSettings(body.settings);
  } catch (e) {
    return jsonError(errorMessage(e), 400);
  }
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0) return jsonError("Pick at least one DNG.", 400);
  if (files.length > CLOUD_MAX_FILES) return jsonError(`At most ${CLOUD_MAX_FILES} files per batch.`, 400);
  const parsed: Array<{ name: string; size: number }> = [];
  for (const f of files) {
    const name = typeof f?.name === "string" ? f.name : "";
    const size = typeof f?.size === "number" ? f.size : 0;
    if (!/\.dng$/i.test(name)) return jsonError(`${name || "A file"} is not a DNG.`, 400);
    if (size <= 0 || size > MAX_DNG_BYTES) {
      return jsonError(`${name} is ${(size / 1e6).toFixed(0)} MB; the limit is 200 MB.`, 400);
    }
    parsed.push({ name, size });
  }

  const supabase = cloudSupabase();
  let job: { id: string; slug: string } | null = null;
  for (let attempt = 0; attempt < 5 && !job; attempt++) {
    const { data, error } = await supabase
      .from("cloud_jobs")
      .insert({ slug: randomCloudSlug(), settings, item_count: parsed.length })
      .select("id, slug")
      .single();
    if (data) job = data as { id: string; slug: string };
    else if (error && error.code !== "23505") return jsonError(error.message, 500);
  }
  if (!job) return jsonError("Could not allocate a batch id.", 500);

  const rows = parsed.map((f, i) => ({
    job_id: job.id,
    idx: i + 1,
    original_filename: f.name,
    dng_path: `jobs/${job.id}/${String(i + 1).padStart(2, "0")}-${safeFilePart(f.name)}.dng`,
    dng_bytes: f.size,
  }));
  const { data: items, error: itemsError } = await supabase
    .from("cloud_items")
    .insert(rows)
    .select("id, idx, original_filename, dng_path");
  if (itemsError || !items) return jsonError(itemsError?.message ?? "Could not create items", 500);

  const uploads = await Promise.all(
    items.map(async (item) => {
      const { data, error } = await supabase.storage
        .from(CLOUD_DNG_BUCKET)
        .createSignedUploadUrl(item.dng_path as string, { upsert: true });
      if (error || !data) throw new Error(error?.message ?? "Could not sign upload");
      return {
        id: item.id as string,
        idx: item.idx as number,
        name: item.original_filename as string,
        signedUrl: data.signedUrl,
      };
    })
  ).catch((e: unknown) => e as Error);
  if (uploads instanceof Error) return jsonError(uploads.message, 500);

  const url = `${publicOrigin(request)}/c/${job.slug}`;
  return NextResponse.json({ slug: job.slug, url, uploads: uploads.sort((a, b) => a.idx - b.idx) });
}
