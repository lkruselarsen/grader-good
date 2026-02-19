/**
 * POST /api/dataset/search
 * Find grading samples closest to a given embedding (cosine distance).
 * Body: { embedding?: number[], embeddingSemantic?: number[], tileEmbeddings?: Array<{tile_index, embedding}> }
 * - If tileEmbeddings is provided: tile-aggregate search (Phase 2)
 * - Else if embeddingSemantic is provided: semantic-first search (preferred)
 * - Else if embedding provided: fallback to tonal search
 * Query: ?limit=5 (default 5)
 *
 * Requires migration 00003 (tonal), 00004 (semantic), 00007 (tiles).
 */

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { EMBEDDING_DIM } from "@/src/lib/embeddings";
import { SEMANTIC_EMBEDDING_DIM } from "@/src/lib/semanticEmbeddings";

function validateEmbedding(arr: unknown, dim: number): arr is number[] {
  if (!Array.isArray(arr) || arr.length !== dim) return false;
  return arr.every((x) => typeof x === "number");
}

function validateTileEmbeddings(
  payload: unknown
): payload is Array<{ tile_index: number; embedding: number[] }> {
  if (!Array.isArray(payload) || payload.length === 0) return false;
  return payload.every(
    (t) =>
      typeof t === "object" &&
      t !== null &&
      typeof (t as { tile_index?: unknown }).tile_index === "number" &&
      validateEmbedding((t as { embedding?: unknown }).embedding, SEMANTIC_EMBEDDING_DIM)
  );
}

export async function POST(request: Request) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase not configured" },
      { status: 503 }
    );
  }

  let body: {
    embedding?: unknown;
    embeddingSemantic?: unknown;
    tileEmbeddings?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(
    20,
    Math.max(1, parseInt(limitParam ?? "5", 10) || 5)
  );

  // Tile-based search (Phase 2): when tile embeddings provided, use RPC and fetch full rows
  // Pass array directly so Postgres receives jsonb array; stringifying would send a scalar string and break jsonb_array_elements.
  if (validateTileEmbeddings(body.tileEmbeddings)) {
    const queryTiles = (
      body.tileEmbeddings as Array<{ tile_index: number; embedding: number[] }>
    ).map((t) => ({ tile_index: t.tile_index, embedding: t.embedding }));
    const { data: tileData, error: tileError } = await supabaseAdmin.rpc(
      "match_grading_samples_by_tiles",
      { query_tiles_json: queryTiles, match_limit: limit }
    );
    if (tileError) {
      return NextResponse.json(
        { error: tileError.message, hint: "Run migration 00007_grading_tiles.sql" },
        { status: 500 }
      );
    }
    const sampleIds = (tileData ?? []).map(
      (r: { sample_id?: string }) => r.sample_id as string
    ).filter(Boolean);
    if (sampleIds.length === 0) {
      return NextResponse.json({ matches: [] });
    }
    const { data: samples, error: samplesError } = await supabaseAdmin
      .from("grading_samples")
      .select("id, name, image_url, look_params, created_at, reference_exposure, reference_chroma_distribution")
      .in("id", sampleIds);
    if (samplesError) {
      return NextResponse.json(
        { error: samplesError.message },
        { status: 500 }
      );
    }
    const simById = new Map(
      (tileData ?? []).map((r: { sample_id?: string; similarity?: number }) => [
        r.sample_id,
        r.similarity,
      ])
    );
    const matches = (samples ?? []).map((s) => ({
      ...s,
      similarity: simById.get(s.id) ?? 0,
    }));
    matches.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    return NextResponse.json({ matches });
  }

  const hasSemantic = validateEmbedding(
    body.embeddingSemantic,
    SEMANTIC_EMBEDDING_DIM
  );
  const hasTonal = validateEmbedding(body.embedding, EMBEDDING_DIM);

  // Prefer semantic-first search; when both embeddings are provided, we
  // combine scores so colour/tonal distribution can break ties between
  // semantically similar candidates.
  if (hasSemantic) {
    const embeddingSemantic = body.embeddingSemantic as number[];
    const semanticLimit = hasTonal ? Math.min(20, limit * 4) : limit;

    const { data: semanticData, error: semanticError } =
      await supabaseAdmin.rpc("match_grading_samples_semantic", {
        query_embedding: embeddingSemantic,
        match_limit: semanticLimit,
      });

    if (semanticError) {
      return NextResponse.json(
        {
          error: semanticError.message,
          hint: "Run migration 00004_semantic_embeddings.sql",
        },
        { status: 500 }
      );
    }

    if (!hasTonal) {
      return NextResponse.json({ matches: semanticData ?? [] });
    }

    const tonalEmbedding = body.embedding as number[];
    const { data: tonalData, error: tonalError } =
      await supabaseAdmin.rpc("match_grading_samples", {
        query_embedding: tonalEmbedding,
        match_limit: semanticLimit,
      });

    if (tonalError) {
      return NextResponse.json(
        {
          error: tonalError.message,
          hint: "Run migration 00003_match_grading_samples.sql",
        },
        { status: 500 }
      );
    }

    // Re-rank by combined score when both semantic and tonal similarities are
    // available. Expect both RPCs to return rows with at least { id, similarity }.
    const tonalById = new Map<
      string,
      { similarity?: number; [key: string]: unknown }
    >();
    for (const row of tonalData ?? []) {
      const id = String((row as { id?: unknown }).id ?? "");
      tonalById.set(id, row as { similarity?: number });
    }

    const wSemantic = 0.7;
    const wTonal = 0.3;

    const scored = (semanticData ?? []).map((row) => {
      const id = String((row as { id?: unknown }).id ?? "");
      const semSim =
        typeof (row as { similarity?: unknown }).similarity === "number"
          ? ((row as { similarity: number }).similarity as number)
          : 0;
      const tonalRow = tonalById.get(id);
      const tonSim =
        tonalRow && typeof tonalRow.similarity === "number"
          ? (tonalRow.similarity as number)
          : 0;
      const score = wSemantic * semSim + wTonal * tonSim;
      return { ...row, _combined_score: score };
    });

    scored.sort(
      (a, b) =>
        (b as { _combined_score?: number })._combined_score! -
        (a as { _combined_score?: number })._combined_score!
    );

    return NextResponse.json({ matches: scored.slice(0, limit) });
  }

  // Fallback to tonal-only search when no semantic embedding is provided.
  if (hasTonal) {
    const embedding = body.embedding as number[];
    const { data, error } = await supabaseAdmin.rpc("match_grading_samples", {
      query_embedding: embedding,
      match_limit: limit,
    });

    if (error) {
      return NextResponse.json(
        {
          error: error.message,
          hint: "Run migration 00003_match_grading_samples.sql",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ matches: data ?? [] });
  }

  return NextResponse.json(
    {
      error: `Body must include embeddingSemantic: number[${SEMANTIC_EMBEDDING_DIM}] or embedding: number[${EMBEDDING_DIM}]`,
    },
    { status: 400 }
  );
}
