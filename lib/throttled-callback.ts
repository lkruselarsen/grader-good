export type ThrottledCallback<T extends (...args: never[]) => void> = T & {
  flush: () => void;
  cancel: () => void;
};

/**
 * Coalesce rapid invocations — only the latest args are delivered, at most
 * once per `intervalMs`. Call flush() to invoke any pending update immediately.
 */
export function createThrottledCallback<T extends (...args: never[]) => void>(
  fn: T,
  intervalMs: number
): ThrottledCallback<T> {
  let pendingArgs: Parameters<T> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const invoke = () => {
    timer = null;
    if (!pendingArgs) return;
    const args = pendingArgs;
    pendingArgs = null;
    fn(...args);
  };

  const throttled = ((...args: Parameters<T>) => {
    pendingArgs = args;
    if (timer != null) return;
    timer = setTimeout(invoke, intervalMs);
  }) as ThrottledCallback<T>;

  throttled.flush = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    invoke();
  };

  throttled.cancel = () => {
    pendingArgs = null;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return throttled;
}
