/**
 * POST /api/dataset/upload
 * Add a grading sample to the embeddings database.
 * Body: FormData with:
 *   - file: image (JPG/PNG)
 *   - lookParams: JSON string (engine LookParams from fitLookParamsFromReference)
 *   - embedding: JSON string (number[] from imageToEmbedding)
 *   - name?: optional label
 */

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { LookParams } from "@/src/lib/pipeline/stages/match";
import { EMBEDDING_DIM } from "@/src/lib/embeddings";
import { SEMANTIC_EMBEDDING_DIM } from "@/src/lib/semanticEmbeddings";

const BUCKET = "grading-samples";

function validateLookParams(obj: unknown): obj is LookParams {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (!o.tone || typeof (o.tone as Record<string, unknown>).lift !== "number") return false;
  if (!o.saturation || typeof (o.saturation as Record<string, unknown>).shadowRolloff !== "number") return false;
  if (typeof o.warmth !== "number") return false;
  return true;
}

function validateEmbedding(arr: unknown): arr is number[] {
  if (!Array.isArray(arr) || arr.length !== EMBEDDING_DIM) return false;
  return arr.every((x) => typeof x === "number");
}

function validateSemanticEmbedding(arr: unknown): arr is number[] {
  if (!Array.isArray(arr) || arr.length !== SEMANTIC_EMBEDDING_DIM) return false;
  return arr.every((x) => typeof x === "number");
}

export async function POST(request: Request) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase not configured" },
      { status: 503 }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid form data" },
      { status: 400 }
    );
  }

  const file = formData.get("file") as File | null;
  const lookParamsStr = formData.get("lookParams") as string | null;
  const embeddingStr = formData.get("embedding") as string | null;
  const embeddingSemanticStr = formData.get("embeddingSemantic") as string | null;
  const name = (formData.get("name") as string | null)?.trim() || null;

  if (!file || !lookParamsStr || !embeddingStr || !embeddingSemanticStr) {
    return NextResponse.json(
      { error: "Missing required fields: file, lookParams, embedding, embeddingSemantic" },
      { status: 400 }
    );
  }

  let lookParams: LookParams;
  let embedding: number[];
  let embeddingSemantic: number[];
  try {
    lookParams = JSON.parse(lookParamsStr) as LookParams;
    embedding = JSON.parse(embeddingStr) as number[];
    embeddingSemantic = JSON.parse(embeddingSemanticStr) as number[];
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in lookParams, embedding, or embeddingSemantic" },
      { status: 400 }
    );
  }

  if (!validateLookParams(lookParams)) {
    return NextResponse.json(
      { error: "Invalid lookParams structure" },
      { status: 400 }
    );
  }
  if (!validateEmbedding(embedding)) {
    return NextResponse.json(
      { error: `Embedding must be array of ${EMBEDDING_DIM} numbers` },
      { status: 400 }
    );
  }
  if (!validateSemanticEmbedding(embeddingSemantic)) {
    return NextResponse.json(
      { error: `embeddingSemantic must be array of ${SEMANTIC_EMBEDDING_DIM} numbers` },
      { status: 400 }
    );
  }

  const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const path = `samples/${safeName}`;

  try {
    // Ensure bucket exists (idempotent; will 409 if already exists)
    await supabaseAdmin.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: 10 * 1024 * 1024, // 10MB
    });
  } catch {
    // Bucket may already exist
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const { error: uploadErr } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, buf, {
      contentType: file.type || "image/jpeg",
      upsert: false,
    });

  if (uploadErr) {
    return NextResponse.json(
      { error: `Storage upload failed: ${uploadErr.message}` },
      { status: 500 }
    );
  }

  const {
    data: { publicUrl },
  } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);

  const { data: row, error: insertErr } = await supabaseAdmin
    .from("grading_samples")
    .insert({
      name,
      image_url: publicUrl,
      look_params: lookParams,
      embedding,
      embedding_semantic: embeddingSemantic,
    })
    .select("id, created_at, image_url")
    .single();

  if (insertErr) {
    return NextResponse.json(
      { error: `Database insert failed: ${insertErr.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    id: row.id,
    created_at: row.created_at,
    image_url: row.image_url,
  });
}
