import type { ChatContinuationInput, PreparedChatContinuation } from "@goatcitadel/contracts";
import { request } from "./client-core.js";
export function fetchChatContinuation(input: ChatContinuationInput) {
  const { sessionId, ...query } = input;
  return request<PreparedChatContinuation>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/continuations?${new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === "string"))}`,
  );
}
export function prepareChatContinuation(input: ChatContinuationInput & { expectedSourceHash: string }) {
  const { sessionId, ...body } = input;
  return request<PreparedChatContinuation>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/continuations`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
