import type { SupabaseClient } from "@supabase/supabase-js";
import { EMBEDDING_CHROMA_DIM } from "@/src/lib/embeddings";
import { SEMANTIC_EMBEDDING_DIM } from "@/src/lib/semanticEmbeddings";

export class TileSearchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string
  ) {
    super(message);
  }
}

export type TileSearchMatch = {
  id: string;
  name: string | null;
  image_url: string | null;
  look_params: unknown;
  created_at: string;
  reference_exposure: unknown;
  reference_chroma_distribution: unknown;
  similarity: number;
};

type TileRow = { tile_index: number; embedding: number[] };
type HybridTileRow = TileRow & { embedding_tonal_chroma: number[] };

const SAMPLE_COLUMNS =
  "id, name, image_url, look_params, created_at, reference_exposure, reference_chroma_distribution";

function validateEmbedding(arr: unknown, dim: number): arr is number[] {
  if (!Array.isArray(arr) || arr.length !== dim) return false;
  return arr.every((x) => typeof x === "number");
}

export function validateTileEmbeddings(payload: unknown): payload is TileRow[] {
  if (!Array.isArray(payload) || payload.length === 0) return false;
  return payload.every(
    (t) =>
      typeof t === "object" &&
      t !== null &&
      typeof (t as { tile_index?: unknown }).tile_index === "number" &&
      validateEmbedding((t as { embedding?: unknown }).embedding, SEMANTIC_EMBEDDING_DIM)
  );
}

function validateHybridChromaTileEmbeddings(payload: unknown): payload is HybridTileRow[] {
  if (!Array.isArray(payload) || payload.length === 0) return false;
  return payload.every(
    (t) =>
      typeof t === "object" &&
      t !== null &&
      typeof (t as { tile_index?: unknown }).tile_index === "number" &&
      validateEmbedding((t as { embedding?: unknown }).embedding, SEMANTIC_EMBEDDING_DIM) &&
      validateEmbedding(
        (t as { embedding_tonal_chroma?: unknown }).embedding_tonal_chroma,
        EMBEDDING_CHROMA_DIM
      )
  );
}

const HYBRID_TILE_WEIGHT_PRESETS: Array<{ w_semantic: number; w_tonal: number }> = [
  { w_semantic: 0.5, w_tonal: 0.5 },
  { w_semantic: 0.1, w_tonal: 0.9 },
];

function resolveHybridTileWeights(
  wSemRaw: unknown,
  wTonRaw: unknown
): { w_semantic: number; w_tonal: number } {
  const semMissing = wSemRaw === undefined;
  const tonMissing = wTonRaw === undefined;
  if (semMissing && tonMissing) {
    return { w_semantic: 0.5, w_tonal: 0.5 };
  }
  if (semMissing || tonMissing) {
    throw new TileSearchError(
      "combineTileTonal requires both w_semantic and w_tonal, or omit both for 50/50",
      400
    );
  }
  if (typeof wSemRaw !== "number" || typeof wTonRaw !== "number") {
    throw new TileSearchError("w_semantic and w_tonal must be numbers", 400);
  }
  if (!Number.isFinite(wSemRaw) || !Number.isFinite(wTonRaw) || wSemRaw < 0 || wTonRaw < 0) {
    throw new TileSearchError("w_semantic and w_tonal must be finite and non-negative", 400);
  }
  if (Math.abs(wSemRaw + wTonRaw - 1) >= 1e-6) {
    throw new TileSearchError("w_semantic + w_tonal must equal 1", 400);
  }
  const match = HYBRID_TILE_WEIGHT_PRESETS.some(
    (p) =>
      Math.abs(p.w_semantic - wSemRaw) < 1e-9 && Math.abs(p.w_tonal - wTonRaw) < 1e-9
  );
  if (!match) {
    throw new TileSearchError("w_semantic/w_tonal must be one of: 0.5/0.5 or 0.1/0.9", 400);
  }
  return { w_semantic: wSemRaw, w_tonal: wTonRaw };
}

