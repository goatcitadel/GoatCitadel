import type { ChatTimerListResponse, ChatTimerMutationResponse, CreateChatTimerInput } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchChatTimers(sessionId: string): Promise<ChatTimerListResponse> {
  return request<ChatTimerListResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/timers`, {
    cache: "no-store",
  });
}

export async function createChatTimer(
  sessionId: string,
  input: CreateChatTimerInput,
): Promise<ChatTimerMutationResponse> {
  return request<ChatTimerMutationResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/timers`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function cancelChatTimer(
  sessionId: string,
  timerId: string,
  expectedRevision: number,
): Promise<ChatTimerMutationResponse> {
  return request<ChatTimerMutationResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/timers/${encodeURIComponent(timerId)}`,
    { method: "DELETE", body: JSON.stringify({ expectedRevision }) },
  );
}
