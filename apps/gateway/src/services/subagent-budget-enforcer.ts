export interface ChildDepthInput {
  depth: number;
  maxDepth: number;
}

export class SubagentBudgetError extends Error {
  public constructor(
    public readonly code: "max_depth_exceeded" | "timeout_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "SubagentBudgetError";
  }
}

export function computeChildDepth(parentDepth: number | undefined): number {
  const base =
    typeof parentDepth === "number" && Number.isFinite(parentDepth) ? Math.max(0, Math.floor(parentDepth)) : 0;
  return base + 1;
}

export function enforceMaxDepth(input: ChildDepthInput): void {
  if (!Number.isFinite(input.maxDepth) || input.maxDepth < 1) {
    return;
  }
  if (input.depth >= input.maxDepth) {
    throw new SubagentBudgetError(
      "max_depth_exceeded",
      `max_depth_exceeded: depth=${input.depth} exceeds maxDepth=${input.maxDepth}`,
    );
  }
}

export interface ChildTimeoutInput<T> {
  timeoutSeconds: number;
  run: (signal: AbortSignal) => Promise<T>;
  onLateSettle?: (event: ChildTimeoutLateSettleEvent<T>) => Promise<void> | void;
}

export type ChildTimeoutLateSettleEvent<T> =
  | { status: "completed"; value: T; elapsedMs: number }
  | { status: "failed"; error: unknown; elapsedMs: number };

export async function runWithChildTimeout<T>(input: ChildTimeoutInput<T>): Promise<T> {
  if (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0) {
    return input.run(new AbortController().signal);
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.round(input.timeoutSeconds * 1000));
  const startedAt = Date.now();
  let timeoutHandle: NodeJS.Timeout | undefined;
  let timedOut = false;
  const runPromise = Promise.resolve().then(() => input.run(controller.signal));
  runPromise.then(
    (value) => {
      if (!timedOut) {
        return;
      }
      notifyLateSettle(input.onLateSettle, { status: "completed", value, elapsedMs: Date.now() - startedAt });
    },
    (error: unknown) => {
      if (!timedOut) {
        return;
      }
      notifyLateSettle(input.onLateSettle, { status: "failed", error, elapsedMs: Date.now() - startedAt });
    },
  );
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reject(
        new SubagentBudgetError(
          "timeout_exceeded",
          `timeout_exceeded: child run exceeded ${input.timeoutSeconds}s budget`,
        ),
      );
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function notifyLateSettle<T>(
  onLateSettle: ChildTimeoutInput<T>["onLateSettle"],
  event: ChildTimeoutLateSettleEvent<T>,
): void {
  if (!onLateSettle) {
    return;
  }
  void Promise.resolve()
    .then(() => onLateSettle(event))
    .catch(() => {
      // Late-settle diagnostics are best-effort and must not change timeout truth.
    });
}
