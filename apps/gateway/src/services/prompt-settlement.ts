export type PromptSettlement<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "pending" };

/**
 * Observe only the immediate abort/cleanup reaction of an in-flight operation.
 * The fixed microtask budget lets well-behaved transports settle canonical
 * accounting without allowing an abort-ignorant adapter to defeat a timeout.
 */
export async function observePromptSettlement<T>(promise: Promise<T>): Promise<PromptSettlement<T>> {
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
  return { status: "pending" };
}
