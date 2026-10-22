export const FIRECRAWL_UNREACHABLE_COOLDOWN_MS = 300_000;
const MAX_TRACKED_FIRECRAWL_ENDPOINTS = 32;

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
    super(
      `Firecrawl at ${describeEndpointHost(baseUrl)} is unreachable; skipping it for ${Math.round(
        FIRECRAWL_UNREACHABLE_COOLDOWN_MS / 60_000,
      )} minutes.`,
    );
    this.name = "FirecrawlUnavailableError";
  }
}

/** Host only: the base URL may carry a token in its userinfo, path, or query. */
function describeEndpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || "the configured endpoint";
  } catch {
    return "the configured endpoint";
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return baseUrl.slice(0, end);
}

export interface FirecrawlConnectFailureOptions {
  /** Count request timeouts as unreachability. Only the search endpoint may; see below. */
  countTimeouts?: boolean;
}

/**
 * True for connection-level failures (refused, reset, DNS, connect timeout) on any
 * endpoint, and for request timeouts only when `countTimeouts` is set.
 *
 * Timeouts count only for `/v2/search`: `/v2/scrape` replies after rendering the
 * target page, so a slow or hostile page can time out a healthy Firecrawl and must
 * not bench it for every caller.
 *
 * This matches on name/message text because fetchAllowlisted's `redactFetchError`
 * rebuilds every error as a plain `Error` and drops `cause`, so `cause.code`
 * never reaches callers. The real wrapped shapes are pinned in
 * firecrawl-reachability.test.ts ("matches the guard-wrapped refused connection",
 * "matches the guard's own timeout only when timeouts count"). The `cause.code`
 * branch covers unwrapped errors. A cancelled turn (`callerSignal.aborted`) is
 * never Firecrawl's fault.
 */
export function isFirecrawlConnectFailure(
  error: unknown,
  callerSignal?: AbortSignal,
  options: FirecrawlConnectFailureOptions = {},
): boolean {
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
    return options.countTimeouts === true;
  }
  const code = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === "string" && CONNECT_ERROR_CODES.has(code);
}

export function recordFirecrawlConnectFailure(baseUrl: string, now: number = Date.now()): void {
  for (const [key, until] of cooldownUntil) {
    if (now >= until) {
      cooldownUntil.delete(key);
    }
  }
  const key = normalizeBaseUrl(baseUrl);
  cooldownUntil.delete(key);
  while (cooldownUntil.size >= MAX_TRACKED_FIRECRAWL_ENDPOINTS) {
    const oldest = cooldownUntil.keys().next();
    if (oldest.done) {
      break;
    }
    cooldownUntil.delete(oldest.value);
  }
  cooldownUntil.set(key, now + FIRECRAWL_UNREACHABLE_COOLDOWN_MS);
}

export function recordFirecrawlSuccess(baseUrl: string): void {
  cooldownUntil.delete(normalizeBaseUrl(baseUrl));
}

export function isFirecrawlCoolingDown(baseUrl: string, now: number = Date.now()): boolean {
  const key = normalizeBaseUrl(baseUrl);
  const until = cooldownUntil.get(key);
  if (until === undefined) {
    return false;
  }
  if (now >= until) {
    cooldownUntil.delete(key);
    return false;
  }
  return true;
}

export function firecrawlTrackedEndpointCountForTests(): number {
  return cooldownUntil.size;
}

export function resetFirecrawlReachabilityForTests(): void {
  cooldownUntil.clear();
}
