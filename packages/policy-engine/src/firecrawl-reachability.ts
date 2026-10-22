export const FIRECRAWL_UNREACHABLE_COOLDOWN_MS = 300_000;

const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// baseUrl (trailing slashes trimmed) -> epoch ms until which Firecrawl is skipped.
const cooldownUntil = new Map<string, number>();

export class FirecrawlUnavailableError extends Error {
  constructor(baseUrl: string) {
    super(`Firecrawl at ${baseUrl} is unreachable; skipping it for 5 minutes.`);
    this.name = "FirecrawlUnavailableError";
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return baseUrl.slice(0, end);
}

/**
 * True for connection-level failures only (refused, reset, DNS, timeout).
 *
 * This matches on name/message text because fetchAllowlisted's `redactFetchError`
 * rebuilds every error as a plain `Error` and drops `cause`, so `cause.code`
 * never reaches callers. The real wrapped shapes are pinned in
 * firecrawl-reachability.test.ts ("matches the guard-wrapped refused connection",
 * "matches the guard's own timeout"). The `cause.code` branch covers unwrapped
 * errors. A cancelled turn (`callerSignal.aborted`) is never Firecrawl's fault.
 */
export function isFirecrawlConnectFailure(error: unknown, callerSignal?: AbortSignal): boolean {
  if (callerSignal?.aborted) {
    return false;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "TypeError" && error.message === "fetch failed") {
    return true;
  }
  if (error.message === "fetchAllowlisted timed out" || error.name === "TimeoutError") {
    return true;
  }
  const code = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === "string" && CONNECT_ERROR_CODES.has(code);
}

export function recordFirecrawlConnectFailure(baseUrl: string, now: number = Date.now()): void {
  cooldownUntil.set(normalizeBaseUrl(baseUrl), now + FIRECRAWL_UNREACHABLE_COOLDOWN_MS);
}

export function recordFirecrawlSuccess(baseUrl: string): void {
  cooldownUntil.delete(normalizeBaseUrl(baseUrl));
}

export function isFirecrawlCoolingDown(baseUrl: string, now: number = Date.now()): boolean {
  const until = cooldownUntil.get(normalizeBaseUrl(baseUrl));
  return until !== undefined && now < until;
}

export function resetFirecrawlReachabilityForTests(): void {
  cooldownUntil.clear();
}
