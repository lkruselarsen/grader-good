/**
 * GET /api/cloud/edit-sessions/:id — poll a cloud edit session; includes everything
 * lab2 needs, including the 3×3 reference choices and which of their bases are ready.
 */

import { NextResponse } from "next/server";
import { cloudSupabase } from "@/lib/cloud/server/db";
import { jsonError, requireCloudKey } from "@/lib/cloud/server/http";
import { sanitizeRenderSettings } from "@/lib/cloud/settings";
import {
  CLOUD_EXPORT_BUCKET,
  type CloudEditCandidateView,
  type CloudMatchCandidate,
} from "@/lib/cloud/types";
import { ALL_TILE_BLENDS, type Lab2TileBlend } from "@/lib/lab2/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNED_URL_TTL = 60 * 60;

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireCloudKey(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const supabase = cloudSupabase();
  const { data: session } = await supabase
    .from("cloud_edit_sessions")
    .select("id, output_id, status, error, preview_path, width, height, channels, warm_status")
    .eq("id", id)
    .maybeSingle();
  if (!session) return jsonError("Unknown edit session.", 404);
  const { data: output } = await supabase
    .from("cloud_outputs")
    .select(
      "id, job_id, item_id, algorithm, output_name, look_params, final_grading, render_settings, sample_id, sample_name"
    )
    .eq("id", session.output_id)
    .single();
  if (!output) return jsonError("The photo for this session no longer exists.", 404);
  const renderSettings = sanitizeRenderSettings(output.render_settings);
  const [{ data: job }, { data: item }, { data: bases }] = await Promise.all([
    supabase.from("cloud_jobs").select("slug").eq("id", output.job_id).single(),
    supabase.from("cloud_items").select("match_candidates").eq("id", output.item_id).single(),
    supabase
      .from("cloud_edit_bases")
      .select("sample_id, status, preview_path, width, height, channels, final_grading")
      .eq("item_id", output.item_id)
      .eq("model2_strength", renderSettings.model2Strength)
      .eq("model2_robust", renderSettings.model2Robust),
  ]);

  const lists = (item?.match_candidates ?? null) as Partial<
    Record<Lab2TileBlend, CloudMatchCandidate[]>
  > | null;
  const slots: Array<{ algorithm: Lab2TileBlend; rank: 1 | 2 | 3; c: Pick<CloudMatchCandidate, "sampleId" | "name" | "thumbUrl"> }> =
    [];
  for (const algorithm of ALL_TILE_BLENDS) {
    (lists?.[algorithm] ?? []).slice(0, 3).forEach((c, i) => {
      slots.push({ algorithm, rank: (i + 1) as 1 | 2 | 3, c });
    });
  }
  if (output.sample_id && !slots.some((s) => s.c.sampleId === output.sample_id)) {
    const { data: sample } = await supabase
      .from("grading_samples")
      .select("thumb_url")
      .eq("id", output.sample_id)
      .maybeSingle();
    slots.unshift({
      algorithm: output.algorithm as Lab2TileBlend,
      rank: 1,
      c: {
        sampleId: output.sample_id as string,
        name: (output.sample_name as string | null) ?? null,
        thumbUrl: (sample?.thumb_url as string | null) ?? null,
      },
    });
  }

  const bySample = new Map((bases ?? []).map((b) => [b.sample_id as string, b]));
  const readyPaths = [
    ...new Set(
      (bases ?? [])
        .filter((b) => b.status === "ready" && b.preview_path)
        .map((b) => b.preview_path as string)
    ),
  ];
  if (session.status === "ready" && session.preview_path) readyPaths.push(session.preview_path as string);
  const signed = new Map<string, string>();
  if (readyPaths.length > 0) {
    const { data } = await supabase.storage
      .from(CLOUD_EXPORT_BUCKET)
      .createSignedUrls([...new Set(readyPaths)], SIGNED_URL_TTL);
    for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
  }

  const candidates: CloudEditCandidateView[] = slots.map(({ algorithm, rank, c }) => {
    const b = bySample.get(c.sampleId);
    const ready = b?.status === "ready" && !!b.preview_path;
    return {
      algorithm,
      rank,
      sampleId: c.sampleId,
      name: c.name,
      thumbUrl: c.thumbUrl,
      status: b ? (b.status as CloudEditCandidateView["status"]) : "missing",
      previewUrl: ready ? (signed.get(b!.preview_path as string) ?? null) : null,
      width: ready ? (b!.width as number) : null,
      height: ready ? (b!.height as number) : null,
      channels: (b?.channels as number | undefined) ?? 4,
      finalGrading:
        c.sampleId === output.sample_id
          ? output.final_grading
          : ((b?.final_grading as CloudEditCandidateView["finalGrading"]) ?? null),
    };
  });

  return NextResponse.json(
    {
      id: session.id,
      status: session.status,
      error: session.error,
      warmStatus: session.warm_status,
      previewUrl:
        session.status === "ready" && session.preview_path
          ? (signed.get(session.preview_path as string) ?? null)
          : null,
      width: session.width,
      height: session.height,
      channels: session.channels ?? 4,
      candidates,
      output: {
        id: output.id,
        name: output.output_name,
        algorithm: output.algorithm,
        sampleId: output.sample_id,
        sampleName: output.sample_name,
        lookParams: output.look_params,
        finalGrading: output.final_grading,
        renderSettings,
        slug: job?.slug ?? null,
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
