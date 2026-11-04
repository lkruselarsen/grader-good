import type { LookParams as LookParamsT } from "@/lib/look-params";
import { computeTileEmbeddingsNode } from "@/lib/cloud/node/tile-embeddings";
import { cloudSupabase, errorMessage, uploadObject } from "@/lib/cloud/server/db";
import { sanitizeRenderSettings } from "@/lib/cloud/settings";
import { CLOUD_EXPORT_BUCKET, type CloudMatchCandidates } from "@/lib/cloud/types";
import type { PixelFrameF32 } from "@/src/lib/pipeline/types";
import { rollUpJobStatus } from "./job-status";
import { exportPaths, type CloudLog } from "./process-item";
import {
  buildAndStoreEditBase,
  candidateSlots,
  listEditBases,
  loadCandidateReference,
  markEditBase,
  parseCandidates,
  searchAllCandidates,
  type CandidateSlot,
  type EditBaseRow,
  type Model2Settings,
} from "./edit-bases";
import { decodeCloudDng, loadSampleReference, renderCloudExport } from "./render";

const noopLog: CloudLog = () => {};
/** A base stuck in "processing" longer than this is treated as abandoned. */
const STALE_PROCESSING_MS = 10 * 60 * 1000;

async function loadOutputContext(outputId: string) {
  const supabase = cloudSupabase();
  const { data: output, error } = await supabase
    .from("cloud_outputs")
    .select(
      "id, job_id, item_id, algorithm, output_name, sample_id, sample_name, final_grading, look_params, render_settings"
    )
    .eq("id", outputId)
    .single();
  if (error || !output) throw new Error(`Cloud output ${outputId} not found`);
  const { data: item } = await supabase
    .from("cloud_items")
    .select("id, dng_path, match_candidates")
    .eq("id", output.item_id)
    .single();
  if (!item?.dng_path) throw new Error("The original DNG has been cleared from storage.");
  if (!output.sample_id || !output.final_grading) {
    throw new Error("This export has no stored match to edit from.");
  }
  return { output, dngPath: item.dng_path as string, candidates: parseCandidates(item.match_candidates) };
}

function isPending(row: EditBaseRow | undefined): boolean {
  if (!row) return true;
  if (row.status === "ready") return false;
  if (row.status === "processing") {
    return Date.now() - new Date(row.updated_at).getTime() > STALE_PROCESSING_MS;
  }
  return true;
}

/**
 * Cloud edit session. The base for the export's own reference is usually
 * cached by the batch, in which case the session is already ready. Otherwise it
 * is built first from the full DNG. Then the remaining reference choices (top 3
 * per algorithm) are built in the background from the same single decode, so
 * lab2 can switch between them without waiting. Sliders edit parameters against
 * these previews; exports always re-render from the DNG.
 */
export async function prepareCloudEdit(sessionId: string, log: CloudLog = noopLog): Promise<void> {
  const supabase = cloudSupabase();
  const now = () => new Date().toISOString();
  const { data: session } = await supabase
    .from("cloud_edit_sessions")
    .select("id, output_id, status")
    .eq("id", sessionId)
    .single();
  if (!session) throw new Error(`Edit session ${sessionId} not found`);
  const sessionReady = session.status === "ready";
  await supabase
    .from("cloud_edit_sessions")
    .update({ ...(sessionReady ? {} : { status: "processing" }), warm_status: "processing", updated_at: now() })
    .eq("id", sessionId);

  let source: PixelFrameF32 | null = null;
  let context: Awaited<ReturnType<typeof loadOutputContext>>;
  let m: Model2Settings;
  let lookParams: LookParamsT;
  let ids: { jobId: string; itemId: string };
  const getSource = async () => (source ??= await decodeCloudDng(context.dngPath));

  try {
    context = await loadOutputContext(session.output_id as string);
    const settings = sanitizeRenderSettings(context.output.render_settings);
    m = { model2Strength: settings.model2Strength, model2Robust: settings.model2Robust };
    lookParams = settings.lookParams;
    ids = { jobId: context.output.job_id as string, itemId: context.output.item_id as string };
    const bases = new Map((await listEditBases(ids.itemId, m)).map((b) => [b.sample_id, b]));
    const sampleId = context.output.sample_id as string;
    let primary = bases.get(sampleId);
    if (!primary || primary.status !== "ready") {
      const { data: sample } = await supabase
        .from("grading_samples")
        .select("image_url, thumb_url")
        .eq("id", sampleId)
        .maybeSingle();
      if (!sample?.image_url) throw new Error("The matched reference is no longer in the dataset.");
      const slot = findSlot(context.candidates, sampleId) ?? {
        algorithm: context.output.algorithm,
        rank: 1,
        candidate: {
          sampleId,
          name: (context.output.sample_name as string | null) ?? null,
          imageUrl: sample.image_url as string,
          thumbUrl: (sample.thumb_url as string | null) ?? null,
          similarity: 0,
        },
      };
      const ref = await loadSampleReference(sampleId);
      primary = await buildAndStoreEditBase(
        ids,
        slot,
        m,
        await getSource(),
        { decodedRef: ref.decodedRef, grading: context.output.final_grading as LookParamsT["grading"] },
        lookParams
      );
      bases.set(sampleId, primary);
    }
    if (!sessionReady) {
      await supabase
        .from("cloud_edit_sessions")
        .update({
          status: "ready",
          preview_path: primary.preview_path,
          preview_bytes: primary.preview_bytes,
          width: primary.width,
          height: primary.height,
          channels: primary.channels,
          updated_at: now(),
        })
        .eq("id", sessionId);
    }
    log("edit ready", { sessionId, width: primary.width, height: primary.height });

    let candidates = context.candidates;
    if (!candidates) {
      const embeddings = await computeTileEmbeddingsNode(await getSource());
      candidates = await searchAllCandidates(embeddings);
      await supabase.from("cloud_items").update({ match_candidates: candidates }).eq("id", ids.itemId);
    }
    await warmCandidates(ids, m, candidates, bases, context.output.algorithm, getSource, lookParams, log);
    await supabase
      .from("cloud_edit_sessions")
      .update({ warm_status: "done", updated_at: now() })
      .eq("id", sessionId);
  } catch (e) {
    const { data: current } = await supabase
      .from("cloud_edit_sessions")
      .select("status")
      .eq("id", sessionId)
      .single();
    await supabase
      .from("cloud_edit_sessions")
      .update({
        ...(current?.status === "ready" ? {} : { status: "failed", error: errorMessage(e) }),
        warm_status: "failed",
        updated_at: now(),
      })
      .eq("id", sessionId);
    throw e;
  }
}

