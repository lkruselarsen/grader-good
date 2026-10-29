import { cloudSupabase } from "@/lib/cloud/server/db";
import type { CloudJobStatus } from "@/lib/cloud/types";

/** Uploads that never finished stop counting after this long. */
const UPLOAD_GRACE_MS = 6 * 60 * 60 * 1000;

export function deriveJobStatus(
  createdAt: string,
  items: Array<{ status: string }>,
  batchOutputs: Array<{ status: string }>
): CloudJobStatus {
  const active = items.some((i) => i.status === "uploaded" || i.status === "processing");
  if (active) return "processing";
  const stalePending = Date.now() - new Date(createdAt).getTime() > UPLOAD_GRACE_MS;
  if (items.some((i) => i.status === "pending") && !stalePending) return "uploading";
  const done = batchOutputs.filter((o) => o.status === "done").length;
  if (done === 0) return "failed";
  const settled = items.every((i) => i.status === "done");
  return settled && done === batchOutputs.length ? "done" : "partial";
}

export async function rollUpJobStatus(jobId: string): Promise<CloudJobStatus> {
  const supabase = cloudSupabase();
  const [{ data: job }, { data: items }, { data: outputs }] = await Promise.all([
    supabase.from("cloud_jobs").select("created_at").eq("id", jobId).single(),
    supabase.from("cloud_items").select("status").eq("job_id", jobId),
    supabase.from("cloud_outputs").select("status").eq("job_id", jobId).eq("version", 0),
  ]);
  const status = deriveJobStatus(
    (job?.created_at as string) ?? new Date().toISOString(),
    items ?? [],
    outputs ?? []
  );
  await supabase
    .from("cloud_jobs")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  return status;
}
