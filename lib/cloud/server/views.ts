import { cloudSupabase } from "./db";
import { deriveJobStatus } from "@/lib/cloud/worker/job-status";
import { sanitizeJobSettings } from "@/lib/cloud/settings";
import {
  CLOUD_EXPORT_BUCKET,
  type CloudJobView,
  type CloudOutputView,
} from "@/lib/cloud/types";
import type { Lab2TileBlend } from "@/lib/lab2/types";

const SIGNED_URL_TTL_S = 6 * 60 * 60;

type OutputRow = {
  id: string;
  item_id: string;
  algorithm: Lab2TileBlend;
  version: number;
  output_name: string;
  status: CloudOutputView["status"];
  error: string | null;
  width: number | null;
  height: number | null;
  sample_name: string | null;
  png_path: string | null;
  thumb_path: string | null;
};

export const OUTPUT_COLUMNS =
  "id, item_id, algorithm, version, output_name, status, error, width, height, sample_name, png_path, thumb_path";

async function signMany(paths: string[], download: boolean): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const { data } = await cloudSupabase()
    .storage.from(CLOUD_EXPORT_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL_S, download ? { download: true } : undefined);
  for (const row of data ?? []) {
    if (row.path && row.signedUrl) out.set(row.path, row.signedUrl);
  }
  return out;
}

export async function buildOutputViews(
  rows: OutputRow[],
  dngByItem: Map<string, boolean>
): Promise<CloudOutputView[]> {
  const done = rows.filter((r) => r.status === "done");
  const thumbs = done.map((r) => r.thumb_path).filter((p): p is string => !!p);
  const pngs = done.map((r) => r.png_path).filter((p): p is string => !!p);
  const [thumbUrls, pngUrls, downloadUrls] = await Promise.all([
    signMany(thumbs, false),
    signMany(pngs, false),
    signMany(pngs, true),
  ]);
  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    algorithm: r.algorithm,
    version: r.version,
    name: r.output_name,
    status: r.status,
    error: r.error,
    width: r.width,
    height: r.height,
    sampleName: r.sample_name,
    thumbUrl: r.thumb_path ? (thumbUrls.get(r.thumb_path) ?? null) : null,
    pngUrl: r.png_path ? (pngUrls.get(r.png_path) ?? null) : null,
    downloadUrl: r.png_path ? (downloadUrls.get(r.png_path) ?? null) : null,
    canEdit: r.status === "done" && (dngByItem.get(r.item_id) ?? false),
  }));
}

export async function loadJobView(slug: string): Promise<CloudJobView | null> {
  const supabase = cloudSupabase();
  const { data: job } = await supabase
    .from("cloud_jobs")
    .select("id, slug, status, settings, created_at")
    .eq("slug", slug)
    .maybeSingle();
  if (!job) return null;
  const [{ data: items }, { data: outputs }] = await Promise.all([
    supabase
      .from("cloud_items")
      .select("id, idx, original_filename, status, error, dng_path")
      .eq("job_id", job.id)
      .order("idx"),
    supabase
      .from("cloud_outputs")
      .select(OUTPUT_COLUMNS)
      .eq("job_id", job.id)
      .order("output_name"),
  ]);
  const itemRows = items ?? [];
  const outputRows = (outputs ?? []) as OutputRow[];
  const dngByItem = new Map(itemRows.map((i) => [i.id as string, !!i.dng_path]));
  const status = deriveJobStatus(
    job.created_at as string,
    itemRows as Array<{ status: string }>,
    outputRows.filter((o) => o.version === 0)
  );
  return {
    slug: job.slug as string,
    status,
    createdAt: job.created_at as string,
    settings: sanitizeJobSettings(job.settings),
    items: itemRows.map((i) => ({
      id: i.id as string,
      idx: i.idx as number,
      originalFilename: i.original_filename as string,
      status: i.status as CloudJobView["items"][number]["status"],
      error: (i.error as string | null) ?? null,
      hasDng: !!i.dng_path,
    })),
    outputs: await buildOutputViews(outputRows, dngByItem),
  };
}
