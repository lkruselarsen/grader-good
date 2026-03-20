import { NextResponse } from "next/server";
import { requestStop } from "@/lib/train-stop-signal";

/**
 * POST /api/train/end-and-export
 *
 * Signals the running train job to stop on its next loop iteration and export
 * the most recent result. Body: { run_id: string }
 */
export async function POST(request: Request) {
  let body: { run_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const runId = body.run_id;
  if (!runId || typeof runId !== "string") {
    return NextResponse.json(
      { error: "Body must include run_id: string" },
      { status: 400 }
    );
  }

  requestStop(runId);

  return NextResponse.json({
    ok: true,
    message: "Stop requested. The job will finish its current step and export the latest result.",
  });
}
