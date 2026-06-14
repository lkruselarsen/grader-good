/**
 * POST /api/dataset/search
 * Find grading samples closest to a given embedding (cosine distance).
 * Body: { embedding?, embeddingSemantic?, tileEmbeddings?, combineTileTonal?: boolean, w_semantic?, w_tonal? }
 * - If combineTileTonal is true: hybrid RPC using chroma-only per-tile tonal vectors.
 *   Both 50/50 (default) and 10/90 use embedding_tonal_chroma (16-D a/b only, no lightness L).
 *   Omit both w_semantic/w_tonal for 50/50; pass both for 0.1/0.9; one without the other is 400.
 * - Else if tileEmbeddings is provided: semantic-only tile-aggregate search (Phase 2)
 * - Else if embeddingSemantic is provided: semantic-first search (preferred)
 * - Else if embedding provided: fallback to tonal search
 * Query: ?limit=5 (default 5)
 *
 * Requires migration 00003 (tonal), 00004 (semantic), 00007 (tiles), 00016–00018 (hybrid + chroma column).
 */

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { EMBEDDING_CHROMA_DIM, EMBEDDING_DIM } from "@/src/lib/embeddings";
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

function validateHybridChromaTileEmbeddings(
  payload: unknown
): payload is Array<{
  tile_index: number;
  embedding: number[];
  embedding_tonal_chroma: number[];
}> {
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
):
  | { ok: true; w_semantic: number; w_tonal: number }
  | { ok: false; message: string } {
  const semMissing = wSemRaw === undefined;
  const tonMissing = wTonRaw === undefined;
  if (semMissing && tonMissing) {
    return { ok: true, w_semantic: 0.5, w_tonal: 0.5 };
  }
  if (semMissing || tonMissing) {
    return {
      ok: false,
      message:
        "combineTileTonal requires both w_semantic and w_tonal, or omit both for 50/50",
    };
  }
  if (typeof wSemRaw !== "number" || typeof wTonRaw !== "number") {
    return { ok: false, message: "w_semantic and w_tonal must be numbers" };
  }
  if (
    !Number.isFinite(wSemRaw) ||
    !Number.isFinite(wTonRaw) ||
    wSemRaw < 0 ||
    wTonRaw < 0
  ) {
    return {
      ok: false,
      message:
        "w_semantic and w_tonal must be finite and non-negative",
    };
  }
  if (Math.abs(wSemRaw + wTonRaw - 1) >= 1e-6) {
    return {
      ok: false,
      message: "w_semantic + w_tonal must equal 1",
    };
  }
  const match = HYBRID_TILE_WEIGHT_PRESETS.some(
    (p) =>
      Math.abs(p.w_semantic - wSemRaw) < 1e-9 &&
      Math.abs(p.w_tonal - wTonRaw) < 1e-9
  );
  if (!match) {
    return {
      ok: false,
      message:
        "w_semantic/w_tonal must be one of: 0.5/0.5 or 0.1/0.9",
    };
  }
  return { ok: true, w_semantic: wSemRaw, w_tonal: wTonRaw };
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
    combineTileTonal?: unknown;
    w_semantic?: unknown;
    w_tonal?: unknown;
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

  const combineTileTonal = body.combineTileTonal === true;

  // Hybrid tile search: weighted semantic + per-tile chroma tonal (16-D a/b only), default 50/50.
  if (combineTileTonal) {
    const hybridWeights = resolveHybridTileWeights(body.w_semantic, body.w_tonal);
    if (!hybridWeights.ok) {
      return NextResponse.json({ error: hybridWeights.message }, { status: 400 });
    }
    if (!validateHybridChromaTileEmbeddings(body.tileEmbeddings)) {
      return NextResponse.json(
        {
          error: `combineTileTonal requires tileEmbeddings: each item needs embedding: number[${SEMANTIC_EMBEDDING_DIM}] and embedding_tonal_chroma: number[${EMBEDDING_CHROMA_DIM}]`,
        },
        { status: 400 }
      );
    }

    const queryTiles = (
      body.tileEmbeddings as Array<{
        tile_index: number;
        embedding: number[];
        embedding_tonal_chroma: number[];
      }>
    ).map((t) => ({
      tile_index: t.tile_index,
      embedding: t.embedding,
      embedding_tonal_chroma: t.embedding_tonal_chroma,
    }));

    const { data: tileData, error: tileError } = await supabaseAdmin.rpc(
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
      return NextResponse.json(
        {
          error: tileError.message,
          hint: "Apply migrations through 00019_hybrid_rpc_param_order_postgrest.sql (and 00018 if chroma column missing)",
        },
        { status: 500 }
      );
    }
    const sampleIdsHybrid = (tileData ?? [])
      .map((r: { sample_id?: string }) => r.sample_id as string)
      .filter(Boolean);
    if (sampleIdsHybrid.length === 0) {
      return NextResponse.json({ matches: [] });
    }
    const { data: samplesHybrid, error: samplesErrorHybrid } =
      await supabaseAdmin
        .from("grading_samples")
        .select(
          "id, name, image_url, look_params, created_at, reference_exposure, reference_chroma_distribution"
        )
        .in("id", sampleIdsHybrid);
    if (samplesErrorHybrid) {
      return NextResponse.json(
        { error: samplesErrorHybrid.message },
        { status: 500 }
      );
    }
    const simByIdHybrid = new Map(
      (tileData ?? []).map((r: { sample_id?: string; similarity?: number }) => [
        r.sample_id,
        r.similarity,
      ])
    );
    const matchesHybrid = (samplesHybrid ?? []).map((s) => ({
      ...s,
      similarity: simByIdHybrid.get(s.id) ?? 0,
    }));
    matchesHybrid.sort(
      (a, b) => Number(b.similarity ?? 0) - Number(a.similarity ?? 0)
    );
    return NextResponse.json({ matches: matchesHybrid });
  }

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
    matches.sort(
      (a, b) => Number(b.similarity ?? 0) - Number(a.similarity ?? 0)
    );
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

    const scored = (semanticData ?? []).map((row: unknown) => {
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
      const base =
        typeof row === "object" && row !== null
          ? (row as Record<string, unknown>)
          : {};
      return { ...base, _combined_score: score };
    });

    scored.sort(
      (a: Record<string, unknown>, b: Record<string, unknown>) =>
        Number(b._combined_score ?? 0) - Number(a._combined_score ?? 0)
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
