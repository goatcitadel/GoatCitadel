import type {
  GoogleWorkspaceOAuthCompleteInput,
  GoogleWorkspaceOAuthDisconnectResult,
  GoogleWorkspaceOAuthStartInput,
  GoogleWorkspaceOAuthStartResponse,
  GoogleWorkspaceOAuthStatus,
} from "@goatcitadel/contracts";

import { request } from "./client-core.js";

const base = (connectionId: string) =>
  `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}/google-oauth`;

export async function fetchGoogleWorkspaceOAuthStatus(connectionId: string): Promise<GoogleWorkspaceOAuthStatus> {
  return request<GoogleWorkspaceOAuthStatus>(base(connectionId));
}

export async function startGoogleWorkspaceOAuth(
  connectionId: string,
  input: GoogleWorkspaceOAuthStartInput,
): Promise<GoogleWorkspaceOAuthStartResponse> {
  return request<GoogleWorkspaceOAuthStartResponse>(`${base(connectionId)}/start`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function completeGoogleWorkspaceOAuth(
  connectionId: string,
  input: GoogleWorkspaceOAuthCompleteInput,
): Promise<GoogleWorkspaceOAuthStatus> {
  return request<GoogleWorkspaceOAuthStatus>(`${base(connectionId)}/complete`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function disconnectGoogleWorkspaceOAuth(
  connectionId: string,
): Promise<GoogleWorkspaceOAuthDisconnectResult> {
  return request<GoogleWorkspaceOAuthDisconnectResult>(`${base(connectionId)}/disconnect`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
