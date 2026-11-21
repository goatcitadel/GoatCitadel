import type {
  CronJobRecord,
  FollowThroughActionInput,
  FollowThroughResponse,
  FollowThroughSetupInput,
  FollowThroughSetupResponse,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";
export function fetchFollowThrough(sessionId: string, workspaceId: string) {
  return request<FollowThroughResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/follow-through?${new URLSearchParams({ workspaceId })}`,
  );
}
export function requestFollowThroughAction({ sessionId, ...input }: FollowThroughActionInput) {
  return request<FollowThroughResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/follow-through/actions`,
    { method: "POST", body: JSON.stringify(input) },
  );
}
export function fetchFollowThroughSetup(sessionId: string, workspaceId: string) {
  return request<FollowThroughSetupResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/follow-through/setup?${new URLSearchParams({ workspaceId })}`,
  );
}
export function createFollowThroughSetup({ sessionId, ...input }: FollowThroughSetupInput) {
  return request<CronJobRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/follow-through/setup`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
