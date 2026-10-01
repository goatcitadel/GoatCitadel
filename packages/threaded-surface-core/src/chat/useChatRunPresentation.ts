import { useMemo } from "react";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { AgenticRunTreeResponse } from "@goatcitadel/mission-control-shared/api/agentic";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import { deriveCoworkRunViewModel } from "../cowork-view-model";
import {
  formatWorkProviderModelSummary,
  type ThreadedGatewayStatusSummary,
  type WorkTrustDescriptor,
} from "./work-trust";
import {
  formatRoutingTargetSummary,
  formatFallbackSummary,
  formatRuntimeSummary,
  formatSelectionSourceSummary,
  formatThreadedRunStateLabel,
  formatThreadedRunStateSummary,
  formatAgenticBackgroundHandoffSummary,
  formatAgenticBackgroundHandoffNotice,
} from "./mission-threaded-controller-helpers";
import { useChatDelegatedScopeControls } from "./useChatDelegatedScopeControls";
import type { useChatDockWorkbenchController } from "./useChatDockWorkbenchController";
import type { useChatProviderRoutingController } from "./useChatProviderRoutingController";
import type { useChatContextActions } from "./useChatContextActions";
import type { useChatRoutePreflight } from "./useChatRoutePreflight";

type Input = Pick<
  ReturnType<typeof useChatProviderRoutingController>,
  | "providerOptions"
  | "selectedProviderLabel"
  | "selectedModelLabel"
  | "requestedProviderLabel"
  | "requestedModelLabel"
  | "selectionSourceLabel"
  | "runtimeSummary"
  | "runtimeTone"
> & {
  workbenchController: Pick<
    ReturnType<typeof useChatDockWorkbenchController>,
    | "activeWorkflowTurn"
    | "orchestrationCheckpoints"
    | "coworkItems"
    | "latestOrchestration"
    | "orchestrationRun"
    | "orchestrationLoading"
    | "orchestrationError"
    | "workbenchState"
  >;
  currentRoutePreflight: ReturnType<typeof useChatRoutePreflight>["result"];
  activeDelegationRun: ReturnType<typeof useChatContextActions>["activeDelegationRun"];
  selectedTurn: ChatThreadTurnRecord | null;
  selectedSessionId: string | null;
  pushLocalNotice: (content: string, tone?: ChatThreadNotice["tone"]) => void;
  agenticRunTree: AgenticRunTreeResponse | null;
  workTrust?: WorkTrustDescriptor;
  workspaceName: string;
  gatewayStatus?: ThreadedGatewayStatusSummary;
  approvalsCount: number;
  activeModePreset: { label: string };
};

