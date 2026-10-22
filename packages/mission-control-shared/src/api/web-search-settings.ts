import type {
  FirecrawlConnectionCheck,
  WebSearchCredentialStatus,
  WebSearchCredentialTargetId,
  WebSearchCredentialsResponse,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export interface WebSearchCredentialMutationResponse {
  status: WebSearchCredentialStatus;
  changePlanReceipt?: { planId: string; status: string; revision: number; summary: string };
}

/** Presence and source of each web-search key. Key values never leave the Gateway. */
export async function fetchWebSearchCredentials(
  options: { signal?: AbortSignal } = {},
): Promise<WebSearchCredentialsResponse> {
  return request<WebSearchCredentialsResponse>("/api/v1/settings/web/credentials", {
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Checks the key live, then stores it in the OS keychain through a governed Change Plan. */
export async function saveWebSearchCredential(
  targetId: WebSearchCredentialTargetId,
  apiKey: string,
  expectedRevision: number,
): Promise<WebSearchCredentialMutationResponse> {
  return request<WebSearchCredentialMutationResponse>(
    `/api/v1/settings/web/credentials/${encodeURIComponent(targetId)}`,
    { method: "PUT", body: JSON.stringify({ apiKey, expectedRevision }) },
  );
}

export async function clearWebSearchCredential(
  targetId: WebSearchCredentialTargetId,
  expectedRevision: number,
): Promise<WebSearchCredentialMutationResponse> {
  return request<WebSearchCredentialMutationResponse>(
    `/api/v1/settings/web/credentials/${encodeURIComponent(targetId)}`,
    { method: "DELETE", body: JSON.stringify({ expectedRevision }) },
  );
}

/** Read-only reachability and key check against the saved Firecrawl base URL. */
export async function checkFirecrawlConnection(): Promise<FirecrawlConnectionCheck> {
  return request<FirecrawlConnectionCheck>("/api/v1/settings/web/firecrawl/check", {
    method: "POST",
    body: JSON.stringify({}),
  });
}
