import { useCallback, useEffect, useRef } from "react";
import type { ChatMode, ChatSessionRecord } from "@goatcitadel/contracts";
import { createChatSession, fetchChatSessionStatus, type ChatSessionsResponse } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  assertChatSessionCreated, beginChatSessionCreation, chatSessionCreationKey,
  publishChatSessionCreation, readChatSessionCreation, useChatSessionCreation,
  type ChatSessionCreation,
} from "@goatcitadel/mission-control-shared/state/chat-session-creation";
import type { ChatHistoryView } from "./useChatSessionData";

const navigationEvents = ["popstate", "hashchange", "goatcitadel:cockpit-location", "goatcitadel:classic-location"];

export function useManualChatSessionCreation(input: {
  workspaceId: string;
  /** Presentation identity only; never partitions the shared creation lock. */
  viewIdentity?: string;
  selectedProjectId: string;
  selectedSessionId: string | null;
  historyView: ChatHistoryView;
  setSessions: React.Dispatch<React.SetStateAction<ChatSessionsResponse | null>>;
  setHistoryView: React.Dispatch<React.SetStateAction<ChatHistoryView>>;
  setSelectedSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setError: (message: string | null) => void;
  onSessionCreated?: (session: ChatSessionRecord) => void;
}) {
  const installation = getGatewayApiBaseUrl();
  const key = chatSessionCreationKey(installation, input.workspaceId);
  const identity = JSON.stringify([key, input.viewIdentity, input.selectedProjectId, input.selectedSessionId, input.historyView]);
  const view = useRef({ identity });
  if (view.current.identity !== identity) view.current = { identity };
  const renderedView = view.current;
  const navigation = useRef({});
  const renderedNavigation = navigation.current;
  const origin = typeof window === "undefined" ? null : window.location.href;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const invalidate = () => { navigation.current = {}; };
    if (typeof window !== "undefined") navigationEvents.forEach((event) => window.addEventListener(event, invalidate));
    return () => {
      mounted.current = false;
      if (typeof window !== "undefined") navigationEvents.forEach((event) => window.removeEventListener(event, invalidate));
    };
  }, []);
  const attempt = useChatSessionCreation(key);
  const current = useCallback(() => mounted.current && view.current === renderedView && navigation.current === renderedNavigation
    && getGatewayApiBaseUrl() === installation && (typeof window === "undefined" ? null : window.location.href) === origin, [installation, origin, renderedNavigation, renderedView]);
  const setError = input.setError;
  useEffect(() => {
    if (attempt?.state === "unknown") setError(attempt.message);
  }, [attempt?.state, attempt?.message, setError]);

  async function create(mode: ChatMode) {
    if (!current()) return;
    const pending: ChatSessionCreation = { state: "pending", mode, message: "Creating one conversation. Waiting for the Gateway…" };
    if (!beginChatSessionCreation(key, pending)) {
      const retained = readChatSessionCreation(key);
      if (current() && retained) input.setError(retained.message);
      return;
    }
    input.setError(null);
    const projectId = ["all", "none"].includes(input.selectedProjectId) ? undefined : input.selectedProjectId;
    let created: ChatSessionRecord;
    try {
      created = await createChatSession(
        projectId ? { workspaceId: input.workspaceId, projectId, mode } : { workspaceId: input.workspaceId, mode },
        { originSurface: mode },
      );
      assertChatSessionCreated(created, input.workspaceId, projectId);
      pending.sessionId = created.sessionId;
      const saved = await fetchChatSessionStatus(created.sessionId, new AbortController().signal);
      if (getGatewayApiBaseUrl() !== installation || saved.sessionId !== created.sessionId || saved.workspaceId !== input.workspaceId) {
        throw new Error("The independent conversation read does not match the creation owner.");
      }
      pending.state = "confirmed";
      pending.message = "Conversation created and independently verified.";
      publishChatSessionCreation(key, pending);
    } catch (cause) {
      pending.state = "unknown";
      pending.message = `Creation outcome is unconfirmed. Check conversation history before creating another; this app will not retry. ${describeApiError(cause).summary}`;
      publishChatSessionCreation(key, pending);
      if (current()) input.setError(pending.message);
      return;
    }
    if (!current()) return;
    // The normal selected-session effect owns hydration. A later preferred-sidebar
    // response must not restore this session over a newer operator selection.
    const historyView = input.historyView === "archived" ? "active" : input.historyView;
    input.setSessions((previous) => ({ ...previous, items: [created, ...(previous?.items ?? []).filter((item) =>
      item.sessionId !== created.sessionId && item.workspaceId === input.workspaceId && item.lifecycleStatus === historyView)] }));
    input.setHistoryView(historyView);
    input.setSelectedSessionId(created.sessionId);
    try { input.onSessionCreated?.(created); }
    catch {
      // A failed presentation callback cannot undo independently verified storage.
      pending.message = "Conversation created and verified. Open it from conversation history.";
      publishChatSessionCreation(key, pending);
      if (current()) input.setError(pending.message);
    }
  }

  return { create, isCurrent: current, creatingSessionMode: attempt?.state === "checking" || attempt?.state === "pending" ? attempt.mode : null };
}
