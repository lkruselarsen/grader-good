/**
 * Yield control to the browser so timers, rAF, and paint can run.
 * Uses scheduler.yield when available, otherwise setTimeout(0).
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (
    globalThis as { scheduler?: { yield?: () => Promise<void> } }
  ).scheduler;
  if (typeof scheduler?.yield === "function") {
    return scheduler.yield();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
