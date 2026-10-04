import type { CheckResult } from "./types";

export const EVIDENCE_CHAR_LIMIT = 4_000;

export class CheckAssertionError extends Error {
  readonly evidence: unknown;

  constructor(message: string, evidence?: unknown) {
    super(message);
    this.name = "CheckAssertionError";
    this.evidence = evidence;
  }
}

export function ensure(condition: unknown, message: string, evidence?: unknown): asserts condition {
  if (!condition) {
    throw new CheckAssertionError(message, evidence);
  }
}

export function pass(summary: string, evidence?: unknown): CheckResult {
  return evidence === undefined ? { status: "pass", summary } : { status: "pass", summary, evidence };
}

export function fail(summary: string, evidence?: unknown): CheckResult {
  return evidence === undefined ? { status: "fail", summary } : { status: "fail", summary, evidence };
}

export interface WaitForOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly label: string;
}

export async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options: WaitForOptions,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  const interval = options.intervalMs ?? 500;
  let last = await read();
  while (!done(last)) {
    if (Date.now() >= deadline) {
      throw new CheckAssertionError(
        `${options.label} did not happen within ${Math.max(1, Math.round(options.timeoutMs / 1000))} s.`,
        summarizeEvidence(last),
      );
    }
    await sleep(interval, options.signal);
    last = await read();
  }
  return last;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function summarizeEvidence(value: unknown, limit = EVIDENCE_CHAR_LIMIT): unknown {
  if (value === undefined) {
    return undefined;
  }
  let text: string | undefined;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    // Fallback for values JSON cannot encode (for example cycles): show their string form.
    text = String(value);
  }
  if (text === undefined || text.length <= limit) {
    return value;
  }
  return `${text.slice(0, limit)}… (${text.length - limit} more characters)`;
}