async function loadRankedSamples(
  supabase: SupabaseClient,
  tileData: Array<{ sample_id?: string; similarity?: number }> | null
): Promise<TileSearchMatch[]> {
  const sampleIds = (tileData ?? []).map((r) => r.sample_id as string).filter(Boolean);
  if (sampleIds.length === 0) return [];
  const { data: samples, error } = await supabase
    .from("grading_samples")
    .select(SAMPLE_COLUMNS)
    .in("id", sampleIds);
  if (error) throw new TileSearchError(error.message, 500);
  const simById = new Map((tileData ?? []).map((r) => [r.sample_id, r.similarity]));
  const matches = (samples ?? []).map((s) => ({
    ...(s as Omit<TileSearchMatch, "similarity">),
    similarity: simById.get((s as { id: string }).id) ?? 0,
  }));
  matches.sort((a, b) => Number(b.similarity ?? 0) - Number(a.similarity ?? 0));
  return matches;
}

/**
 * Whether a search body is a tile search (semantic tiles or hybrid tile + chroma).
 * Bodies that are not are left to the legacy global-embedding search.
 */
export function isTileSearchBody(body: {
  tileEmbeddings?: unknown;
  combineTileTonal?: unknown;
}): boolean {
  return body.combineTileTonal === true || validateTileEmbeddings(body.tileEmbeddings);
}

/** Tile search shared by POST /api/dataset/search and the cloud worker. Throws TileSearchError. */
export async function searchTiles(
  supabase: SupabaseClient,
  body: {
    tileEmbeddings?: unknown;
    combineTileTonal?: unknown;
    w_semantic?: unknown;
    w_tonal?: unknown;
  },
  limit: number
): Promise<TileSearchMatch[]> {
  if (body.combineTileTonal === true) {
    const hybridWeights = resolveHybridTileWeights(body.w_semantic, body.w_tonal);
    if (!validateHybridChromaTileEmbeddings(body.tileEmbeddings)) {
      throw new TileSearchError(
        `combineTileTonal requires tileEmbeddings: each item needs embedding: number[${SEMANTIC_EMBEDDING_DIM}] and embedding_tonal_chroma: number[${EMBEDDING_CHROMA_DIM}]`,
        400
      );
    }
    const queryTiles = body.tileEmbeddings.map((t) => ({
      tile_index: t.tile_index,
      embedding: t.embedding,
      embedding_tonal_chroma: t.embedding_tonal_chroma,
    }));
    const { data: tileData, error: tileError } = await supabase.rpc(
      "match_grading_samples_by_tiles_hybrid",
      // Keys alphabetical — PostgREST often binds RPC args positionally in this order.
      {
        match_limit: limit,
        query_tiles_json: queryTiles,
        use_chroma_tonal: true,
        w_semantic: hybridWeights.w_semantic,
        w_tonal: hybridWeights.w_tonal,
      }
    );
    if (tileError) {
      throw new TileSearchError(
        tileError.message,
        500,
        "Apply migrations through 00019_hybrid_rpc_param_order_postgrest.sql (and 00018 if chroma column missing)"
      );
    }
    return loadRankedSamples(supabase, tileData);
  }

  if (!validateTileEmbeddings(body.tileEmbeddings)) {
    throw new TileSearchError(
      `tileEmbeddings must be an array of { tile_index, embedding: number[${SEMANTIC_EMBEDDING_DIM}] }`,
      400
    );
  }
  // Pass array directly so Postgres receives jsonb array; stringifying would send a scalar string and break jsonb_array_elements.
  const queryTiles = body.tileEmbeddings.map((t) => ({
    tile_index: t.tile_index,
    embedding: t.embedding,
  }));
  const { data: tileData, error: tileError } = await supabase.rpc(
    "match_grading_samples_by_tiles",
    { query_tiles_json: queryTiles, match_limit: limit }
  );
  if (tileError) {
    throw new TileSearchError(tileError.message, 500, "Run migration 00007_grading_tiles.sql");
  }
  return loadRankedSamples(supabase, tileData);
}
