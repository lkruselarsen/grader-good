import type { BulkQueueProgress } from "./types";

export type BulkQueueCallbacks = {
  onItemStart: (id: string, index: number, total: number) => void;
  onItemStatus: (id: string, status: string) => void;
  onItemComplete: (id: string, durationMs: number) => void;
  onQueueProgress: (progress: BulkQueueProgress) => void;
  processItem: (id: string, runId: number) => Promise<void>;
};

export class BulkQueueRunner {
  private runId = 0;
  private completionTimes: number[] = [];

  cancel(): void {
    this.runId += 1;
  }

  getCurrentRunId(): number {
    return this.runId;
  }

  async runSequential(
    itemIds: string[],
    callbacks: BulkQueueCallbacks
  ): Promise<void> {
    if (!itemIds.length) return;
    const runId = ++this.runId;
    this.completionTimes = [];
    const total = itemIds.length;

    callbacks.onQueueProgress({
      running: true,
      currentIndex: 0,
      total,
      phase: "Starting…",
      etaMinutes: null,
    });

    for (let idx = 0; idx < itemIds.length; idx += 1) {
      if (runId !== this.runId) break;
      const id = itemIds[idx]!;
      const itemStart = Date.now();

      callbacks.onItemStart(id, idx + 1, total);
      callbacks.onQueueProgress({
        running: true,
        currentIndex: idx + 1,
        total,
        phase: `Image ${idx + 1} of ${total}`,
        etaMinutes: this.estimateEtaMinutes(idx, total),
      });

      try {
        await callbacks.processItem(id, runId);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        callbacks.onItemStatus(id, `Error: ${message}`);
      }

      if (runId !== this.runId) break;

      const durationMs = Date.now() - itemStart;
      this.completionTimes.push(durationMs);
      callbacks.onItemComplete(id, durationMs);
    }

    if (runId === this.runId) {
      callbacks.onQueueProgress({
        running: false,
        currentIndex: total,
        total,
        phase: "Complete",
        etaMinutes: 0,
      });
    }
  }

  private estimateEtaMinutes(completedIndex: number, total: number): number | null {
    if (this.completionTimes.length === 0) return null;
    const avgMs =
      this.completionTimes.reduce((a, b) => a + b, 0) /
      this.completionTimes.length;
    const remaining = total - completedIndex - 1;
    if (remaining <= 0) return 0;
    return Math.ceil((avgMs * remaining) / 60000);
  }
}

export const bulkQueueRunner = new BulkQueueRunner();
