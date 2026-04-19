import type { ChatMessageRecord, ChatMode, ChatThreadResponse } from "@goatcitadel/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatThreadNotice } from "../../components/chat/ChatThreadView";
import { fetchOrchestrationRun, fetchOrchestrationRunCheckpoints } from "../../api/platform";
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

  const latestOrchestration = useMemo(
    () => input.selectedTurn?.trace.orchestration ?? input.thread?.turns.at(-1)?.trace.orchestration,
    [input.selectedTurn, input.thread],
  );
  const canonicalOrchestrationRunId = latestOrchestration?.runId?.trim() || undefined;

  useEffect(() => {
    if (input.messageMode !== "cowork" || !canonicalOrchestrationRunId) {
      setOrchestrationRun(null);
      setOrchestrationCheckpoints([]);
      setOrchestrationLoading(false);
      setOrchestrationError(null);
      return;
    }

    let cancelled = false;
    setOrchestrationLoading(true);
    setOrchestrationError(null);

    void Promise.all([
      fetchOrchestrationRun(canonicalOrchestrationRunId),
      fetchOrchestrationRunCheckpoints(canonicalOrchestrationRunId),
    ])
      .then(([run, checkpoints]) => {
        if (cancelled) {
          return;
        }
        setOrchestrationRun(run);
        setOrchestrationCheckpoints(checkpoints.items);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setOrchestrationRun(null);
        setOrchestrationCheckpoints([]);
        setOrchestrationError(error instanceof Error ? error.message : "Failed to load orchestration run.");
      })
      .finally(() => {
        if (!cancelled) {
          setOrchestrationLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [canonicalOrchestrationRunId, input.messageMode]);

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
    orchestrationRun,
    orchestrationCheckpoints,
    orchestrationLoading,
    orchestrationError,
    coworkItems,
    selectedSessionProjectValue,
    dockSectionStyle,
  };
}
