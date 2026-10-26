import type { ChatMode } from "@goatcitadel/contracts";
import type { ChatSessionsResponse } from "@goatcitadel/mission-control-shared/api/client";
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { chatSidebarScopeKey } from "./chat-sidebar-scope-key";
import { readRouteSidebarSession } from "./chat-route-session-read";
import { appendMissingSidebarSession, type ChatHistoryView } from "./chat-session-data-bootstrap";
import { useCommitRefValue } from "./retained-reload";

/**
 * Lists a conversation the rail chose when the loaded page of the list does not hold it, for example a Messaging
 * conversation older than the first page. The read is the same exact, scoped one a deep link uses, so the chosen
 * conversation gets its header, its address, and survives a list refresh. Choosing one the list already holds
 * reads nothing. A failed read is ignored here (the API client has already recorded it): the conversation still
 * opens from its own id.
 */
export function useEnsureListedSession(input: {
  workspaceId: string;
  viewIdentity?: string;
  historyView: ChatHistoryView;
  surfaceMode: ChatMode | undefined;
  sessions: ChatSessionsResponse | null;
  setSessions: Dispatch<SetStateAction<ChatSessionsResponse | null>>;
}): (sessionId: string) => void {
  const { workspaceId, viewIdentity, historyView, surfaceMode, sessions, setSessions } = input;
  const scopeKey = chatSidebarScopeKey({ workspaceId, viewIdentity, surfaceMode, historyView, searchQuery: "" });
  const latest = useRef({ scopeKey, sessions });
  useCommitRefValue(latest, { scopeKey, sessions });
  const read = useRef<AbortController | null>(null);
  useEffect(() => () => read.current?.abort(), []);
  return useCallback(
    (sessionId: string) => {
      const { scopeKey: started, sessions: listed } = latest.current;
      if (!listed || listed.items.some((item) => item.sessionId === sessionId)) return;
      read.current?.abort();
      const controller = new AbortController();
      read.current = controller;
      const isCurrent = () =>
        read.current === controller && !controller.signal.aborted && latest.current.scopeKey === started;
      void readRouteSidebarSession(sessionId, {
        workspaceId,
        view: historyView,
        mode: surfaceMode,
        signal: controller.signal,
      })
        .then((record) => {
          if (!record || !isCurrent()) return;
          setSessions((current) =>
            current && isCurrent() ? appendMissingSidebarSession(current, sessionId, record) : current,
          );
        })
        .catch(() => {
          /* Non-fatal, and already recorded: the API client logs every failed request as a diagnostic. The chosen
             conversation still opens from its own id; it only lacks a list row until the next list read. */
        });
    },
    [workspaceId, historyView, surfaceMode, setSessions],
  );
}
