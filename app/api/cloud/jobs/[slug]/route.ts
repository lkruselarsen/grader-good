/** GET /api/cloud/jobs/:slug — batch status and signed URLs. The slug is the capability. */

import { NextResponse } from "next/server";
import { jsonError } from "@/lib/cloud/server/http";
import { loadJobView } from "@/lib/cloud/server/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const view = await loadJobView(slug.toLowerCase());
  if (!view) return jsonError("No batch at this address.", 404);
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
