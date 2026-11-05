import { logger, queue, task } from "@trigger.dev/sdk";
import { processCloudItem } from "@/lib/cloud/worker/process-item";
import { prepareCloudEdit, renderCloudOutput } from "@/lib/cloud/worker/edit";
import { decodeBufferToLinearFloat } from "@/src/lib/pipeline/decodeNode";

process.env.TRANSFORMERS_CACHE_DIR ??= "/tmp/transformers-cache";

/**
 * Batch renders. Compute is billed per second, so parallel photos cost the same
 * as serial ones; 6 at a time keeps a 30-photo batch within about an hour.
 */
const batchQueue = queue({ name: "cloud-batch", concurrencyLimit: 6 });
/** Interactive work (open in editor, re-export) never waits behind a batch. */
const interactiveQueue = queue({ name: "cloud-interactive", concurrencyLimit: 2 });

const log = (message: string, extra?: Record<string, unknown>) => logger.log(message, extra);

export const processCloudItemTask = task({
  id: "process-cloud-item",
  queue: batchQueue,
  machine: "large-1x",
  maxDuration: 1800,
  run: async (payload: { itemId: string }) => {
    await processCloudItem(payload.itemId, log);
    return { itemId: payload.itemId };
  },
});

export const prepareCloudEditTask = task({
  id: "prepare-cloud-edit",
  queue: interactiveQueue,
  machine: "large-1x",
  maxDuration: 600,
  retry: { maxAttempts: 1 },
  run: async (payload: { sessionId: string }) => {
    await prepareCloudEdit(payload.sessionId, log);
    return { sessionId: payload.sessionId };
  },
});

export const renderCloudOutputTask = task({
  id: "render-cloud-output",
  queue: interactiveQueue,
  machine: "large-1x",
  maxDuration: 900,
  run: async (payload: { outputId: string }) => {
    await renderCloudOutput(payload.outputId, log);
    return { outputId: payload.outputId };
  },
});

/** Deploy check: proves the container can load LibRaw and decode a DNG at 16-bit. */
export const cloudSmokeTask = task({
  id: "cloud-smoke",
  machine: "small-2x",
  maxDuration: 300,
  run: async (payload: { dngUrl?: string }) => {
    // @ts-expect-error lightdrift-libraw .d.ts is ambient-only, not importable as a module
    await import("lightdrift-libraw");
    if (!payload.dngUrl) return { libraw: "loaded" };
    const res = await fetch(payload.dngUrl);
    const frame = await decodeBufferToLinearFloat(Buffer.from(await res.arrayBuffer()));
    return { libraw: "loaded", width: frame.width, height: frame.height };
  },
});
