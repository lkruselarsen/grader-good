/**
 * POST /api/dataset/search
 * Find grading samples closest to a given embedding (cosine distance).
 * Body: { embedding?: number[], embeddingSemantic?: number[] }
 * - If embeddingSemantic is provided: semantic-first search (preferred)
 * - Else if embedding provided: fallback to tonal search
 * Query: ?limit=5 (default 5)
 *
 * Requires migration 00003 (tonal) and 00004 (semantic).
 */

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
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

  let body: { embedding?: unknown; embeddingSemantic?: unknown };
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

  // Prefer semantic-first search
  if (validateEmbedding(body.embeddingSemantic, SEMANTIC_EMBEDDING_DIM)) {
    const embeddingSemantic = body.embeddingSemantic as number[];
    const { data, error } = await supabaseAdmin.rpc(
      "match_grading_samples_semantic",
      {
        query_embedding: embeddingSemantic,
        match_limit: limit,
      }
    );

    if (error) {
      return NextResponse.json(
        {
          error: error.message,
          hint: "Run migration 00004_semantic_embeddings.sql",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ matches: data ?? [] });
  }

  // Fallback to tonal search
  if (validateEmbedding(body.embedding, EMBEDDING_DIM)) {
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
