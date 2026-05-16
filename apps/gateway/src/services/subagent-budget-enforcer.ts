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
}

export async function runWithChildTimeout<T>(input: ChildTimeoutInput<T>): Promise<T> {
  if (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0) {
    return input.run(new AbortController().signal);
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.round(input.timeoutSeconds * 1000));
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(
        new SubagentBudgetError(
          "timeout_exceeded",
          `timeout_exceeded: child run exceeded ${input.timeoutSeconds}s budget`,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([input.run(controller.signal), timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
