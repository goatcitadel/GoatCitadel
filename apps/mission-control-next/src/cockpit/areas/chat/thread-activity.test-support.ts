import { CHAT_SESSION_STATUS_VERSION, type ChatSessionStatusResponse, type ChatSessionStatusWork } from "@goatcitadel/contracts";
export function statusRecord(sessionId = "s", workspaceId = "w", work: Partial<ChatSessionStatusWork> = {}): ChatSessionStatusResponse {
  const unavailable = { availability: "unavailable" as const, reason: "Not needed by this display fixture" };
  return { schemaVersion: CHAT_SESSION_STATUS_VERSION, sessionId, workspaceId, generatedAt: "2026-10-01T00:00:00Z",
    work: { availability: "available", value: { latestTurn: null, turnCounts: { queued: 0, running: 0, waiting_for_tool: 0, waiting_for_approval: 0, waiting_for_user_input: 0 }, durableRuns: [], ...work } },
    model: unavailable, context: unavailable, attention: unavailable, orchestration: unavailable, capabilities: unavailable, usage: unavailable, build: unavailable };
}
