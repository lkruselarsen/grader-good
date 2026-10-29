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
import {
  isTileSearchBody,
  searchTiles,
  TileSearchError,
} from "@/lib/dataset/search-tiles";
import { EMBEDDING_DIM } from "@/src/lib/embeddings";
import { SEMANTIC_EMBEDDING_DIM } from "@/src/lib/semanticEmbeddings";

function validateEmbedding(arr: unknown, dim: number): arr is number[] {
  if (!Array.isArray(arr) || arr.length !== dim) return false;
  return arr.every((x) => typeof x === "number");
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

  if (isTileSearchBody(body)) {
    try {
      const matches = await searchTiles(supabaseAdmin, body, limit);
      return NextResponse.json({ matches });
    } catch (e) {
      if (e instanceof TileSearchError) {
        return NextResponse.json(
          e.hint ? { error: e.message, hint: e.hint } : { error: e.message },
          { status: e.status }
        );
      }
      throw e;
    }
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
