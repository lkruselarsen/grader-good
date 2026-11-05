/** GET /api/cloud/outputs/:id — status of one export (used while a re-render runs). */

import { NextResponse } from "next/server";
import { cloudSupabase } from "@/lib/cloud/server/db";
import { jsonError } from "@/lib/cloud/server/http";
import { buildOutputViews, OUTPUT_COLUMNS } from "@/lib/cloud/server/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = cloudSupabase();
  const { data: row } = await supabase
    .from("cloud_outputs")
    .select(OUTPUT_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (!row) return jsonError("Unknown photo.", 404);
  const { data: item } = await supabase
    .from("cloud_items")
    .select("dng_path")
    .eq("id", row.item_id)
    .single();
  const [view] = await buildOutputViews(
    [row as Parameters<typeof buildOutputViews>[0][number]],
    new Map([[row.item_id as string, !!item?.dng_path]])
  );
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
