import { observePromptSettlement, type PromptSettlement } from "../prompt-settlement.js";

export function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export type ChatStreamStepOrToolActivityTick<T> = { kind: "step"; step: IteratorResult<T> } | { kind: "tick" };

export interface ChatStreamPendingStep<T> {
  wait(delayMs: number, signal?: AbortSignal): Promise<ChatStreamStepOrToolActivityTick<T>>;
  observe(): Promise<PromptSettlement<IteratorResult<T>>>;
}

type ChatStreamPendingStepSettlement<T> = { kind: "step"; step: IteratorResult<T> } | { kind: "error"; error: Error };

export function normalizeToolActivityHeartbeatMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(10, Math.floor(value)) : 5_000;
}

export function createChatStreamPendingStep<T>(nextStep: Promise<IteratorResult<T>>): ChatStreamPendingStep<T> {
  let settlement: ChatStreamPendingStepSettlement<T> | undefined;
  const waiters = new Set<(value: ChatStreamPendingStepSettlement<T>) => void>();
  const settle = (value: ChatStreamPendingStepSettlement<T>): void => {
    if (settlement) {
      return;
    }
    settlement = value;
    for (const waiter of waiters) {
      waiter(value);
    }
    waiters.clear();
  };

  // Attach exactly one settlement pair to the inner next() promise. Repeated
  // heartbeat ticks therefore do not accumulate handlers on a long-running
  // tool promise.
  void nextStep.then(
    (step) => settle({ kind: "step", step }),
    (error: unknown) => settle({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) }),
  );

  return {
    observe: () => observePromptSettlement(nextStep),
    wait: (delayMs, signal) => {
      if (settlement) {
        return settlement.kind === "error" ? Promise.reject(settlement.error) : Promise.resolve(settlement);
      }
      return new Promise((resolve, reject) => {
        let finished = false;
        let abortTimeoutId: NodeJS.Timeout | undefined;
        const cleanup = (): void => {
          if (abortTimeoutId) {
            clearTimeout(abortTimeoutId);
          }
          clearTimeout(timeoutId);
          signal?.removeEventListener("abort", onAbort);
          waiters.delete(onSettlement);
        };
        const finish = (action: () => void): void => {
          if (finished) {
            return;
          }
          finished = true;
          cleanup();
          action();
        };
        const onAbort = (): void => {
          // Give the inner runner one microtask/macrotask turn to emit its
          // canonical cancelled trace. An abort-ignorant tool still cannot
          // hold the wrapper: the zero-delay fallback rejects promptly.
          abortTimeoutId ??= setTimeout(() => finish(() => reject(createAbortError("Chat turn cancelled"))), 0);
        };
        const onSettlement = (value: ChatStreamPendingStepSettlement<T>): void =>
          finish(() => {
            if (value.kind === "error") {
              reject(value.error);
              return;
            }
            resolve(value);
          });

        waiters.add(onSettlement);
        if (signal?.aborted) {
          onAbort();
        } else {
          signal?.addEventListener("abort", onAbort, { once: true });
        }
        const timeoutId = setTimeout(() => finish(() => resolve({ kind: "tick" })), delayMs);
      });
    },
  };
}
