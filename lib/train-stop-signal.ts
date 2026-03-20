/**
 * In-memory map for "End and Export" requests.
 * runToolsJob checks this each loop iteration; when set, it breaks and exports.
 */
export const stopRequestedForRun = new Map<string, boolean>();

export function requestStop(runId: string): void {
  stopRequestedForRun.set(runId, true);
}

export function clearStopRequest(runId: string): void {
  stopRequestedForRun.delete(runId);
}