/** Display-only summaries of existing routing, durable execution, and delegation owners. */
export function useChatRunPresentation({
  providerOptions,
  selectedProviderLabel,
  selectedModelLabel,
  requestedProviderLabel,
  requestedModelLabel,
  selectionSourceLabel,
  runtimeSummary,
  runtimeTone,
  workbenchController,
  currentRoutePreflight,
  activeDelegationRun,
  selectedTurn,
  selectedSessionId,
  pushLocalNotice,
  agenticRunTree,
  workTrust,
  workspaceName,
  gatewayStatus,
  approvalsCount,
  activeModePreset,
}: Input) {
  const {
    activeWorkflowTurn,
    orchestrationCheckpoints,
    coworkItems,
    latestOrchestration,
    orchestrationRun,
    orchestrationLoading,
    orchestrationError,
    workbenchState,
  } = workbenchController;
  const providerLabelById = useMemo(
    () => new Map(providerOptions.map((provider) => [provider.providerId, provider.label])),
    [providerOptions],
  );
  const activeRouting = activeWorkflowTurn?.trace.routing;
  const requestedProviderModelSummary = activeRouting
    ? formatRoutingTargetSummary(providerLabelById, activeRouting.primaryProviderId, activeRouting.primaryModel)
    : currentRoutePreflight
      ? formatRoutingTargetSummary(
          providerLabelById,
          currentRoutePreflight.requestedProviderId,
          currentRoutePreflight.requestedModel,
        )
      : formatWorkProviderModelSummary(requestedProviderLabel, requestedModelLabel);
  const effectiveProviderModelSummary = activeRouting
    ? formatRoutingTargetSummary(
        providerLabelById,
        activeRouting.effectiveProviderId ?? activeRouting.primaryProviderId,
        activeRouting.effectiveModel ?? activeWorkflowTurn?.trace.model ?? activeRouting.primaryModel,
      )
    : currentRoutePreflight
      ? formatRoutingTargetSummary(
          providerLabelById,
          currentRoutePreflight.effectiveProviderId ?? currentRoutePreflight.requestedProviderId,
          currentRoutePreflight.effectiveModel ?? currentRoutePreflight.requestedModel,
        )
      : formatWorkProviderModelSummary(selectedProviderLabel, selectedModelLabel);
  const preflightFallback = formatFallbackSummary(currentRoutePreflight);
  const fallbackSummary = activeRouting?.fallbackUsed
    ? activeRouting.fallbackReason
      ? `Fallback used · ${activeRouting.fallbackReason}`
      : "Fallback used"
    : activeRouting?.fallbackProviderId || activeRouting?.fallbackModel || activeRouting?.fallbackReason
      ? activeRouting?.fallbackReason
        ? `Fallback armed · ${activeRouting.fallbackReason}`
        : "Fallback armed"
      : preflightFallback.summary;
  const fallbackTone = activeRouting?.fallbackUsed
    ? "warning"
    : activeRouting?.fallbackProviderId || activeRouting?.fallbackModel || activeRouting?.fallbackReason
      ? "warning"
      : preflightFallback.tone;
  const preflightRuntime = formatRuntimeSummary(currentRoutePreflight);
  const selectionSourceSummary = currentRoutePreflight
    ? formatSelectionSourceSummary(currentRoutePreflight.selectionSource)
    : selectionSourceLabel;
  const selectedExplorerParent = Boolean(
    activeDelegationRun?.explorer &&
    activeDelegationRun.attachedTurnId &&
    activeDelegationRun.attachedTurnId === selectedTurn?.turnId,
  );
  const visibleDelegationRun =
    activeDelegationRun?.attachedTurnId &&
    activeWorkflowTurn &&
    activeDelegationRun.attachedTurnId !== activeWorkflowTurn.turnId &&
    !selectedExplorerParent
      ? null
      : activeDelegationRun;
  const delegatedScopeControls = useChatDelegatedScopeControls({
    sessionId: selectedSessionId,
    delegationRun: visibleDelegationRun,
    pushLocalNotice,
  });
  const visibleRunStateLabel = formatThreadedRunStateLabel(activeWorkflowTurn, visibleDelegationRun);
  const visibleRunStateSummary = formatThreadedRunStateSummary(activeWorkflowTurn, visibleDelegationRun);
  const backgroundHandoffRunStateSummary = formatAgenticBackgroundHandoffSummary(agenticRunTree, visibleDelegationRun);
  const lifecycleNotices = useMemo<ChatThreadNotice[]>(() => {
    const notices: ChatThreadNotice[] = [];
    const activeTrace = activeWorkflowTurn?.trace;
    const timestamp = activeWorkflowTurn?.assistantMessage?.timestamp ?? new Date().toISOString();
    const backgroundHandoffNotice = formatAgenticBackgroundHandoffNotice(agenticRunTree, visibleDelegationRun);
    if (backgroundHandoffNotice) {
      notices.push({
        id: `lifecycle-agentic-handoff-${agenticRunTree?.runId ?? "active"}`,
        tone: "neutral",
        content: backgroundHandoffNotice,
        timestamp: agenticRunTree?.generatedAt ?? timestamp,
      });
    }
    if (activeTrace?.routing.fallbackUsed) {
      notices.push({
        id: `lifecycle-fallback-${activeWorkflowTurn?.turnId ?? "active"}`,
        tone: "warning",
        content: activeTrace.routing.fallbackReason
          ? `Fallback used for this turn: ${activeTrace.routing.fallbackReason}`
          : "Fallback provider/model routing was used for this turn.",
        timestamp,
      });
    }
    if (activeTrace?.status === "waiting_for_approval") {
      notices.push({
        id: `lifecycle-approval-${activeWorkflowTurn?.turnId ?? "active"}`,
        tone: "warning",
        content: "Run is paused for approval. Respond to the blocker to let durable execution resume.",
        timestamp,
      });
    }
    if (activeTrace?.status === "waiting_for_user_input") {
      notices.push({
        id: `lifecycle-user-input-${activeWorkflowTurn?.turnId ?? "active"}`,
        tone: "neutral",
        content: "Run is waiting on operator input before it can continue.",
        timestamp,
      });
    }
    if (activeTrace?.completion?.repaired) {
      notices.push({
        id: `lifecycle-repair-${activeWorkflowTurn?.turnId ?? "active"}`,
        tone: "warning",
        content: "Final assistant output was repaired before completion was recorded.",
        timestamp,
      });
    }
    const latestCheckpoint = orchestrationCheckpoints.at(-1);
    if (latestCheckpoint?.checkpointKind === "run_resumed") {
      notices.push({
        id: `lifecycle-resumed-${latestCheckpoint.checkpointId}`,
        tone: "success",
        content: "Durable execution resumed after a pause or approval gate.",
        timestamp: latestCheckpoint.createdAt,
      });
    } else if (latestCheckpoint?.checkpointKind === "run_paused_for_approval") {
      notices.push({
        id: `lifecycle-paused-${latestCheckpoint.checkpointId}`,
        tone: "warning",
        content: "Durable execution paused for approval and is waiting for operator action.",
        timestamp: latestCheckpoint.createdAt,
      });
    }
    for (const diagnostic of agenticRunTree?.diagnostics.slice(0, 2) ?? []) {
      notices.push({
        id: `lifecycle-diagnostic-${diagnostic.signalId}`,
        tone:
          diagnostic.severity === "critical" ? "critical" : diagnostic.severity === "warning" ? "warning" : "neutral",
        content: diagnostic.summary?.trim() || diagnostic.title,
        timestamp: agenticRunTree?.generatedAt ?? timestamp,
      });
    }
    return notices;
  }, [activeWorkflowTurn, agenticRunTree, orchestrationCheckpoints, visibleDelegationRun]);
  const coworkViewModel = useMemo(
    () =>
      deriveCoworkRunViewModel({
        items: coworkItems,
        orchestration: latestOrchestration ?? undefined,
        orchestrationRun,
        orchestrationCheckpoints,
        orchestrationLoading,
        orchestrationError,
        executionPlan: activeWorkflowTurn?.trace.executionPlan,
        delegationRun: visibleDelegationRun,
        activeTurn: activeWorkflowTurn,
        selectedTurn,
        workbenchState,
        agenticRunTree,
      }),
    [
      activeWorkflowTurn,
      agenticRunTree,
      coworkItems,
      latestOrchestration,
      orchestrationCheckpoints,
      orchestrationError,
      orchestrationLoading,
      orchestrationRun,
      selectedTurn,
      visibleDelegationRun,
      workbenchState,
    ],
  );
  const sessionTrust = useMemo<WorkTrustDescriptor>(
    () =>
      workTrust ?? {
        workspaceLabel: workspaceName,
        // Missing trust state is a signal, not a neutral fact — render it as a
        // warning so it does not blend in with the healthy chips around it.
        gatewayTone: gatewayStatus?.tone ?? "warning",
        gatewayLabel: gatewayStatus?.label ?? "Gateway state unavailable",
        gatewayDetail:
          gatewayStatus?.detail ??
          "Mission Control has not received shell gateway status for this threaded surface yet.",
        approvalsSummary:
          approvalsCount > 0 ? `${approvalsCount} decision${approvalsCount === 1 ? "" : "s"}` : "Decisions clear",
        runStateSummary: visibleRunStateSummary ?? backgroundHandoffRunStateSummary,
        activeModeLabel: activeModePreset.label,
        providerModelSummary: effectiveProviderModelSummary,
        requestedProviderModelSummary,
        effectiveProviderModelSummary,
        selectionSourceSummary,
        fallbackSummary,
        fallbackTone,
        runtimeSummary: currentRoutePreflight ? preflightRuntime.summary : runtimeSummary,
        runtimeTone: currentRoutePreflight ? preflightRuntime.tone : runtimeTone,
      },
    [
      activeModePreset.label,
      approvalsCount,
      currentRoutePreflight,
      effectiveProviderModelSummary,
      fallbackSummary,
      fallbackTone,
      gatewayStatus?.detail,
      gatewayStatus?.label,
      gatewayStatus?.tone,
      preflightRuntime.summary,
      preflightRuntime.tone,
      requestedProviderModelSummary,
      runtimeSummary,
      runtimeTone,
      selectionSourceSummary,
      backgroundHandoffRunStateSummary,
      visibleRunStateSummary,
      workTrust,
      workspaceName,
    ],
  );
  return {
    providerLabelById,
    visibleDelegationRun,
    delegatedScopeControls,
    visibleRunStateLabel,
    lifecycleNotices,
    coworkViewModel,
    sessionTrust,
  };
}
