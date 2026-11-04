import { gzipSync } from "node:zlib";
import type { LookParams as LookParamsT } from "@/lib/look-params";
import { engineToGrading } from "@/lib/look-params";
import { ALL_TILE_BLENDS, buildTileSearchBody, type Lab2TileBlend } from "@/lib/lab2/types";
import { searchTiles } from "@/lib/dataset/search-tiles";
import { downscaleLinearFloatMaxEdge, PREVIEW_LIVE_MAX_EDGE } from "@/lib/scale-linear-float-frame";
import { cloudSupabase, uploadObject } from "@/lib/cloud/server/db";
import { fetchReferenceLinearFloat } from "@/lib/cloud/node/reference";
import {
  CLOUD_EXPORT_BUCKET,
  type CloudMatchCandidate,
  type CloudMatchCandidates,
} from "@/lib/cloud/types";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";
import type { PixelFrameF32 } from "@/src/lib/pipeline/types";
import { buildCloudEditBase } from "./render";

export const CANDIDATES_PER_ALGORITHM = 3;

export type Model2Settings = { model2Strength: number; model2Robust: boolean };

export type CandidateSlot = {
  algorithm: Lab2TileBlend;
  rank: 1 | 2 | 3;
  candidate: CloudMatchCandidate;
};

/**
 * Top 3 dataset matches for every algorithm (the same 3×3 lab2 offers). Searches
 * run one at a time so a batch of parallel photos does not flood the database;
 * an algorithm whose search fails gets an empty list.
 */
export async function searchAllCandidates(
  embeddings: { semantic: number[][]; chromatic: number[][] },
  log: (message: string, extra?: Record<string, unknown>) => void = () => {}
): Promise<CloudMatchCandidates> {
  const supabase = cloudSupabase();
  const out = {} as CloudMatchCandidates;
  for (const algorithm of ALL_TILE_BLENDS) {
    let matches: Awaited<ReturnType<typeof searchTiles>> = [];
    try {
      matches = await searchTiles(
        supabase,
        buildTileSearchBody(algorithm, embeddings.semantic, embeddings.chromatic),
        CANDIDATES_PER_ALGORITHM
      );
    } catch (e) {
      log("candidate search failed", { algorithm, error: e instanceof Error ? e.message : String(e) });
    }
    out[algorithm] = matches
      .filter((m) => !!m.image_url)
      .slice(0, CANDIDATES_PER_ALGORITHM)
      .map((m) => ({
        sampleId: m.id,
        name: m.name,
        imageUrl: m.image_url as string,
        thumbUrl: m.thumb_url ?? null,
        similarity: Number(m.similarity ?? 0),
      }));
  }
  return out;
}

export function parseCandidates(raw: unknown): CloudMatchCandidates | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Record<Lab2TileBlend, CloudMatchCandidate[]>>;
  if (!ALL_TILE_BLENDS.every((a) => Array.isArray(r[a]))) return null;
  return r as CloudMatchCandidates;
}

/** Candidates in display order (algorithm, then rank). */
export function candidateSlots(candidates: CloudMatchCandidates): CandidateSlot[] {
  const slots: CandidateSlot[] = [];
  for (const algorithm of ALL_TILE_BLENDS) {
    (candidates[algorithm] ?? []).slice(0, CANDIDATES_PER_ALGORITHM).forEach((candidate, i) => {
      slots.push({ algorithm, rank: (i + 1) as 1 | 2 | 3, candidate });
    });
  }
  return slots;
}

/** Reference decoded to linear float, with the grading lab2's auto match would fit. */
export async function loadCandidateReference(imageUrl: string) {
  const decodedRef = await fetchReferenceLinearFloat(imageUrl);
  return { decodedRef, grading: engineToGrading(fitLookParamsFromReference(decodedRef)) };
}