function findSlot(candidates: CloudMatchCandidates | null, sampleId: string): CandidateSlot | null {
  if (!candidates) return null;
  return candidateSlots(candidates).find((s) => s.candidate.sampleId === sampleId) ?? null;
}

/** Builds every reference choice that has no ready base yet; the next reference loads while one builds. */
async function warmCandidates(
  ids: { jobId: string; itemId: string },
  m: Model2Settings,
  candidates: CloudMatchCandidates,
  bases: Map<string, EditBaseRow>,
  preferredAlgorithm: string,
  getSource: () => Promise<PixelFrameF32>,
  lookParams: LookParamsT,
  log: CloudLog
) {
  const seen = new Set<string>();
  const todo = candidateSlots(candidates)
    .filter((slot) => {
      if (seen.has(slot.candidate.sampleId)) return false;
      seen.add(slot.candidate.sampleId);
      return isPending(bases.get(slot.candidate.sampleId));
    })
    .sort((a, b) => Number(b.algorithm === preferredAlgorithm) - Number(a.algorithm === preferredAlgorithm));
  if (todo.length === 0) return;
  await Promise.all(todo.map((slot) => markEditBase(ids, slot, m, { status: "pending" })));
  const load = (i: number) => loadCandidateReference(todo[i]!.candidate.imageUrl);
  let next: ReturnType<typeof load> | null = load(0);
  for (let i = 0; i < todo.length; i++) {
    const slot = todo[i]!;
    const t0 = Date.now();
    const current = next!;
    next = i + 1 < todo.length ? load(i + 1) : null;
    next?.catch(() => {});
    try {
      await markEditBase(ids, slot, m, { status: "processing" });
      const ref = await current;
      await buildAndStoreEditBase(ids, slot, m, await getSource(), ref, lookParams);
      log("candidate ready", { sample: slot.candidate.sampleId, ms: Date.now() - t0 });
    } catch (e) {
      log("candidate failed", { sample: slot.candidate.sampleId, error: errorMessage(e) });
      await markEditBase(ids, slot, m, { status: "failed", error: errorMessage(e) });
    }
  }
}

/** Full-resolution re-render of an edited export into its own (versioned) output row. */
export async function renderCloudOutput(outputId: string, log: CloudLog = noopLog): Promise<void> {
  const supabase = cloudSupabase();
  const now = () => new Date().toISOString();
  await supabase.from("cloud_outputs").update({ status: "processing", updated_at: now() }).eq("id", outputId);
  try {
    const { output, dngPath } = await loadOutputContext(outputId);
    const settings = sanitizeRenderSettings(output.render_settings);
    const source = await decodeCloudDng(dngPath);
    const { decodedRef } = await loadSampleReference(output.sample_id as string);
    const result = await renderCloudExport(
      source,
      decodedRef,
      output.final_grading as LookParamsT["grading"],
      settings
    );
    const paths = exportPaths(output.job_id as string, output.output_name as string);
    await uploadObject(CLOUD_EXPORT_BUCKET, paths.png, result.png, "image/png");
    await uploadObject(CLOUD_EXPORT_BUCKET, paths.thumb, result.thumb, "image/jpeg");
    await supabase
      .from("cloud_outputs")
      .update({
        status: "done",
        png_path: paths.png,
        png_bytes: result.png.byteLength,
        thumb_path: paths.thumb,
        thumb_bytes: result.thumb.byteLength,
        width: result.width,
        height: result.height,
        updated_at: now(),
      })
      .eq("id", outputId);
    log("re-render done", { output: output.output_name });
    await rollUpJobStatus(output.job_id as string);
  } catch (e) {
    await supabase
      .from("cloud_outputs")
      .update({ status: "failed", error: errorMessage(e), updated_at: now() })
      .eq("id", outputId);
    throw e;
  }
}
