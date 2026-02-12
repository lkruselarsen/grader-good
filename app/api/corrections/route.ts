import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { LookParams } from "@/lib/look-params";
import type { ExposureLevel, ChromaDistribution } from "@/src/lib/pipeline/imageStats";

interface CorrectionPayload {
  sourceId: string;
  referenceId: string | null;
  sourceFilename?: string;
  referenceFilename?: string | null;
  autoParams: LookParams;
  correctedParams: LookParams;
  source_exposure?: ExposureLevel | null;
  source_chroma_distribution?: ChromaDistribution | null;
  reference_exposure?: ExposureLevel | null;
  reference_chroma_distribution?: ChromaDistribution | null;
  source_type?: string | null;
}

export async function POST(request: Request) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase not configured" },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const {
    sourceId,
    referenceId,
    sourceFilename,
    referenceFilename,
    autoParams,
    correctedParams,
    source_exposure,
    source_chroma_distribution,
    reference_exposure,
    reference_chroma_distribution,
    source_type,
  } = body as CorrectionPayload;

  if (!sourceId || typeof sourceId !== "string") {
    return NextResponse.json(
      { error: "sourceId is required" },
      { status: 400 }
    );
  }

  try {
    const { error } = await supabaseAdmin
      .from("grading_corrections")
      .insert({
        source_id: sourceId,
        reference_id: referenceId,
        source_filename: sourceFilename ?? null,
        reference_filename: referenceFilename ?? null,
        auto_params: autoParams,
        corrected_params: correctedParams,
        source_exposure: source_exposure ?? null,
        source_chroma_distribution: source_chroma_distribution ?? null,
        reference_exposure: reference_exposure ?? null,
        reference_chroma_distribution: reference_chroma_distribution ?? null,
        source_type: source_type ?? null,
      })
      .single();

    if (error) {
      return NextResponse.json(
        {
          error: error.message,
          hint:
            "Ensure table grading_corrections exists with JSONB columns auto_params and corrected_params.",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

