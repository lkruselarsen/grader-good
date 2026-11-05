/**
 * Starts cloud work. With TRIGGER_SECRET_KEY set, work runs on Trigger.dev.
 * Without it (local development), CLOUD_LOCAL_WORKER=1 leaves the queued rows
 * for `npm run cloud:worker` to pick up. Worker code is never imported here so
 * the Vercel functions stay small.
 */

type CloudTask =
  | { kind: "process-cloud-item"; itemId: string }
  | { kind: "prepare-cloud-edit"; sessionId: string }
  | { kind: "render-cloud-output"; outputId: string };

export function cloudRunnerConfigured(): boolean {
  return !!process.env.TRIGGER_SECRET_KEY || process.env.CLOUD_LOCAL_WORKER === "1";
}

export async function dispatchCloudTask(t: CloudTask): Promise<void> {
  if (process.env.TRIGGER_SECRET_KEY) {
    const { tasks } = await import("@trigger.dev/sdk");
    const { kind, ...payload } = t;
    await tasks.trigger(kind, payload, {
      idempotencyKey: `${kind}:${Object.values(payload)[0]}`,
      idempotencyKeyTTL: "2m",
    });
    return;
  }
  if (process.env.CLOUD_LOCAL_WORKER === "1") return;
  throw new Error(
    "Cloud processing is not configured: set TRIGGER_SECRET_KEY (or CLOUD_LOCAL_WORKER=1 with `npm run cloud:worker` locally)."
  );
}
