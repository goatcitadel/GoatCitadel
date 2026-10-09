import { isApiRequestError } from "./http-internal.js";

export interface ApiErrorDescription {
  summary: string;
  technical?: string;
  category?: "authentication" | "permission" | "feature_disabled" | "conflict" | "transient";
  retryable?: boolean;
}

export const GATEWAY_UNREACHABLE_SUMMARY =
  "Can't reach the GoatCitadel gateway. Check that it's running, then try again.";
const DEFAULT_FALLBACK = "Something went wrong. Try again.";

/** Keep request paths, stack traces, and transport details out of operator copy. */
export function describeApiError(error: unknown, fallback = DEFAULT_FALLBACK): ApiErrorDescription {
  if (isApiRequestError(error)) {
    const technical = `${error.method} ${error.path}${error.status ? ` (${error.status})` : ""}: ${error.message}`;
    if (error.kind === "network") {
      return { summary: GATEWAY_UNREACHABLE_SUMMARY, technical };
    }
    if (error.kind === "protocol") {
      return { summary: "The gateway sent a response Mission Control couldn't read. Try again.", technical };
    }
    if (error.status === 401) {
      return { summary: summaryForStatus(401, undefined), technical, category: "authentication", retryable: false };
    }
    if (error.status === 403) {
      return { summary: "You don't have permission to do that. Review Settings > Access before trying again. Anonymous access in auth-none mode cannot use protected operator actions; signed-in callers still need permission.", technical, category: "permission", retryable: false };
    }
    if (error.status === 409 && readDisabledFeatureFlag(error.body)) {
      return { summary: "This feature is turned off for this installation.", technical, category: "feature_disabled", retryable: false };
    }
    return { summary: summaryForStatus(error.status, readBodyMessage(error.body)), technical,
      ...(error.status === 409 ? { category: "conflict" as const, retryable: true } : {}),
      ...(error.status !== undefined && error.status >= 500 ? { category: "transient" as const, retryable: true } : {}) };
  }

  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = message.trim();
  if (!trimmed) {
    return { summary: fallback };
  }
  if (looksLikeTransportFailure(trimmed)) {
    return { summary: GATEWAY_UNREACHABLE_SUMMARY, technical: trimmed };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { summary: "The request timed out. Try again.", technical: trimmed };
  }
  if (looksTechnical(trimmed)) {
    return { summary: fallback, technical: trimmed };
  }
  return { summary: trimmed };
}

function summaryForStatus(status: number | undefined, bodyMessage: string | undefined): string {
  if (status === 401) return "Gateway credentials are missing or expired. Sign in again through Settings > Access to continue.";
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "That item no longer exists. Refresh to see the latest.";
  if (status === 409) return "This changed somewhere else. Refresh and try again.";
  if (status === 413) return "That's too large to send.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status !== undefined && status >= 500) return "The gateway hit an error. Try again, or check System health.";
  if (bodyMessage && !looksTechnical(bodyMessage)) return bodyMessage;
  return "The gateway couldn't complete that request.";
}

function readBodyMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Accept the public contract and older Gateways' flagged conflicts. */
function readDisabledFeatureFlag(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as { code?: unknown; details?: unknown };
  if ((record.code !== "FEATURE_DISABLED" && record.code !== "STATE_CONFLICT") || !record.details || typeof record.details !== "object") return undefined;
  const flag = (record.details as { flag?: unknown }).flag;
  return typeof flag === "string" && flag.trim() ? flag : undefined;
}

function looksLikeTransportFailure(message: string): boolean {
  return /^network error\b/i.test(message) || /failed to fetch|networkerror|econnrefused|load failed/i.test(message);
}

function looksTechnical(message: string): boolean {
  return (
    /\/api\/v\d+\//.test(message) ||
    /^(api|http) error \d{3}/i.test(message) ||
    /\b[A-Za-z]*Error:/.test(message) ||
    /\n\s+at\s/.test(message)
  );
}
