import type { SseTokenIssueResponse } from "@goatcitadel/contracts";

import { request } from "./client-core.js";

export async function issueSseBridgeToken(scope: SseTokenIssueResponse["scope"]): Promise<SseTokenIssueResponse> {
  return request<SseTokenIssueResponse>("/api/v1/auth/sse-token", {
    method: "POST",
    body: JSON.stringify({ scope }),
  });
}

export function computeReconnectDelay(attempt: number): number {
  const clampedAttempt = Math.max(1, attempt);
  const base = Math.min(30_000, 1000 * 2 ** (clampedAttempt - 1));
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(30_000, base + jitter);
}
