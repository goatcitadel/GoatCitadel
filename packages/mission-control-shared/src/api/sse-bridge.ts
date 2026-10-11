import type { SseTokenIssueResponse, SseTokenlessResponse } from "@goatcitadel/contracts";

import { request } from "./client-core.js";
import { isApiRequestError } from "./http-internal";

const SSE_BRIDGE_NOT_NEEDED_ERROR = "SSE token bridge is not needed when auth mode is none";

export async function issueSseBridgeToken(scope: SseTokenIssueResponse["scope"]): Promise<SseTokenIssueResponse> {
  return request<SseTokenIssueResponse>("/api/v1/auth/sse-token", {
    method: "POST",
    body: JSON.stringify({ scope }),
  });
}

/**
 * Auth mode none on a current Gateway: `200 { scope, authMode: "none" }` with no
 * token. Callers treat it exactly like `isSseBridgeNotNeededError` (the legacy
 * 400): clear stale stored auth and open the stream without `sse_token`.
 */
export function isTokenlessSseBridgeResponse(issued: SseTokenIssueResponse): issued is SseTokenlessResponse {
  return !("token" in issued) && issued.authMode === "none";
}

export function isSseBridgeNotNeededError(error: unknown): boolean {
  if (!isApiRequestError(error) || error.status !== 400) {
    return false;
  }
  const bodyError =
    error.body && typeof error.body === "object" && "error" in error.body
      ? String((error.body as { error?: unknown }).error)
      : "";
  return bodyError === SSE_BRIDGE_NOT_NEEDED_ERROR || error.bodyText?.includes(SSE_BRIDGE_NOT_NEEDED_ERROR) === true;
}

export function computeReconnectDelay(attempt: number): number {
  const clampedAttempt = Math.max(1, attempt);
  const base = Math.min(30_000, 1000 * 2 ** (clampedAttempt - 1));
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(30_000, base + jitter);
}
