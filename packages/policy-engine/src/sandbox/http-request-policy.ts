const SAFE_RETRY_METHODS = new Set(["GET", "HEAD"]);
const NEVER_FORWARD_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "cookie", "cookie2"]);
const NEVER_FORWARD_HEADER_PATTERN =
  /(?:^|[-_])(?:api[-_]?key|(?:access|auth|csrf|session)[-_]?token|token|secret|credential|password)(?:$|[-_])/i;

export class HttpMutationOutcomeUnknownError extends Error {
  public readonly externalOutcome = "unknown_after_send" as const;
  public readonly manualReconciliationRequired = true;

  public constructor(operation: string, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    super(
      `${operation} unknown_after_send: the external mutation endpoint was contacted, but the final outcome is unknown; ` +
        `manual reconciliation is required. ${detail}`,
      error instanceof Error ? { cause: error } : undefined,
    );
    this.name = "HttpMutationOutcomeUnknownError";
  }
}

export function isHttpRequestSafeToRetry(init: Pick<RequestInit, "method"> | undefined): boolean {
  return SAFE_RETRY_METHODS.has(normalizeMethod(init?.method));
}

export function assertSafeRedirectTransition(
  currentUrl: string,
  nextUrl: string,
  init: RequestInit,
  trustedCrossOriginHeaders: readonly string[] = [],
): void {
  const currentOrigin = resolveOrigin(currentUrl);
  const nextOrigin = resolveOrigin(nextUrl);
  const method = normalizeMethod(init.method);
  const blockedReasons: string[] = [];
  if (!SAFE_RETRY_METHODS.has(method)) {
    blockedReasons.push(`method ${method}`);
  }
  if (init.body !== undefined && init.body !== null) {
    blockedReasons.push("request body");
  }
  if (blockedReasons.length > 0) {
    throw new Error(
      `Redirect blocked from ${currentOrigin} to ${nextOrigin}: ${blockedReasons.join(", ")} cannot be replayed automatically.`,
    );
  }
  if (currentOrigin === nextOrigin) {
    return;
  }

  const crossOriginReasons: string[] = [];
  if (init.credentials === "include") {
    crossOriginReasons.push("included credentials");
  }
  if (init.referrer || (init.referrerPolicy && init.referrerPolicy !== "no-referrer")) {
    crossOriginReasons.push("explicit referrer authority");
  }
  if (hasUntrustedRequestHeaders(init.headers, trustedCrossOriginHeaders)) {
    crossOriginReasons.push("caller-supplied headers");
  }
  if (crossOriginReasons.length === 0) {
    return;
  }

  throw new Error(
    `Cross-origin redirect blocked from ${currentOrigin} to ${nextOrigin}: ${crossOriginReasons.join(", ")} cannot be forwarded.`,
  );
}

function hasUntrustedRequestHeaders(headers: HeadersInit | undefined, trustedHeaderNames: readonly string[]): boolean {
  const trusted = new Set(trustedHeaderNames.map((name) => name.trim().toLowerCase()).filter(Boolean));
  let found = false;
  new Headers(headers).forEach((_value, name) => {
    const normalized = name.toLowerCase();
    if (
      NEVER_FORWARD_HEADER_NAMES.has(normalized) ||
      NEVER_FORWARD_HEADER_PATTERN.test(normalized) ||
      !trusted.has(normalized)
    ) {
      found = true;
    }
  });
  return found;
}

function normalizeMethod(method: string | undefined): string {
  return (method?.trim() || "GET").toUpperCase();
}

function resolveOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "<invalid-origin>";
  }
}
