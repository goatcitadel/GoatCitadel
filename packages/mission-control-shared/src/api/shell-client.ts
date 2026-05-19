import type {
  ApprovalRequest,
  ApprovalResolveInput,
  DeviceAccessRequestCreateInput,
  DeviceAccessRequestCreateResponse,
  DeviceAccessRequestStatusResponse,
  WorkspaceRecord,
} from "@goatcitadel/contracts";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import type { EventStreamConnectionState, EventStreamStatus } from "./client.js";
import type {
  GatewayAccessPreflightResult,
  GatewayAccessPreflightStatus,
  GatewayAuthState,
  GatewayAuthStorageMode,
  GatewayBootstrapResult,
  GatewayStartupPhaseTiming,
  GatewayStartupTiming,
} from "./client-core.js";
import {
  clearGatewayAuthState,
  consumeGatewayAccessBootstrapFromLocation,
  getGatewayApiBaseUrl,
  getGatewayAuthStorageMode,
  persistGatewayAuthState,
  preflightGatewayAccess,
  readStoredGatewayAuthState,
  request,
  setGatewayAuthStorageMode,
} from "./client-core.js";
import { connectEventStream } from "./client.js";
import { isTrustedGatewayHost } from "./http-internal.js";

type ApprovalResolveRequestInput = Omit<ApprovalResolveInput, "resolvedBy"> & {
  resolvedBy?: never;
};

export type { RealtimeEvent, GatewayAuthState, GatewayAuthStorageMode, GatewayBootstrapResult };
export type {
  GatewayAccessPreflightResult,
  GatewayAccessPreflightStatus,
  GatewayStartupPhaseTiming,
  GatewayStartupTiming,
};
export type { EventStreamConnectionState, EventStreamStatus };
export {
  clearGatewayAuthState,
  connectEventStream,
  consumeGatewayAccessBootstrapFromLocation,
  getGatewayApiBaseUrl,
  getGatewayAuthStorageMode,
  isTrustedGatewayHost,
  persistGatewayAuthState,
  preflightGatewayAccess,
  readStoredGatewayAuthState,
  setGatewayAuthStorageMode,
};

export interface WorkspacesResponse {
  items: WorkspaceRecord[];
  view?: "active" | "archived" | "all";
}

export async function fetchWorkspaces(
  view: "active" | "archived" | "all" = "active",
  limit = 200,
): Promise<WorkspacesResponse> {
  const query = new URLSearchParams({
    view,
    limit: String(Math.max(1, Math.min(limit, 500))),
  });
  return request<WorkspacesResponse>(`/api/v1/workspaces?${query.toString()}`);
}

export async function createGatewayDeviceAccessRequest(
  input: DeviceAccessRequestCreateInput,
): Promise<DeviceAccessRequestCreateResponse> {
  return request<DeviceAccessRequestCreateResponse>("/api/v1/auth/device-requests", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function pollGatewayDeviceAccessRequestStatus(
  requestId: string,
  requestSecret: string,
): Promise<DeviceAccessRequestStatusResponse> {
  return request<DeviceAccessRequestStatusResponse>(
    `/api/v1/auth/device-requests/${encodeURIComponent(requestId)}/status`,
    {
      headers: {
        "x-goatcitadel-device-request-secret": requestSecret,
      },
    },
  );
}

export async function resolveApproval(
  approvalId: string,
  input: ApprovalResolveRequestInput,
): Promise<{ approval: ApprovalRequest }> {
  return request<{ approval: ApprovalRequest }>(`/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function resolveApprovalWithRemoteToken(
  token: string,
  decision: "approve" | "reject",
): Promise<{ approval: ApprovalRequest }> {
  return request<{ approval: ApprovalRequest }>("/api/v1/approvals/remote-resolve", {
    method: "POST",
    body: JSON.stringify({
      token,
      decision,
    }),
  });
}
