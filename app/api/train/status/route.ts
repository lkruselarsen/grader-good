import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export async function GET(request: Request) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase not configured" },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("run_id");

  if (!runId) {
    return NextResponse.json(
      { error: "run_id query parameter is required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from("training_runs")
    .select(
      "id, status, current_iteration, max_iterations, camera_type, error, final_image_base64"
    )
    .eq("id", runId)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  if (!data) {
    return NextResponse.json(
      { error: "Training run not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    id: data.id,
    status: data.status,
    current_iteration: data.current_iteration,
    max_iterations: data.max_iterations,
    camera_type: data.camera_type,
    error: data.error,
    final_image_base64: data.final_image_base64,
  });
}

