import type { ChatMessageRecord, ChatMode, ChatThreadResponse } from "@goatcitadel/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatThreadNotice } from "../../components/chat/ChatThreadView";
import { fetchOrchestrationRun, fetchOrchestrationRunCheckpoints } from "../../api/platform";
import { resolveActiveWorkflowTurn } from "../../components/cowork-view-model";
import { useRefreshSubscription } from "../../hooks/useRefreshSubscription";
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
  const [orchestrationRun, setOrchestrationRun] = useState<Awaited<ReturnType<typeof fetchOrchestrationRun>> | null>(
    null,
  );
  const [orchestrationCheckpoints, setOrchestrationCheckpoints] = useState<
    Awaited<ReturnType<typeof fetchOrchestrationRunCheckpoints>>["items"]
  >([]);
  const [orchestrationLoading, setOrchestrationLoading] = useState(false);
  const [orchestrationError, setOrchestrationError] = useState<string | null>(null);

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
  const canonicalOrchestrationRunId = latestOrchestration?.runId?.trim() || undefined;

  const refreshOrchestrationRun = useCallback(async () => {
    if (input.messageMode !== "cowork" || !canonicalOrchestrationRunId) {
      setOrchestrationRun(null);
      setOrchestrationCheckpoints([]);
      setOrchestrationLoading(false);
      setOrchestrationError(null);
      return;
    }

    setOrchestrationLoading(true);
    setOrchestrationError(null);
    try {
      const [runResult, checkpointResult] = await Promise.allSettled([
        fetchOrchestrationRun(canonicalOrchestrationRunId),
        fetchOrchestrationRunCheckpoints(canonicalOrchestrationRunId),
      ]);

      if (runResult.status === "fulfilled") {
        setOrchestrationRun(runResult.value);
      }
      if (checkpointResult.status === "fulfilled") {
        setOrchestrationCheckpoints(checkpointResult.value.items);
      }

      if (runResult.status === "rejected" || checkpointResult.status === "rejected") {
        const failedParts = [
          ...(runResult.status === "rejected" ? ["run"] : []),
          ...(checkpointResult.status === "rejected" ? ["checkpoints"] : []),
        ];
        const prefix =
          failedParts.length === 2
            ? "Orchestration refresh failed while loading "
            : "Orchestration refresh partially failed while loading ";
        const suffix =
          failedParts.length === 2
            ? "run data and checkpoints."
            : failedParts[0] === "run"
              ? "run data."
              : "checkpoints.";
        setOrchestrationError(`${prefix}${suffix}`);
      }
    } finally {
      setOrchestrationLoading(false);
    }
  }, [canonicalOrchestrationRunId, input.messageMode]);

  useEffect(() => {
    void refreshOrchestrationRun();
  }, [refreshOrchestrationRun]);

  useRefreshSubscription(
    "chat",
    async () => {
      await refreshOrchestrationRun();
    },
    {
      enabled: input.messageMode === "cowork" && Boolean(canonicalOrchestrationRunId),
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
    workbenchDiff,
    workbenchOutput,
    workbenchLoading,
    workbenchBusy,
    workbenchError,
    refreshWorkbench,
    createWorkbenchWorktree,
    openWorkbenchFile,
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
