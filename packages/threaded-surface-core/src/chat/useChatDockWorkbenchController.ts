import type { ChatMessageRecord, ChatMode, ChatThreadResponse, OrchestrationRun } from "@goatcitadel/contracts";
import type { OrchestrationCheckpointRecord } from "@goatcitadel/mission-control-shared/api/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadView";
import { resolveActiveWorkflowTurn } from "@goatcitadel/mission-control-shared/components/cowork-view-model";
import { useRefreshSubscription } from "@goatcitadel/mission-control-shared/hooks/useRefreshSubscription";
import { deriveCoworkItems } from "./chat-page-derivations";
import { defaultDockOpenForMode } from "./surface-config";
import { useChatWorkbench } from "./useChatWorkbench";
import type { MissionControlDockSectionId } from "./useMissionControlSurfaceState";

function getViewportWidth(): number | undefined {
  return typeof window === "undefined" ? undefined : window.innerWidth;
}

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
  const [dockOpen, setDockOpen] = useState<boolean>(() =>
    defaultDockOpenForMode(input.messageMode, getViewportWidth()),
  );
  const [orchestrationRun, setOrchestrationRun] = useState<OrchestrationRun | null>(null);
  const [orchestrationCheckpoints, setOrchestrationCheckpoints] = useState<OrchestrationCheckpointRecord[]>([]);
  const [orchestrationLoading, setOrchestrationLoading] = useState(false);
  const [orchestrationError, setOrchestrationError] = useState<string | null>(null);

  const {
    workbenchState,
    workbenchTree,
    selectedWorkbenchFile,
    selectedWorkbenchFileDiff,
    workbenchDraftContent,
    workbenchExpandedPaths,
    workbenchDiff,
    workbenchOutput,
    workbenchLoading,
    workbenchBusy,
    workbenchSaving,
    workbenchError,
    hasDirtyWorkbenchDraft,
    setWorkbenchDraftContent,
    setWorkbenchExpandedPaths,
    refreshWorkbench,
    createWorkbenchWorktree,
    openWorkbenchFile,
    saveWorkbenchFile,
    runWorkbenchFileOperation,
    discardWorkbenchDraft,
    runWorkbenchValidationCommand,
    applyWorkbenchPatch,
    exportWorkbenchPatch,
    revertWorkbenchFile,
    revertWorkbenchAll,
  } = useChatWorkbench({
    sessionId: input.selectedSessionId,
    // Chat is the canonical home for the build editor. Keeping this keyed only
    // to the selected session also preserves legacy Code/Cowork compatibility.
    enabled: Boolean(input.selectedSession),
  });

  useEffect(() => {
    setDockOpen(defaultDockOpenForMode(input.messageMode, getViewportWidth()));
  }, [input.messageMode]);

  const activeWorkflowTurn = useMemo(() => {
    if (input.selectedTurn?.trace.orchestration) {
      return input.selectedTurn;
    }
    return resolveActiveWorkflowTurn(input.thread) ?? input.selectedTurn ?? null;
  }, [input.selectedTurn, input.thread]);
  const latestOrchestration = useMemo(
    () => activeWorkflowTurn?.trace.orchestration ?? input.thread?.turns.at(-1)?.trace.orchestration,
    [activeWorkflowTurn, input.thread],
  );
  const refreshOrchestrationRun = useCallback(async () => {
    setOrchestrationRun(null);
    setOrchestrationCheckpoints([]);
    setOrchestrationLoading(false);
    setOrchestrationError(null);
  }, []);

  useEffect(() => {
    void refreshOrchestrationRun();
  }, [refreshOrchestrationRun]);

  useRefreshSubscription(
    "chat",
    async () => {
      await refreshOrchestrationRun();
    },
    {
      enabled: false,
      coalesceMs: 800,
      staleMs: 20_000,
      pollIntervalMs: 15_000,
    },
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
    activeWorkflowTurn,
    workbenchState,
    workbenchTree,
    selectedWorkbenchFile,
    selectedWorkbenchFileDiff,
    workbenchDraftContent,
    workbenchExpandedPaths,
    workbenchDiff,
    workbenchOutput,
    workbenchLoading,
    workbenchBusy,
    workbenchSaving,
    workbenchError,
    hasDirtyWorkbenchDraft,
    setWorkbenchDraftContent,
    setWorkbenchExpandedPaths,
    refreshWorkbench,
    createWorkbenchWorktree,
    openWorkbenchFile,
    saveWorkbenchFile,
    runWorkbenchFileOperation,
    discardWorkbenchDraft,
    runWorkbenchValidationCommand,
    applyWorkbenchPatch,
    exportWorkbenchPatch,
    revertWorkbenchFile,
    revertWorkbenchAll,
    latestOrchestration,
    orchestrationRun,
    orchestrationCheckpoints,
    orchestrationLoading,
    orchestrationError,
    refreshOrchestrationRun,
    coworkItems,
    selectedSessionProjectValue,
    dockSectionStyle,
  };
}
