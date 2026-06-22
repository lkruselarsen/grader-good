/**
 * GET /api/dataset/samples
 * Paginated read-only list of grading samples for the match list page.
 */

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export async function GET(request: Request) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      {
        error:
          "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const limit = Math.min(
    100,
    Math.max(1, Number(searchParams.get("limit") ?? "50") || 50)
  );
  const offset = (page - 1) * limit;

  const { data, error, count } = await supabaseAdmin
    .from("grading_samples")
    .select("id, name, image_url, created_at, embedding, embedding_semantic", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const samples = (data ?? []).map((row) => ({
    id: row.id as string,
    name: (row.name as string | null) ?? null,
    image_url: row.image_url as string,
    created_at: row.created_at as string,
    hasTonal: row.embedding != null,
    hasSemantic: row.embedding_semantic != null,
  }));

  return NextResponse.json({
    samples,
    total: count ?? 0,
    page,
    limit,
  });
}
