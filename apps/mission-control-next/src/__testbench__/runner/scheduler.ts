import type { TargetInfo } from "../gateway-target/detect-target";
import { classifyError } from "./classify";
import { checkPermission } from "./policy";
import type { RunEndReason, RunEvent } from "./state";
import { DEFAULT_CHECK_TIMEOUT_MS, type CheckContext, type CheckDef, type RunOptions } from "./types";

export interface RunSeed {
  readonly workspaceId: string;
}

export interface RunChecksInput {
  readonly checks: readonly CheckDef[];
  readonly target: TargetInfo;
  readonly options: RunOptions;
  readonly signal: AbortSignal;
  readonly emit: (event: RunEvent) => void;
  /** Seeds the per-run workspace; called once when an allowed check needs it. */
  readonly seed?: (signal: AbortSignal) => Promise<RunSeed>;
  readonly readConcurrency?: number;
  readonly now?: () => number;
}

interface ExecutionDeps {
  readonly target: TargetInfo;
  readonly workspaceId: string | undefined;
  readonly signal: AbortSignal;
  readonly emit: (event: RunEvent) => void;
  readonly now: () => number;
  readonly onUnreachable: (summary: string) => void;
}

interface PreparedRun {
  readonly runnable: readonly CheckDef[];
  readonly workspaceId: string | undefined;
}

export const DEFAULT_READ_CONCURRENCY = 4;

export async function runChecks(input: RunChecksInput): Promise<RunEndReason> {
  const now = input.now ?? Date.now;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", forwardAbort, { once: true });
  const halt = { unreachable: undefined as string | undefined };
  const onUnreachable = (summary: string) => {
    halt.unreachable ??= summary;
    controller.abort();
  };
  input.emit({ type: "run-started", checkIds: input.checks.map((check) => check.id), at: iso(now()) });
  const prepared = await prepareRun(filterAllowed(input), input, controller.signal, onUnreachable);
  const deps: ExecutionDeps = {
    target: input.target,
    workspaceId: prepared.workspaceId,
    signal: controller.signal,
    emit: input.emit,
    now,
    onUnreachable,
  };
  const reads = prepared.runnable.filter((check) => check.tier === "read");
  const serial = prepared.runnable.filter((check) => check.tier !== "read");
  await runPool(
    reads,
    input.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
    (check) => executeCheck(check, deps),
    controller.signal,
  );
  for (const check of serial) {
    if (controller.signal.aborted) {
      break;
    }
    await executeCheck(check, deps);
  }
  input.signal.removeEventListener("abort", forwardAbort);
  const reason: RunEndReason =
    halt.unreachable !== undefined ? "unreachable" : input.signal.aborted ? "stopped" : "completed";
  input.emit({ type: "run-finished", at: iso(now()), reason, banner: halt.unreachable });
  return reason;
}

function filterAllowed(input: RunChecksInput): CheckDef[] {
  const allowed: CheckDef[] = [];
  for (const check of input.checks) {
    const permission = checkPermission(check, input.target, input.options);
    if (permission.allowed) {
      allowed.push(check);
    } else {
      input.emit({ type: "check-skipped", checkId: check.id, reason: permission.reason });
    }
  }
  return allowed;
}

async function prepareRun(
  allowed: readonly CheckDef[],
  input: RunChecksInput,
  signal: AbortSignal,
  onUnreachable: (summary: string) => void,
): Promise<PreparedRun> {
  const needing = allowed.filter((check) => check.needsWorkspace === true);
  if (needing.length === 0) {
    return { runnable: allowed, workspaceId: undefined };
  }
  const blockNeeding = (summary: string): PreparedRun => {
    for (const check of needing) {
      input.emit({ type: "check-finished", checkId: check.id, status: "blocked", summary, durationMs: 0 });
    }
    return { runnable: allowed.filter((check) => check.needsWorkspace !== true), workspaceId: undefined };
  };
  if (!input.seed || input.target.kind !== "sandbox") {
    return blockNeeding("No seeded test workspace is available on this target.");
  }
  try {
    const seeded = await input.seed(signal);
    return { runnable: allowed, workspaceId: seeded.workspaceId };
  } catch (error) {
    const classified = classifyError(error);
    if (classified.status === "unreachable") {
      onUnreachable(classified.summary);
    }
    return blockNeeding(`Could not seed a test workspace: ${classified.summary}`);
  }
}

async function executeCheck(check: CheckDef, deps: ExecutionDeps): Promise<void> {
  if (deps.signal.aborted) {
    return;
  }
  const startedAt = deps.now();
  deps.emit({ type: "check-started", checkId: check.id, at: iso(startedAt) });
  const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS)]);
  const finish = (status: "pass" | "fail" | "blocked" | "cancelled", summary: string, evidence?: unknown) =>
    deps.emit({
      type: "check-finished",
      checkId: check.id,
      status,
      summary,
      evidence,
      durationMs: Math.max(0, deps.now() - startedAt),
    });
  try {
    const result = await raceAbort(check.run(createContext(check.id, deps, signal)), signal);
    finish(result.status, result.summary, result.evidence);
  } catch (error) {
    const classified = classifyError(error);
    if (classified.status === "unreachable") {
      deps.onUnreachable(classified.summary);
      finish("fail", classified.summary, classified.evidence);
      return;
    }
    finish(classified.status, classified.summary, classified.evidence);
  }
}

function createContext(checkId: string, deps: ExecutionDeps, signal: AbortSignal): CheckContext {
  return {
    target: deps.target,
    workspaceId: deps.workspaceId,
    signal,
    log(message: string, data?: unknown) {
      deps.emit({ type: "check-logged", checkId, entry: { at: iso(deps.now()), message, data } });
    },
    async step<T>(title: string, run: () => Promise<T>): Promise<T> {
      deps.emit({ type: "step-started", checkId, title });
      try {
        const value = await run();
        deps.emit({ type: "step-finished", checkId, title, status: "pass" });
        return value;
      } catch (error) {
        deps.emit({ type: "step-finished", checkId, title, status: "fail" });
        throw error;
      }
    },
  };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!signal.aborted) {
      const item = items[next];
      next += 1;
      if (item === undefined) {
        return;
      }
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}
