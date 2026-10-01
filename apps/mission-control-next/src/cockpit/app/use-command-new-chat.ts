import { useEffect, useRef } from "react";
import { createChatSession, fetchChatSessionStatus } from "@goatcitadel/mission-control-shared/api/chat";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { assertPaletteWorkspace, type PaletteScope } from "./command-palette-search";

export interface CommandCreationReview {
  isCurrent: () => boolean;
  onCreated?: (sessionId: string) => void;
}

export { resetChatSessionCreationForTests as resetCommandNewChatForTests } from "@goatcitadel/mission-control-shared/state/chat-session-creation";
import {
  abandonChatSessionCreation, assertChatSessionCreated, beginChatSessionCreation,
  chatSessionCreationBlocked, chatSessionCreationKey, publishChatSessionCreation,
  useChatSessionCreation, type ChatSessionCreation,
} from "@goatcitadel/mission-control-shared/state/chat-session-creation";

/** One explicit creation. A lost POST acknowledgement stays locked across palette remounts. */
export function useCommandNewChat(scope: PaletteScope, open: boolean, onCreated: (sessionId: string) => void) {
  // Reparenting a workspace cannot release its pending or unknown creation.
  const installation = getGatewayApiBaseUrl();
  const key = chatSessionCreationKey(installation, scope.workspaceId);
  const viewKey = JSON.stringify([key, scope.citadelId]);
  const view = useRef({ key: viewKey, open });
  if (view.current.key !== viewKey || view.current.open !== open) view.current = { key: viewKey, open };
  const renderedView = view.current;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const attempt = useChatSessionCreation(key);
  const blocked = chatSessionCreationBlocked(attempt);
  async function create(review?: CommandCreationReview) {
    const current = () => mounted.current && view.current === renderedView && getGatewayApiBaseUrl() === installation && (review?.isCurrent() ?? true);
    if (!current() || !open || !scope.workspaceId || !scope.citadelId) return;
    const pending: ChatSessionCreation = { state: "checking", mode: "chat", message: "Verifying the selected workspace…" };
    if (!beginChatSessionCreation(key, pending)) return;
    let dispatched = false;
    try {
      await assertPaletteWorkspace(scope);
      if (!current()) {
        abandonChatSessionCreation(key, pending);
        return;
      }
      pending.state = "pending";
      pending.message = "Creating one conversation. Waiting for the Gateway…";
      publishChatSessionCreation(key, pending);
      dispatched = true;
      const created = await createChatSession(
        { ...scope, mode: "chat", includeInHistory: true },
        { originSurface: "chat" },
      );
      assertChatSessionCreated(created, scope.workspaceId);
      pending.sessionId = created.sessionId;
      const saved = await fetchChatSessionStatus(created.sessionId, new AbortController().signal);
      if (getGatewayApiBaseUrl() !== installation || saved.sessionId !== created.sessionId || saved.workspaceId !== scope.workspaceId)
        throw new Error("The independent conversation read does not match the creation receipt.");
      await assertPaletteWorkspace(scope);
      if (getGatewayApiBaseUrl() !== installation) throw new Error("The Gateway installation changed during verification.");
      pending.state = "confirmed";
      pending.message = "Conversation created and independently verified.";
      publishChatSessionCreation(key, pending);
    } catch (cause) {
      pending.state = dispatched ? "unknown" : "error";
      pending.message = dispatched
        ? `Creation outcome is unconfirmed. Check conversation history before creating another; this palette will not retry. ${describeApiError(cause).summary}`
        : describeApiError(cause).summary;
      publishChatSessionCreation(key, pending);
    }
    if (pending.state === "confirmed" && pending.sessionId && current()) {
      try {
        (review?.onCreated ?? onCreated)(pending.sessionId);
      } catch {
        // Presentation failure does not undo an independently verified creation.
        pending.message =
          "Conversation created and independently verified. Opening it failed; use Open created conversation.";
        publishChatSessionCreation(key, pending);
      }
    }
  }
  return { attempt, blocked, create };
}
