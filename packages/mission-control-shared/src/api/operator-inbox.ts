import type {
  OperatorInboxReadResponse,
  OperatorInboxUpdateReference,
  OperatorInboxResponse,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export function fetchOperatorInbox(
  workspaceId: string,
  options: { signal?: AbortSignal } = {},
): Promise<OperatorInboxResponse> {
  const query = new URLSearchParams({ workspaceId });
  return request<OperatorInboxResponse>(
    `/api/v1/inbox?${query.toString()}`,
    options.signal ? { signal: options.signal } : undefined,
  );
}

export function markOperatorInboxUpdatesRead(
  workspaceId: string,
  updates: OperatorInboxUpdateReference[],
): Promise<OperatorInboxReadResponse> {
  return request<OperatorInboxReadResponse>("/api/v1/inbox/updates/read", {
    method: "POST",
    body: JSON.stringify({ workspaceId, updates }),
  });
}
