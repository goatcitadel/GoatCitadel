/** Keeps short-lived provider typing indicators alive without overlapping requests. */
export async function withChannelProgressHeartbeat<T>(
  operation: () => Promise<T>,
  heartbeat: (signal: AbortSignal) => Promise<void>,
  intervalMs = 4_000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  const schedule = () => {
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      pending = heartbeat(controller.signal).then(schedule, () => {
        // A lost lease or failed progress transport stops this advisory pulse.
        // The durable task remains owned by its normal execution path.
      });
    }, intervalMs);
    timer.unref?.();
  };
  schedule();
  try {
    return await operation();
  } finally {
    controller.abort();
    if (timer) clearTimeout(timer);
    await pending;
  }
}
