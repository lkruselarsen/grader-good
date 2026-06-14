import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadLocalEnvIfNeeded() {
  if (
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL
  ) {
    return;
  }
  try {
    const envPath = resolve(process.cwd(), ".env.local");
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // If .env.local is missing/unreadable, keep default env behavior.
  }
}

loadLocalEnvIfNeeded();

const GRID_COLS = Number(process.env.GRID_COLS ?? 10);
const GRID_ROWS = Number(process.env.GRID_ROWS ?? 10);
const TILE_COUNT = GRID_COLS * GRID_ROWS;
const SAMPLE_BATCH = Number(process.env.SAMPLE_BATCH ?? 20);
const TILE_FETCH_LIMIT = Number(process.env.TILE_FETCH_LIMIT ?? 2000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 3);
const DRY_RUN = process.env.DRY_RUN === "1";
const MAX_SAMPLES = Number(process.env.MAX_SAMPLES ?? 0);

const supabaseUrl =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and/or SUPABASE_SERVICE_ROLE_KEY"
  );
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function srgb8ToLinear01(c8) {
  const c = c8 / 255;
  if (c <= 0.04045) return c / 12.92;
  return ((c + 0.055) / 1.055) ** 2.4;
}

function cbrtSigned(x) {
  if (x === 0) return 0;
  return x > 0 ? Math.cbrt(x) : -Math.cbrt(-x);
}

function srgb8ToOklab(r8, g8, b8) {
  const r = srgb8ToLinear01(r8);
  const g = srgb8ToLinear01(g8);
  const b = srgb8ToLinear01(b8);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l3 = cbrtSigned(l);
  const m3 = cbrtSigned(m);
  const s3 = cbrtSigned(s);

  return {
    L: 0.2104542553 * l3 + 0.793617785 * m3 - 0.0040720468 * s3,
    a: 1.9779984951 * l3 - 2.428592205 * m3 + 0.4505937099 * s3,
    b: 0.0259040371 * l3 + 0.7827717662 * m3 - 0.808675766 * s3,
  };
}

function imageTileToChromaticEmbedding(rgba, width, height, tileIndex) {
  const tileW = Math.floor(width / GRID_COLS);
  const tileH = Math.floor(height / GRID_ROWS);
  if (tileW <= 0 || tileH <= 0) {
    throw new Error(`Image too small for ${GRID_COLS}x${GRID_ROWS} tiling: ${width}x${height}`);
  }

  const col = tileIndex % GRID_COLS;
  const row = Math.floor(tileIndex / GRID_COLS);
  const x0 = col * tileW;
  const y0 = row * tileH;

  const A_BINS = 8;
  const B_BINS = 8;
  const histA = new Array(A_BINS).fill(0);
  const histB = new Array(B_BINS).fill(0);
  let count = 0;

  for (let y = 0; y < tileH; y++) {
    for (let x = 0; x < tileW; x++) {
      const px = x0 + x;
      const py = y0 + y;
      const i = (py * width + px) * 4;
      const a8 = rgba[i + 3];
      if (a8 < 128) continue;

      const { a, b } = srgb8ToOklab(rgba[i], rgba[i + 1], rgba[i + 2]);
      const a01 = clamp01((a - -0.4) / (0.4 - -0.4));
      const b01 = clamp01((b - -0.4) / (0.4 - -0.4));
      const biA = Math.min(A_BINS - 1, Math.floor(a01 * A_BINS));
      const biB = Math.min(B_BINS - 1, Math.floor(b01 * B_BINS));
      histA[biA]++;
      histB[biB]++;
      count++;
    }
  }

  if (count === 0) return new Array(16).fill(0);

  const scale = 1 / count;
  const vec = [...histA.map((v) => v * scale), ...histB.map((v) => v * scale)];
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  const mag = Math.sqrt(sumSq) || 1;
  return vec.map((v) => v / mag);
}

