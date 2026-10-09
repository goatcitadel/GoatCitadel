import { useEffect, useRef, useSyncExternalStore } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { getGatewayAccessRevision, getGatewayCallerScope, subscribeGatewayAccessChange, subscribeGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import type { ChatSessionRecord, ChatSessionSearchHitRecord } from "@goatcitadel/contracts";

/** Only the named Chat history anchor parameters are accepted; no arbitrary URL forwarding. */
export function parseChatHistoricalRoute(search: string, workspaceId: string): ChatSessionSearchHitRecord | null {
  const params = new URLSearchParams(search);
  const sessionId = params.get("sessionId")?.trim();
  const messageId = params.get("messageId")?.trim();
  const rawSequence = params.get("sequence") ?? "";
  const sequence = Number(rawSequence);
  if (!sessionId || !messageId || sessionId.length > 512 || messageId.length > 512
    || !/^[1-9][0-9]*$/.test(rawSequence) || !Number.isSafeInteger(sequence)) return null;
  return { workspaceId, sessionId, messageId, sequence, score: 0, excerpt: "" };
}

/** Replays an exact legacy-message read only after the scoped session owner is selected. */
export function useChatHistoricalRoute(input: {
  routeSearch: string; workspaceId: string; viewIdentity?: string;
  selectedSession: Pick<ChatSessionRecord, "sessionId" | "workspaceId"> | null;
  openHistoricalWindow: (sessionId: string, hit: ChatSessionSearchHitRecord) => Promise<boolean>;
  returnToLatest: () => void;
}) {
  const access = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, getGatewayAccessRevision);
  const caller = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScope, getGatewayCallerScope);
  const gateway = getGatewayApiBaseUrl();
  const applied = useRef<string | null>(null);
  const { routeSearch, workspaceId, viewIdentity, openHistoricalWindow, returnToLatest } = input;
  const selectedSessionId = input.selectedSession?.sessionId;
  const selectedWorkspaceId = input.selectedSession?.workspaceId;
  useEffect(() => {
    const target = parseChatHistoricalRoute(routeSearch, workspaceId);
    if (!target) {
      if (applied.current) returnToLatest();
      applied.current = null; return;
    }
    if (selectedSessionId !== target.sessionId || selectedWorkspaceId !== target.workspaceId) return;
    const key = JSON.stringify([gateway, caller, access, viewIdentity, target.workspaceId, target.sessionId, target.messageId, target.sequence]);
    if (applied.current === key) return;
    applied.current = key;
    void openHistoricalWindow(target.sessionId, target);
  }, [gateway, caller, access, routeSearch, workspaceId, viewIdentity, selectedSessionId, selectedWorkspaceId, openHistoricalWindow, returnToLatest]);
}
