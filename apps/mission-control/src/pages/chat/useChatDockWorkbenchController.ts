import type { ChatMessageRecord, ChatMode, ChatThreadResponse } from "@goatcitadel/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatThreadNotice } from "../../components/chat/ChatThreadView";
import { deriveCoworkItems } from "./chat-page-derivations";
import { defaultDockOpenForMode } from "./surface-config";
import { useChatWorkbench } from "./useChatWorkbench";
import type { MissionControlDockSectionId } from "./useMissionControlSurfaceState";

export function useChatDockWorkbenchController(input: {
  messageMode: ChatMode;
  selectedSessionId: string | null;
  selectedSession: { projectId?: string | null } | null;
  selectedTurn: ChatThreadResponse["turns"][number] | null;
  thread: ChatThreadResponse | null;
  messages: ChatMessageRecord[];
  localNotices: ChatThreadNotice[];
  dockSectionOrder: MissionControlDockSectionId[];
}) {
  const [dockOpen, setDockOpen] = useState<boolean>(() => defaultDockOpenForMode(input.messageMode));

  const {
    workbenchState,
    workbenchTree,
    selectedWorkbenchFile,
    workbenchDiff,
    workbenchOutput,
    workbenchLoading,
    workbenchBusy,
    workbenchError,
    refreshWorkbench,
    createWorkbenchWorktree,
    openWorkbenchFile,
  } = useChatWorkbench({
    sessionId: input.selectedSessionId,
    enabled: Boolean(input.selectedSession && (input.messageMode === "code" || input.messageMode === "cowork")),
  });

  useEffect(() => {
    setDockOpen(defaultDockOpenForMode(input.messageMode));
  }, [input.messageMode]);

  const latestOrchestration = useMemo(
    () => input.selectedTurn?.trace.orchestration ?? input.thread?.turns.at(-1)?.trace.orchestration,
    [input.selectedTurn, input.thread],
  );
  const coworkItems = useMemo(
    () => deriveCoworkItems(input.messages, input.localNotices, latestOrchestration),
    [input.localNotices, input.messages, latestOrchestration],
  );
  const selectedSessionProjectValue = input.selectedSession?.projectId ?? "none";
  const dockSectionStyle = useCallback(
    (sectionId: MissionControlDockSectionId) => ({
      order: Math.max(0, input.dockSectionOrder.indexOf(sectionId)),
    }),
    [input.dockSectionOrder],
  );

  return {
    dockOpen,
    setDockOpen,
    workbenchState,
    workbenchTree,
    selectedWorkbenchFile,
    workbenchDiff,
    workbenchOutput,
    workbenchLoading,
    workbenchBusy,
    workbenchError,
    refreshWorkbench,
    createWorkbenchWorktree,
    openWorkbenchFile,
    latestOrchestration,
    coworkItems,
    selectedSessionProjectValue,
    dockSectionStyle,
  };
}
