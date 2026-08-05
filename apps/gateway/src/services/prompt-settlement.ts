export type PromptSettlement<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "pending" };

export interface PromptSettlementObservationOptions {
  /**
   * Optional event-loop grace for transports whose abort acknowledgement and
   * usage settlement cannot complete within the immediate microtask budget.
   */
  graceMs?: number;
}

/**
 * Observe only the immediate abort/cleanup reaction of an in-flight operation.
 * The fixed microtask budget lets well-behaved transports settle canonical
 * accounting without allowing an abort-ignorant adapter to defeat a timeout.
 */
export async function observePromptSettlement<T>(
  promise: Promise<T>,
  options: PromptSettlementObservationOptions = {},
): Promise<PromptSettlement<T>> {
  const settled = promise.then<PromptSettlement<T>, PromptSettlement<T>>(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
  const pending = Symbol("pending");

  for (let checkpoint = 0; checkpoint < 4; checkpoint += 1) {
    await Promise.resolve();
    const outcome = await Promise.race([settled, Promise.resolve(pending)]);
    if (outcome !== pending) return outcome;
  }

  const graceMs = Math.max(0, Math.floor(options.graceMs ?? 0));
  if (graceMs > 0) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        settled,
        new Promise<typeof pending>((resolve) => {
          timer = setTimeout(() => resolve(pending), graceMs);
        }),
      ]);
      if (outcome !== pending) return outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  return { status: "pending" };
}