async function fetchImageRawRgba(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status}) for ${imageUrl}`);
  }
  const arr = await res.arrayBuffer();
  const { data, info } = await sharp(Buffer.from(arr))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { rgba: data, width: info.width, height: info.height };
}

async function fetchMissingTilesBatch() {
  const { data, error } = await supabase
    .from("grading_tiles")
    .select("sample_id,tile_index")
    .is("embedding_tonal_chroma", null)
    .order("sample_id", { ascending: true })
    .order("tile_index", { ascending: true })
    .limit(TILE_FETCH_LIMIT);
  if (error) throw error;
  return data ?? [];
}

async function fetchSampleUrls(sampleIds) {
  const { data, error } = await supabase
    .from("grading_samples")
    .select("id,image_url")
    .in("id", sampleIds);
  if (error) throw error;
  return new Map((data ?? []).map((r) => [r.id, r.image_url]));
}

async function updateSampleMissingTiles(sampleId, missingTileIndexes, sampleUrl) {
  if (!sampleUrl) {
    console.warn(`[skip] ${sampleId} missing image_url`);
    return { updated: 0, skipped: true };
  }

  const { rgba, width, height } = await fetchImageRawRgba(sampleUrl);
  const vectors = new Map();
  for (const ti of missingTileIndexes) {
    vectors.set(ti, imageTileToChromaticEmbedding(rgba, width, height, ti));
  }

  if (DRY_RUN) {
    return { updated: missingTileIndexes.length, skipped: false };
  }

  let updated = 0;
  for (const ti of missingTileIndexes) {
    const { error } = await supabase
      .from("grading_tiles")
      .update({ embedding_tonal_chroma: vectors.get(ti) })
      .eq("sample_id", sampleId)
      .eq("tile_index", ti)
      .is("embedding_tonal_chroma", null);
    if (error) throw error;
    updated++;
  }

  return { updated, skipped: false };
}

async function runWithConcurrency(items, concurrency, worker) {
  const queue = [...items];
  const runners = new Array(Math.max(1, concurrency)).fill(null).map(async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function main() {
  console.log(
    `[start] dry_run=${DRY_RUN} sample_batch=${SAMPLE_BATCH} tile_fetch_limit=${TILE_FETCH_LIMIT} concurrency=${CONCURRENCY}`
  );

  let samplesProcessed = 0;
  let tilesUpdated = 0;

  while (true) {
    const missingRows = await fetchMissingTilesBatch();
    if (missingRows.length === 0) break;

    const bySample = new Map();
    for (const row of missingRows) {
      const sid = row.sample_id;
      const ti = row.tile_index;
      if (!bySample.has(sid)) bySample.set(sid, new Set());
      bySample.get(sid).add(ti);
    }

    let sampleIds = Array.from(bySample.keys()).slice(0, SAMPLE_BATCH);
    if (MAX_SAMPLES > 0) {
      const remaining = MAX_SAMPLES - samplesProcessed;
      if (remaining <= 0) {
        console.log(`[stop] reached MAX_SAMPLES=${MAX_SAMPLES}`);
        break;
      }
      sampleIds = sampleIds.slice(0, remaining);
    }
    if (sampleIds.length === 0) break;
    const sampleUrls = await fetchSampleUrls(sampleIds);

    await runWithConcurrency(sampleIds, CONCURRENCY, async (sampleId) => {
      const missingSet = bySample.get(sampleId) ?? new Set();
      const missingTileIndexes = Array.from(missingSet).filter((x) => Number.isInteger(x));
      const sampleUrl = sampleUrls.get(sampleId) ?? null;
      try {
        const result = await updateSampleMissingTiles(sampleId, missingTileIndexes, sampleUrl);
        samplesProcessed++;
        tilesUpdated += result.updated;
        console.log(
          `[ok] sample=${sampleId} tiles=${result.updated}/${TILE_COUNT} total_tiles=${tilesUpdated} total_samples=${samplesProcessed}`
        );
      } catch (err) {
        console.error(`[err] sample=${sampleId}`, err);
      }
    });

    if (MAX_SAMPLES > 0 && samplesProcessed >= MAX_SAMPLES) {
      console.log(`[stop] reached MAX_SAMPLES=${MAX_SAMPLES}`);
      break;
    }
  }

  console.log(`[done] updated_tiles=${tilesUpdated} processed_samples=${samplesProcessed}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
