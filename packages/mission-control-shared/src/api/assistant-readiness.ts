import type { AssistantReadinessResponse, AssistantSetupReviewInput, ChangePlanRecord } from "@goatcitadel/contracts";
import { request } from "./client-core.js";
export function fetchAssistantReadiness(sessionId: string, workspaceId?: string) {
  const query = workspaceId ? `?${new URLSearchParams({ workspaceId })}` : "";
  return request<AssistantReadinessResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/assistant-readiness${query}`,
  );
}
export function prepareAssistantSetup({ sessionId, ...input }: AssistantSetupReviewInput) {
  return request<ChangePlanRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/assistant-readiness/setup`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
