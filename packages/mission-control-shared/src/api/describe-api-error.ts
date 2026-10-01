import { isApiRequestError } from "./http-internal.js";

export interface ApiErrorDescription {
  summary: string;
  technical?: string;
}

export const GATEWAY_UNREACHABLE_SUMMARY = "Can't reach the GoatCitadel gateway. Check that it's running, then try again.";
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
    return { summary: summaryForStatus(error.status, readBodyMessage(error.body)), technical };
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
  if (status === 401) return "Your gateway session expired. Sign in again to continue.";
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

function looksLikeTransportFailure(message: string): boolean {
  return /^network error\b/i.test(message) || /failed to fetch|networkerror|econnrefused|load failed/i.test(message);
}

function looksTechnical(message: string): boolean {
  return /\/api\/v\d+\//.test(message) ||
    /^(api|http) error \d{3}/i.test(message) ||
    /\b[A-Za-z]*Error:/.test(message) ||
    /\n\s+at\s/.test(message);
}
