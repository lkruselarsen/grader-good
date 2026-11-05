/**
 * Parity check: Node tile embeddings vs the browser-computed vectors stored in
 * grading_tiles for the same dataset samples.
 * Run: npx tsx scripts/cloud-parity-embeddings.ts [sampleCount]
 */

import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { computeTileEmbeddingsFromImageData } from "@/lib/cloud/node/tile-embeddings";
import { installNodeCanvasGlobals } from "@/lib/cloud/node/canvas";

function parseVector(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number);
  return JSON.parse(String(v)) as number[];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

async function main() {
  installNodeCanvasGlobals();
  const count = Number(process.argv[2] ?? 3);
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: samples, error } = await supabase
    .from("grading_samples")
    .select("id, image_url")
    .not("image_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(count * 4);
  if (error) throw error;
  let checked = 0;
  for (const sample of samples ?? []) {
    if (checked >= count) break;
    const { data: tiles } = await supabase
      .from("grading_tiles")
      .select("tile_index, embedding_colclip, embedding_tonal_chroma")
      .eq("sample_id", sample.id)
      .order("tile_index");
    if (!tiles || tiles.length !== 100 || !tiles[0].embedding_tonal_chroma) continue;
    const res = await fetch(sample.image_url as string);
    const buf = Buffer.from(await res.arrayBuffer());
    const { data, info } = await sharp(buf)
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const imageData = new ImageData(
      new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength),
      info.width,
      info.height
    );
    const t0 = Date.now();
    const node = await computeTileEmbeddingsFromImageData(imageData);
    const sem = tiles.map((t, i) => cosine(parseVector(t.embedding_colclip), node.semantic[i]));
    const chr = tiles.map((t, i) =>
      cosine(parseVector(t.embedding_tonal_chroma), node.chromatic[i])
    );
    const stat = (xs: number[]) =>
      `mean ${(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(4)} min ${Math.min(...xs).toFixed(4)}`;
    console.log(
      `${sample.id} ${info.width}x${info.height} (${Date.now() - t0}ms): semantic ${stat(sem)} | chroma ${stat(chr)}`
    );
    checked++;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
