import type { ChatMode } from "@goatcitadel/contracts";
import {
  fetchChatSessions,
  fetchChatSessionSearch,
  type ChatSessionsResponse,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  projectChatSessionSearch,
  reconcileSidebarSessions,
  sidebarMembershipIncomplete,
  type ChatHistoryView,
} from "./chat-session-data-bootstrap";

export { fetchChatHistoryWindow, fetchChatHistoryContinuation } from "@goatcitadel/mission-control-shared/api/client";
export {
  historicalWindowIdentityMismatch,
  isHistoricalContinuationValid,
  mergeHistoricalContinuation,
} from "./chat-session-history-projection.js";

export { appendSidebarSessions } from "./chat-session-data-bootstrap";

interface SidebarPageRequest {
  workspaceId?: string;
  view: ChatHistoryView;
  query: string;
  limit: number;
  mode?: ChatMode;
  signal: AbortSignal;
}

export function readSidebarPage(request: SidebarPageRequest, cursor: string | undefined) {
  const { workspaceId, view, query, limit, mode, signal } = request;
  return query
    ? fetchChatSessionSearch(
        {
          query,
          mode: "discovery",
          view,
          limit,
          workspaceId,
          cursor,
          surface: mode,
          includeActivity: true,
        },
        { signal },
      ).then(projectChatSessionSearch)
    : fetchChatSessions(
        {
          scope: "all",
          view,
          limit,
          workspaceId,
          cursor,
          mode,
          includeActivity: true,
        },
        { signal },
      );
}

export async function reconcileSidebarPages(
  request: SidebarPageRequest,
  cursors: Array<string | undefined>,
  readRetained: () => ChatSessionsResponse | null,
  isCurrent: () => boolean,
) {
  const pages = await Promise.all(cursors.map((cursor) => readSidebarPage(request, cursor)));
  if (!isCurrent()) return;
  // Cursor absence doesn't prove that the retained conversation left this workspace or view.
  const retainedIds = readRetained()?.items.map((item) => item.sessionId) ?? [];
  const members = new Map<string, ChatSessionsResponse["items"][number]>();
  for (let offset = 0; offset < retainedIds.length; offset += 100) {
    const sessionIds = retainedIds.slice(offset, offset + 100);
    const response = await fetchChatSessions(
      {
        sessionIds,
        workspaceId: request.workspaceId,
        scope: "all",
        view: request.view,
        mode: request.mode,
        q: request.query || undefined,
        includeActivity: true,
      },
      { signal: request.signal },
    );
    if (!isCurrent()) return;
    if (sidebarMembershipIncomplete(response, sessionIds)) {
      throw new Error("Conversation membership could not be verified. The previous list is retained.");
    }
    for (const record of response.items) members.set(record.sessionId, record);
  }
  const records = new Map(pages.flatMap((page) => page.items).map((record) => [record.sessionId, record]));
  return (current: ChatSessionsResponse) => reconcileSidebarSessions(current, members, records);
}