/** Best-ranked candidate of one algorithm whose reference loads (lab2 auto-match order). */
export async function matchReference(algorithm: Lab2TileBlend, candidates: CloudMatchCandidates) {
  let lastError: unknown = null;
  const list = (candidates[algorithm] ?? []).slice(0, CANDIDATES_PER_ALGORITHM);
  for (let i = 0; i < list.length; i++) {
    const candidate = list[i]!;
    try {
      const ref = await loadCandidateReference(candidate.imageUrl);
      return { slot: { algorithm, rank: (i + 1) as 1 | 2 | 3, candidate }, ...ref };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error(`No dataset matches found for ${algorithm}.`);
}

/**
 * Live-preview-size copy of a Model 2 base, gzipped. The base itself is always
 * built from the full-resolution DNG; only this view for the sliders is
 * smaller. Alpha is dropped when it is uniformly 1 (lossless).
 */
export function encodeEditBase(base: PixelFrameF32) {
  const preview = downscaleLinearFloatMaxEdge(base, PREVIEW_LIVE_MAX_EDGE);
  const px = preview.width * preview.height;
  let opaque = true;
  for (let i = 3; i < preview.data.length; i += 4) {
    if (preview.data[i] !== 1) {
      opaque = false;
      break;
    }
  }
  let packed: Float32Array;
  if (opaque) {
    packed = new Float32Array(px * 3);
    for (let p = 0; p < px; p++) {
      packed[p * 3] = preview.data[p * 4]!;
      packed[p * 3 + 1] = preview.data[p * 4 + 1]!;
      packed[p * 3 + 2] = preview.data[p * 4 + 2]!;
    }
  } else {
    packed = preview.data;
  }
  const gz = gzipSync(Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength), { level: 6 });
  return { gz, width: preview.width, height: preview.height, channels: opaque ? 3 : 4 };
}

function baseKey(itemId: string, sampleId: string, m: Model2Settings) {
  return {
    item_id: itemId,
    sample_id: sampleId,
    model2_strength: m.model2Strength,
    model2_robust: m.model2Robust,
  };
}

export function editBasePath(itemId: string, sampleId: string, m: Model2Settings) {
  return `edits/items/${itemId}/${sampleId}-m${m.model2Strength}-${m.model2Robust ? "r" : "n"}.f32.gz`;
}

export type EditBaseRow = {
  id: string;
  sample_id: string;
  sample_name: string | null;
  algorithm: Lab2TileBlend;
  rank: number;
  status: "pending" | "processing" | "ready" | "failed";
  error: string | null;
  preview_path: string | null;
  preview_bytes: number;
  width: number | null;
  height: number | null;
  channels: number;
  final_grading: LookParamsT["grading"] | null;
  updated_at: string;
};

export const EDIT_BASE_COLUMNS =
  "id, sample_id, sample_name, algorithm, rank, status, error, preview_path, preview_bytes, width, height, channels, final_grading, updated_at";

export async function listEditBases(itemId: string, m: Model2Settings): Promise<EditBaseRow[]> {
  const { data } = await cloudSupabase()
    .from("cloud_edit_bases")
    .select(EDIT_BASE_COLUMNS)
    .eq("item_id", itemId)
    .eq("model2_strength", m.model2Strength)
    .eq("model2_robust", m.model2Robust);
  return (data ?? []) as EditBaseRow[];
}

export async function markEditBase(
  ids: { jobId: string; itemId: string },
  slot: CandidateSlot,
  m: Model2Settings,
  patch: { status: EditBaseRow["status"]; error?: string | null }
) {
  await cloudSupabase()
    .from("cloud_edit_bases")
    .upsert(
      {
        ...baseKey(ids.itemId, slot.candidate.sampleId, m),
        job_id: ids.jobId,
        sample_name: slot.candidate.name,
        algorithm: slot.algorithm,
        rank: slot.rank,
        status: patch.status,
        error: patch.error ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "item_id,sample_id,model2_strength,model2_robust" }
    );
}

/** Builds the Model 2 base from the full-resolution source and publishes its preview. */
export async function buildAndStoreEditBase(
  ids: { jobId: string; itemId: string },
  slot: CandidateSlot,
  m: Model2Settings,
  source: PixelFrameF32,
  reference: { decodedRef: PixelFrameF32; grading: LookParamsT["grading"] },
  lookParams: LookParamsT
): Promise<EditBaseRow> {
  const base = buildCloudEditBase(
    source,
    reference.decodedRef,
    lookParams,
    reference.grading,
    m.model2Strength,
    m.model2Robust
  );
  const encoded = encodeEditBase(base);
  const path = editBasePath(ids.itemId, slot.candidate.sampleId, m);
  await uploadObject(CLOUD_EXPORT_BUCKET, path, encoded.gz, "application/octet-stream");
  const { data, error } = await cloudSupabase()
    .from("cloud_edit_bases")
    .upsert(
      {
        ...baseKey(ids.itemId, slot.candidate.sampleId, m),
        job_id: ids.jobId,
        sample_name: slot.candidate.name,
        algorithm: slot.algorithm,
        rank: slot.rank,
        status: "ready",
        error: null,
        preview_path: path,
        preview_bytes: encoded.gz.byteLength,
        width: encoded.width,
        height: encoded.height,
        channels: encoded.channels,
        final_grading: reference.grading,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "item_id,sample_id,model2_strength,model2_robust" }
    )
    .select(EDIT_BASE_COLUMNS)
    .single();
  if (error || !data) throw new Error(`Could not record edit base: ${error?.message}`);
  return data as EditBaseRow;
}
