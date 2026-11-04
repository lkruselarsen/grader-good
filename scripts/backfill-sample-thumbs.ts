/**
 * Create library thumbnails for dataset samples that have none.
 * Run: npx tsx --env-file=.env.local scripts/backfill-sample-thumbs.ts
 */

import { cloudSupabase, errorMessage } from "@/lib/cloud/server/db";
import {
  makeSampleThumb,
  sampleThumbPath,
  SAMPLES_BUCKET,
  samplesObjectPath,
} from "@/lib/dataset/sample-thumbs";

const PAGE = 200;
const CONCURRENCY = 3;

async function main() {
  const s = cloudSupabase();
  const { data, error } = await s
    .from("grading_samples")
    .select("id, image_url")
    .is("thumb_url", null)
    .limit(10000);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  console.log(`${rows.length} samples without a thumbnail`);
  let done = 0;
  let failed = 0;
  for (let start = 0; start < rows.length; start += PAGE) {
    const page = rows.slice(start, start + PAGE);
    for (let i = 0; i < page.length; i += CONCURRENCY) {
      await Promise.all(
        page.slice(i, i + CONCURRENCY).map(async (row) => {
          try {
            const path = samplesObjectPath(row.image_url as string);
            if (!path) throw new Error(`Unrecognised image_url ${row.image_url}`);
            const { data: blob, error: dlErr } = await s.storage.from(SAMPLES_BUCKET).download(path);
            if (dlErr || !blob) throw new Error(dlErr?.message ?? "download failed");
            const thumb = await makeSampleThumb(Buffer.from(await blob.arrayBuffer()));
            const thumbPath = sampleThumbPath(path);
            const { error: upErr } = await s.storage
              .from(SAMPLES_BUCKET)
              .upload(thumbPath, thumb, { contentType: "image/jpeg", upsert: true });
            if (upErr) throw new Error(upErr.message);
            const thumbUrl = s.storage.from(SAMPLES_BUCKET).getPublicUrl(thumbPath).data.publicUrl;
            const { error: updErr } = await s
              .from("grading_samples")
              .update({ thumb_url: thumbUrl })
              .eq("id", row.id);
            if (updErr) throw new Error(updErr.message);
            done++;
          } catch (e) {
            failed++;
            console.warn(`  ${row.id}: ${errorMessage(e)}`);
          }
        })
      );
    }
    console.log(`  ${done} done, ${failed} failed`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
