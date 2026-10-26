import type { ChatMode } from "@goatcitadel/contracts";
import { fetchChatSessions, type ChatSessionsResponse } from "@goatcitadel/mission-control-shared/api/client";
import { findScopedSidebarSession, type ChatHistoryView } from "./chat-session-data-bootstrap";

/**
 * Reads one conversation named by the address or chosen from Messaging. It may be older than the first page, so
 * only that exact, visible, scoped owner is accepted; a missing, archived or foreign record yields null and never
 * selects a recent Chat. The read spans every scope because a conversation held through a channel is an external
 * session; `findScopedSidebarSession` decides which of those may be named.
 */
export async function readRouteSidebarSession(
  sessionId: string,
  scope: { workspaceId: string; view: ChatHistoryView; mode: ChatMode | undefined; signal: AbortSignal },
): Promise<ChatSessionsResponse["items"][number] | null> {
  const { workspaceId, view, mode, signal } = scope;
  const exact = await fetchChatSessions(
    { sessionId, workspaceId, scope: "all", view, mode, limit: 1, includeActivity: true },
    { signal },
  );
  return findScopedSidebarSession(exact, sessionId, workspaceId, view);
}
