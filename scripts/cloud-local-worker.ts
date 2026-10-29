/**
 * Local stand-in for Trigger.dev: polls Supabase for queued cloud work and runs
 * the same worker functions the Trigger.dev tasks run, one at a time.
 * Run: npm run cloud:worker   (with CLOUD_LOCAL_WORKER=1 in .env.local)
 */

import { cloudSupabase } from "@/lib/cloud/server/db";
import { processCloudItem } from "@/lib/cloud/worker/process-item";
import { prepareCloudEdit, renderCloudOutput } from "@/lib/cloud/worker/edit";

const POLL_MS = 3000;
const log = (message: string, extra?: Record<string, unknown>) =>
  console.log(`[cloud-worker] ${message}`, extra ? JSON.stringify(extra) : "");

async function nextWork(): Promise<(() => Promise<void>) | null> {
  const supabase = cloudSupabase();
  const { data: session } = await supabase
    .from("cloud_edit_sessions")
    .select("id")
    .eq("status", "pending")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (session) return () => prepareCloudEdit(session.id as string, log);
  const { data: render } = await supabase
    .from("cloud_outputs")
    .select("id")
    .eq("status", "pending")
    .gt("version", 0)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (render) return () => renderCloudOutput(render.id as string, log);
  const { data: item } = await supabase
    .from("cloud_items")
    .select("id")
    .eq("status", "uploaded")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (item) return () => processCloudItem(item.id as string, log);
  return null;
}

async function main() {
  log("polling for cloud work");
  for (;;) {
    const work = await nextWork().catch((e) => {
      log("poll failed", { error: String(e) });
      return null;
    });
    if (!work) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    const t0 = Date.now();
    try {
      await work();
      log("done", { ms: Date.now() - t0 });
    } catch (e) {
      log("failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

void main();
