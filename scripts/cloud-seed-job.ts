/**
 * Dev helper: create a cloud batch from DNGs already in the cloud-dngs bucket
 * (copies them into a new job) without going through the browser upload.
 * Prints the slug and item ids so tasks can be triggered directly.
 * Run: npx tsx --env-file=.env.local scripts/cloud-seed-job.ts <algorithms> <count>
 */

import { cloudSupabase } from "@/lib/cloud/server/db";
import { randomCloudSlug } from "@/lib/cloud/naming";
import { sanitizeJobSettings } from "@/lib/cloud/settings";
import { CLOUD_DNG_BUCKET } from "@/lib/cloud/types";
import { DEFAULT_GRAIN_PARAMS } from "@/lib/grain/constants";
import { LAB2_DEFAULT_LOOK_PARAMS } from "@/lib/lab2/constants";

async function main() {
  const algorithms = (process.argv[2] ?? "semantic,tonalHeavy,halfHalf").split(",");
  const count = Number(process.argv[3] ?? 1);
  const s = cloudSupabase();
  const { data: sources } = await s
    .from("cloud_items")
    .select("original_filename, dng_path, dng_bytes")
    .not("dng_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(10);
  if (!sources?.length) throw new Error("No DNGs in cloud storage to copy");
  const settings = sanitizeJobSettings({
    lookParams: LAB2_DEFAULT_LOOK_PARAMS,
    effectsEnabled: true,
    withGrain: true,
    grain: DEFAULT_GRAIN_PARAMS,
    exportScale: 0.5,
    algorithms,
  });
  const { data: job, error } = await s
    .from("cloud_jobs")
    .insert({ slug: randomCloudSlug(), settings, item_count: count, status: "processing" })
    .select("id, slug")
    .single();
  if (error || !job) throw error;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const src = sources[i % sources.length]!;
    const path = `jobs/${job.id}/${String(i + 1).padStart(2, "0")}-seed.dng`;
    const { error: copyError } = await s.storage.from(CLOUD_DNG_BUCKET).copy(src.dng_path as string, path);
    if (copyError) throw copyError;
    const { data: item } = await s
      .from("cloud_items")
      .insert({
        job_id: job.id,
        idx: i + 1,
        original_filename: src.original_filename,
        dng_path: path,
        dng_bytes: src.dng_bytes,
        status: "uploaded",
      })
      .select("id")
      .single();
    ids.push(item!.id as string);
  }
  console.log(JSON.stringify({ slug: job.slug, items: ids }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
