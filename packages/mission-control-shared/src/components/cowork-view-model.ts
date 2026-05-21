import type {
  ChatExecutionPlanRecord,
  ChatOrchestrationSummary,
  ChatSessionWorkbenchRecord,
  ChatThreadResponse,
  ChatThreadTurnRecord,
  ContinuationGateDecision,
  AgenticControlAction,
  AgenticControlResponse,
  AgenticRunTreeResponse,
  OrchestrationRun,
} from "@goatcitadel/contracts";
import type { OrchestrationCheckpointRecord } from "../api/types";
import type { ActiveChatDelegationRun } from "../pages/chat/useChatDelegationPolicyActions";
import { describeChatUiError } from "../pages/chat/chat-error-copy";
import type { CoworkTaskItem } from "./cowork-types";

const CHECKPOINT_LABELS: Record<OrchestrationCheckpointRecord["checkpointKind"], string> = {
  run_created: "Run created",
  durable_run_linked: "Durable worker linked",
  worktree_allocated: "Worktree allocated",
  run_queued: "Run queued",
  run_started: "Run started",
  run_paused_for_approval: "Paused for approval",
  run_resumed: "Run resumed",
  continuation_gate: "Continuation gate",
  phase_approved: "Approval recorded",
  phase_executed: "Phase completed",
  wave_advanced: "Advanced to next wave",
  run_completed: "Run completed",
  run_stopped: "Run stopped by limit",
  run_failed: "Run failed",
  run_cancelled: "Run cancelled",
};

const MAX_VISIBLE_PLAN_STEPS = 3;
const MAX_VISIBLE_ROLE_ITEMS = 3;
const MAX_VISIBLE_TIMELINE_ITEMS = 3;
const MAX_VISIBLE_OUTPUT_ITEMS = 3;

export type CoworkPrimaryActionKind =
  | "focus_composer"
  | "review_run_details"
  | "refresh_run_state"
  | "retry_turn"
  | "open_tasks";

export interface CoworkViewItem {
  id: string;
  title: string;
  status?: string;
  meta?: string;
  note?: string;
}

export interface CoworkRunMapNode {
  id: string;
  label: string;
  status: string;
  meta?: string;
}

export interface CoworkAgenticControlItem extends CoworkViewItem {
  action: AgenticControlAction;
  enabled: boolean;
  requiresApproval?: boolean;
  runtimeEffect?: AgenticControlResponse["runtimeEffect"];
}

export interface CoworkAgenticRuntimeSummary {
  runId: string;
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
  diagnostics: CoworkViewItem[];
  controls: CoworkAgenticControlItem[];
  treeNodes: CoworkRunMapNode[];
}

export interface CoworkRunViewModel {
  empty: boolean;
  activeTurnId: string | null;
  selectedTurnId: string | null;
  hasHistoricalSelection: boolean;
  headerTitle: string;
  headerSummary: string;
  sourceLabel: string;
  freshnessLabel: string;
  completenessLabel: string;
  selectionLabel?: string;
  stageCards: Array<{ label: string; value: string }>;
  now: {
    label: string;
    title: string;
    summary: string;
    facts: Array<{ label: string; value: string }>;
  };
  nextAction: {
    kind: CoworkPrimaryActionKind;
    label: string;
    note: string;
  } | null;
  blockers: Array<{
    id: string;
    title: string;
    summary: string;
    raw?: string;
  }>;
  operatorActionItems: {
    items: CoworkViewItem[];
    overflow: number;
  };
  planItems: {
    items: CoworkViewItem[];
    overflow: number;
  };
  roleItems: {
    items: CoworkViewItem[];
    overflow: number;
  };
  timelineItems: {
    items: CoworkViewItem[];
    overflow: number;
  };
  outputItems: {
    items: CoworkViewItem[];
    overflow: number;
  };
  continuationGate: ContinuationGateDecision;
  runMap: {
    objective: string;
    currentState: string;
    nextAction: string;
    planNodes: CoworkRunMapNode[];
    checkpoints: CoworkViewItem[];
  };
  stateGaps: string[];
  evidenceSummary: {
    label: string;
    detail: string;
    toolCallCount: number;
    checkpointCount: number;
    evidenceGapCount: number;
  };
  agenticRuntime?: CoworkAgenticRuntimeSummary;
  raw: {
    activeTurn: ChatThreadTurnRecord | null;
    selectedTurn: ChatThreadTurnRecord | null;
    orchestration?: ChatOrchestrationSummary | null;
    orchestrationRun?: OrchestrationRun | null;
    orchestrationCheckpoints: OrchestrationCheckpointRecord[];
    executionPlan?: ChatExecutionPlanRecord;
    delegationRun?: ActiveChatDelegationRun | null;
    workbenchState?: ChatSessionWorkbenchRecord | null;
    orchestrationError?: string | null;
    agenticRunTree?: AgenticRunTreeResponse | null;
  };
}

type CoworkBlocker = CoworkRunViewModel["blockers"][number];

function humanizeStatus(value?: string | null): string {
  if (!value) {
    return "unknown";
  }
  return value.replaceAll("_", " ");
}

function formatExecutionState(value?: string | null): string {
  switch (value) {
    case "worktree_allocating":
      return "allocating worktree";
    case "worktree_ready":
      return "worktree ready";
    case "paused_for_approval":
      return "paused for approval";
    case "resume_requested":
      return "resume queued";
    case "stopped_by_limit":
      return "stopped by limit";
    default:
      return value?.replaceAll("_", " ") ?? "not linked";
  }
}

function normalizeSummary(value?: string | null, maxLength = 160): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function limitItems<T>(items: T[], maxVisible: number): { items: T[]; overflow: number } {
  return {
    items: items.slice(0, maxVisible),
    overflow: Math.max(0, items.length - maxVisible),
  };
}

function humanizePhaseLabel(value?: string | null, prefix = "Phase"): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/(\d+)$/);
  if (match) {
    return `${prefix} ${match[1]}`;
  }
  return `${prefix} ${humanizeStatus(value)}`;
}

function describeSelectionState(input: {
  selectedTurn: ChatThreadTurnRecord | null;
  activeTurn: ChatThreadTurnRecord | null;
}): string | undefined {
  if (!input.selectedTurn || !input.activeTurn || input.selectedTurn.turnId === input.activeTurn.turnId) {
    return undefined;
  }
  return "Selected historical turn details are open in the dock while the board stays pinned to the active run.";
}

export const formatCoworkFriendlyError = describeChatUiError;

function buildCheckpointMeta(checkpoint: OrchestrationCheckpointRecord): string | undefined {
  const parts = [humanizePhaseLabel(checkpoint.phaseId), humanizePhaseLabel(checkpoint.waveId, "Wave")].filter(
    (value): value is string => Boolean(value),
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function buildAgenticRuntimeSummary(
  agenticRunTree?: AgenticRunTreeResponse | null,
): CoworkAgenticRuntimeSummary | undefined {
  if (!agenticRunTree) {
    return undefined;
  }
  return {
    runId: agenticRunTree.runId,
    generatedAt: agenticRunTree.generatedAt,
    nodeCount: agenticRunTree.nodes.length,
    edgeCount: agenticRunTree.edges.length,
    diagnostics: agenticRunTree.diagnostics.slice(0, 3).map((diagnostic) => ({
      id: diagnostic.signalId,
      title: diagnostic.title,
      status: diagnostic.severity,
      meta: diagnostic.code.replaceAll("_", " "),
      note: normalizeSummary(diagnostic.summary, 120),
    })),
    controls: agenticRunTree.controls.slice(0, 4).map((control) => ({
      id: control.action,
      title: control.label,
      action: control.action,
      enabled: control.enabled,
      requiresApproval: control.requiresApproval,
      runtimeEffect: control.runtimeEffect,
      status: control.enabled ? "available" : "disabled",
      meta:
        [
          control.runtimeEffect ? control.runtimeEffect.replaceAll("_", " ") : undefined,
          control.requiresApproval ? "approval required" : undefined,
        ]
          .filter((value): value is string => Boolean(value))
          .join(" · ") || undefined,
      note: control.reason,
    })),
    treeNodes: agenticRunTree.nodes.slice(0, 8).map((node) => ({
      id: node.id,
      label: node.label,
      status: humanizeStatus(node.status),
      meta: node.kind,
    })),
  };
}

function outputItemsMissingProof(workbenchState?: ChatSessionWorkbenchRecord | null): boolean {
  return workbenchState ? workbenchState.validationStatus !== "passed" : false;
}

function buildDelegationOutputTitle(status?: ActiveChatDelegationRun["status"]): string {
  switch (status) {
    case "completed":
      return "Stitched result available";
    case "partial":
      return "Partial stitched result available";
    case "failed":
      return "Failed delegation output available";
    case "running":
    default:
      return "Delegation output still in progress";
  }
}

function buildDelegationOutputNote(status?: ActiveChatDelegationRun["status"]): string {
  switch (status) {
    case "completed":
      return "Open run details to inspect the completed stitched delegation result.";
    case "partial":
      return "Open run details before treating the stitched delegation output as final.";
    case "failed":
      return "Open run details to inspect failure evidence and any partial output.";
    case "running":
    default:
      return "Open run details to inspect current delegated work; final synthesis is not ready yet.";
  }
}

function buildDelegationCompletenessLabel(status?: ActiveChatDelegationRun["status"]): string {
  switch (status) {
    case "completed":
      return "Completeness: delegation complete";
    case "partial":
      return "Completeness: delegation partial";
    case "failed":
      return "Completeness: delegation failed";
    case "running":
      return "Completeness: delegation running";
    default:
      return "Completeness: delegation status unknown";
  }
}

function isDelegationContinuationFailure(step?: ActiveChatDelegationRun["steps"][number]): boolean {
  if (!step || step.status !== "failed") {
    return false;
  }
  const text = `${step.error ?? ""} ${step.failureGuidance ?? ""}`.toLowerCase();
  return /\btool(?:-|\s*)run budget\b|tool_run_budget_exceeded|\bnot yet allowlisted\b|\bnot allowlisted\b|\ballowlist\b|\bblocked source\b|\bcurrent tool-run budget\b/.test(
    text,
  );
}

function readContinuationGateFromCheckpoint(
  checkpoints: OrchestrationCheckpointRecord[],
): ContinuationGateDecision | undefined {
  const gateCheckpoint = [...checkpoints]
    .reverse()
    .find((checkpoint) => checkpoint.checkpointKind === "continuation_gate");
  const candidate = gateCheckpoint?.details.continuationGate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  const record = candidate as Partial<ContinuationGateDecision>;
  if (
    typeof record.decision !== "string" ||
    !["continue", "checkpoint", "throttle", "pause", "stop"].includes(record.decision) ||
    !record.metrics ||
    typeof record.metrics !== "object"
  ) {
    return undefined;
  }
  return {
    decision: record.decision as ContinuationGateDecision["decision"],
    reasonCodes: Array.isArray(record.reasonCodes)
      ? record.reasonCodes.filter((value): value is string => typeof value === "string")
      : [],
    summary: typeof record.summary === "string" ? record.summary : `Continuation gate: ${record.decision}.`,
    metrics: {
      stepsSinceCheckpoint: Number(record.metrics.stepsSinceCheckpoint ?? 0),
      toolRunCount: Number(record.metrics.toolRunCount ?? 0),
      failedToolRunCount: Number(record.metrics.failedToolRunCount ?? 0),
      retryFailureStreak: Number(record.metrics.retryFailureStreak ?? 0),
      approvalWait: Boolean(record.metrics.approvalWait),
      userInputWait: Boolean(record.metrics.userInputWait),
      elapsedMs: typeof record.metrics.elapsedMs === "number" ? record.metrics.elapsedMs : undefined,
      tokenTotal: typeof record.metrics.tokenTotal === "number" ? record.metrics.tokenTotal : undefined,
      costUsd: typeof record.metrics.costUsd === "number" ? record.metrics.costUsd : undefined,
      evidenceGapCount: Number(record.metrics.evidenceGapCount ?? 0),
    },
    recommendedAction:
      typeof record.recommendedAction === "string"
        ? record.recommendedAction
        : "Review the run state before continuing.",
    createdAt:
      typeof record.createdAt === "string" ? record.createdAt : (gateCheckpoint?.createdAt ?? new Date().toISOString()),
  };
}

function buildDerivedContinuationGate(input: {
  waitingForApproval: boolean;
  waitingForUserInput: boolean;
  failedToolRunCount: number;
  toolRuns: number;
  checkpoints: OrchestrationCheckpointRecord[];
  evidenceGapCount: number;
  orchestrationError?: string | null;
  runFailure?: boolean;
  delegationContinuationNeeded?: boolean;
}): ContinuationGateDecision {
  const metrics = {
    stepsSinceCheckpoint: countStepsSinceCheckpoint(input.checkpoints),
    toolRunCount: input.toolRuns,
    failedToolRunCount: input.failedToolRunCount,
    retryFailureStreak: input.failedToolRunCount,
    approvalWait: input.waitingForApproval,
    userInputWait: input.waitingForUserInput,
    evidenceGapCount: input.evidenceGapCount,
  };
  if (input.waitingForApproval) {
    return {
      decision: "pause",
      reasonCodes: ["approval_wait"],
      summary: "Continuation paused for approval.",
      metrics,
      recommendedAction: "Resolve the approval before continuing.",
      createdAt: new Date().toISOString(),
    };
  }
  if (input.waitingForUserInput) {
    return {
      decision: "pause",
      reasonCodes: ["user_input_wait"],
      summary: "Continuation paused for operator input.",
      metrics,
      recommendedAction: "Answer the waiting question before continuing.",
      createdAt: new Date().toISOString(),
    };
  }
  if (input.runFailure || input.failedToolRunCount >= 2) {
    return {
      decision: "pause",
      reasonCodes: ["failure_streak"],
      summary: "Continuation paused because failures need inspection.",
      metrics,
      recommendedAction: "Inspect the failed step before retrying.",
      createdAt: new Date().toISOString(),
    };
  }
  if (input.delegationContinuationNeeded) {
    return {
      decision: "pause",
      reasonCodes: ["delegation_partial"],
      summary: "Continuation paused because delegated research needs a focused follow-up.",
      metrics,
      recommendedAction: "Continue from the gathered leads and fill only the missing fields.",
      createdAt: new Date().toISOString(),
    };
  }
  if (input.orchestrationError || input.evidenceGapCount > 0) {
    return {
      decision: "checkpoint",
      reasonCodes: ["state_gap"],
      summary: "Checkpoint recommended before continuing.",
      metrics,
      recommendedAction: "Refresh or inspect the missing run state before continuing.",
      createdAt: new Date().toISOString(),
    };
  }
  return {
    decision: "continue",
    reasonCodes: [],
    summary: "Continue gate clear.",
    metrics,
    recommendedAction: "Continue the run.",
    createdAt: new Date().toISOString(),
  };
}

function countStepsSinceCheckpoint(checkpoints: OrchestrationCheckpointRecord[]): number {
  const reversed = [...checkpoints].reverse();
  const checkpointIndex = reversed.findIndex((checkpoint) =>
    ["continuation_gate", "run_paused_for_approval", "run_resumed"].includes(checkpoint.checkpointKind),
  );
  return checkpointIndex < 0 ? checkpoints.length : checkpointIndex;
}

function buildPlanNodes(input: {
  activePlanSteps: ChatExecutionPlanRecord["steps"];
  roleSteps: NonNullable<ChatOrchestrationSummary>["steps"];
  delegationSteps: ActiveChatDelegationRun["steps"];
  planState: string;
}): CoworkRunMapNode[] {
  const fromPlan = input.activePlanSteps.map((step) => ({
    id: step.stepId,
    label: step.objective,
    status: humanizeStatus(step.status),
    meta: step.delegatedRole,
  }));
  if (fromPlan.length > 0) {
    return fromPlan.slice(0, 8);
  }
  const fromRoles = input.roleSteps.map((step) => ({
    id: `role-${step.stepId}`,
    label: step.role,
    status: humanizeStatus(step.status),
    meta: step.model,
  }));
  if (fromRoles.length > 0) {
    return fromRoles.slice(0, 8);
  }
  const fromDelegation = input.delegationSteps.map((step) => ({
    id: `delegation-${step.stepId}`,
    label: step.role,
    status: humanizeStatus(step.status),
    meta: step.childSessionId,
  }));
  if (fromDelegation.length > 0) {
    return fromDelegation.slice(0, 8);
  }
  return [
    { id: "plan", label: "Plan", status: humanizeStatus(input.planState) },
    { id: "research", label: "Research", status: "pending" },
    { id: "patch", label: "Patch", status: "pending" },
    { id: "qa", label: "QA", status: "pending" },
    { id: "ship", label: "Ship", status: "pending" },
  ];
}

export function resolveActiveWorkflowTurn(thread: ChatThreadResponse | null): ChatThreadTurnRecord | null {
  if (!thread?.turns.length) {
    return null;
  }
  const activeTurnId = thread.activeLeafTurnId ?? thread.turns.at(-1)?.turnId;
  return thread.turns.find((turn) => turn.turnId === activeTurnId) ?? thread.turns.at(-1) ?? null;
}

export function deriveCoworkRunViewModel(input: {
  items: CoworkTaskItem[];
  orchestration?: ChatOrchestrationSummary | null;
  orchestrationRun?: OrchestrationRun | null;
  orchestrationCheckpoints?: OrchestrationCheckpointRecord[];
  orchestrationLoading?: boolean;
  orchestrationError?: string | null;
  executionPlan?: ChatExecutionPlanRecord;
  delegationRun?: ActiveChatDelegationRun | null;
  activeTurn?: ChatThreadTurnRecord | null;
  selectedTurn?: ChatThreadTurnRecord | null;
  workbenchState?: ChatSessionWorkbenchRecord | null;
  agenticRunTree?: AgenticRunTreeResponse | null;
}): CoworkRunViewModel {
  const {
    items,
    orchestration,
    orchestrationRun,
    orchestrationCheckpoints = [],
    orchestrationLoading = false,
    orchestrationError = null,
    executionPlan,
    delegationRun = null,
    activeTurn = null,
    selectedTurn = null,
    workbenchState = null,
    agenticRunTree = null,
  } = input;

  const activePlanSteps = executionPlan?.steps ?? [];
  const roleSteps = orchestration?.steps ?? [];
  const delegationSteps = delegationRun?.steps ?? [];
  const currentTrace = activeTurn?.trace;
  const waitingForApproval =
    orchestrationRun?.executionState === "paused_for_approval" || currentTrace?.status === "waiting_for_approval";
  const waitingForUserInput = currentTrace?.status === "waiting_for_user_input";
  const worktreeState = orchestrationRun?.worktreeStatus ?? workbenchState?.worktreeStatus ?? "off";
  const toolRuns = currentTrace?.toolRuns.length ?? 0;
  const failedToolRunCount = currentTrace?.toolRuns.filter((run) => run.status === "failed").length ?? 0;
  const planState = orchestrationRun?.status ?? orchestration?.status ?? currentTrace?.status ?? "idle";
  const delegationRunLoaded = Boolean(
    delegationRun && (!orchestration?.runId || delegationRun.runId === orchestration.runId),
  );
  const executionState = formatExecutionState(
    orchestrationRun?.executionState ??
      (delegationRunLoaded ? delegationRun?.status : undefined) ??
      currentTrace?.durable?.status ??
      currentTrace?.status,
  );
  const selectionLabel = describeSelectionState({ selectedTurn, activeTurn });
  const errorSummary = formatCoworkFriendlyError(orchestrationError);
  const runFailureSummary = formatCoworkFriendlyError(orchestrationRun?.lastError ?? currentTrace?.failure?.message);
  const delegationFailure = delegationSteps.find((step) => step.error);
  const delegationContinuationFailure = delegationSteps.find(isDelegationContinuationFailure);
  const delegationContinuationNeeded =
    delegationRunLoaded && delegationRun?.status === "partial" && Boolean(delegationContinuationFailure);
  const delegationFailureSummary = formatCoworkFriendlyError(delegationFailure?.error);
  const durableRecoveryState = currentTrace?.durable?.recoveryState;
  const durableRecoverySummary = currentTrace?.durable?.recoverySummary;

  const blockers = [
    waitingForUserInput
      ? {
          id: "answer-required",
          title: "Answer required",
          summary: "Cowork is waiting for your answer before the run can continue.",
        }
      : null,
    !waitingForUserInput && waitingForApproval
      ? {
          id: "approval-required",
          title: "Approval required",
          summary: "Cowork is paused on an approval gate before it can continue.",
        }
      : null,
    errorSummary
      ? {
          id: "refresh-failed",
          title: "Run state refresh failed",
          summary: errorSummary.summary,
          raw: errorSummary.raw,
        }
      : null,
    runFailureSummary
      ? {
          id: "run-failed",
          title: "Run failed",
          summary: runFailureSummary.summary,
          raw: runFailureSummary.raw,
        }
      : null,
    durableRecoveryState && durableRecoveryState !== "none"
      ? {
          id: "durable-recovery",
          title: "Durable worker needs attention",
          summary:
            durableRecoverySummary ??
            `Worker state is ${humanizeStatus(durableRecoveryState)} for the linked durable run.`,
        }
      : null,
    delegationFailureSummary
      ? {
          id: delegationContinuationFailure ? "delegation-continuation-needed" : "delegation-failed",
          title: delegationContinuationFailure
            ? "Continuation needed"
            : `${delegationFailure?.role ?? "Delegated step"} failed`,
          summary: delegationFailureSummary.summary,
          raw: delegationFailure?.failureGuidance ?? delegationFailureSummary.raw,
        }
      : null,
  ].filter((value): value is CoworkBlocker => Boolean(value));

  const empty =
    !activeTurn &&
    !orchestrationRun &&
    !orchestration &&
    !orchestrationLoading &&
    !orchestrationError &&
    activePlanSteps.length === 0 &&
    delegationSteps.length === 0 &&
    orchestrationCheckpoints.length === 0 &&
    items.length === 0;

  const nextAction: CoworkRunViewModel["nextAction"] = empty
    ? {
        kind: "focus_composer",
        label: "Start Cowork run",
        note: "Describe the objective, constraints, and desired output in the composer to create a visible run.",
      }
    : waitingForUserInput || waitingForApproval
      ? {
          kind: "review_run_details",
          label: "Resolve blocker",
          note: "Open the current blocker details, respond, and let Cowork resume the run.",
        }
      : errorSummary
        ? {
            kind: "refresh_run_state",
            label: "Refresh run state",
            note: "Reload the canonical run and checkpoints before acting on stale information.",
          }
        : runFailureSummary
          ? {
              kind: "retry_turn",
              label: "Retry run step",
              note: "Retry the active turn once the route and settings still look right.",
            }
          : delegationContinuationNeeded
            ? {
                kind: "retry_turn",
                label: "Continue from gathered leads",
                note: "Continue the partial Cowork run without repeating completed lookups; focus on the missing fields.",
              }
            : items.length > 0
              ? {
                  kind: "open_tasks",
                  label: "Open tasks",
                  note: "Review the queued operator actions and related follow-up work beside this run.",
                }
              : {
                  kind: "review_run_details",
                  label: "Open run details",
                  note: "Inspect routing, tools, and raw state without displacing the active run board.",
                };

  const nowTitle = empty
    ? "No Cowork run is active yet"
    : waitingForUserInput
      ? "Cowork is waiting for your answer"
      : waitingForApproval
        ? "Cowork is waiting on approval"
        : delegationContinuationNeeded
          ? "Cowork needs a continuation pass"
          : orchestrationRun
            ? `${humanizeStatus(planState)} run`
            : orchestration
              ? "Cowork is working from routed trace state"
              : "Cowork is holding workflow context";

  const phaseLabel = humanizePhaseLabel(orchestrationRun?.currentPhaseId);
  const waveLabel = humanizePhaseLabel(orchestrationRun?.currentWaveId, "Wave");
  const runProgressSummary = [phaseLabel, waveLabel].filter((value): value is string => Boolean(value)).join(" · ");

  const nowSummary = empty
    ? "Describe the objective, constraints, and desired output. Cowork will attach a visible plan, checkpoints, and blockers here."
    : orchestration?.finalSummary
      ? orchestration.finalSummary
      : delegationContinuationNeeded
        ? "Delegated research stopped after a budget or policy boundary. Continue from the gathered leads and fill only the missing fields."
        : runProgressSummary
          ? `${runProgressSummary} · ${executionState}.`
          : orchestrationRun
            ? `Execution is ${executionState} and the board is showing live Cowork run state.`
            : currentTrace?.status
              ? `The active turn is ${humanizeStatus(currentTrace.status)} while Cowork keeps the workflow context visible.`
              : "Cowork has the current workflow context, even though no canonical run data is loaded yet.";

  const facts = [
    orchestration?.workflowTemplate ? { label: "Workflow", value: orchestration.workflowTemplate } : null,
    orchestration?.routeDecision.selectedRoles.length
      ? { label: "Roles", value: orchestration.routeDecision.selectedRoles.join(" -> ") }
      : null,
    phaseLabel ? { label: "Current phase", value: phaseLabel } : null,
    waveLabel ? { label: "Current wave", value: waveLabel } : null,
    currentTrace?.durable?.workerHealth
      ? { label: "Durable worker", value: humanizeStatus(currentTrace.durable.workerHealth) }
      : null,
  ].filter((value): value is { label: string; value: string } => Boolean(value));

  const sourceLabel = orchestrationRun
    ? "Source: canonical run"
    : delegationRunLoaded
      ? "Source: delegation run"
      : orchestration?.runId
        ? "Source: trace fallback"
        : activeTurn
          ? "Source: active turn"
          : "Source: pre-run";
  const freshnessLabel =
    orchestrationLoading && !orchestrationRun
      ? "Freshness: loading live run state"
      : orchestrationError
        ? "Freshness: partially refreshed"
        : empty
          ? "Freshness: pre-run"
          : "Freshness: live";
  const completenessLabel = orchestrationError
    ? "Completeness: partial"
    : empty
      ? "Completeness: pre-run"
      : orchestrationRun
        ? "Completeness: full"
        : delegationRunLoaded
          ? buildDelegationCompletenessLabel(delegationRun?.status)
          : "Completeness: trace-backed";

  const operatorActionItems = limitItems(
    items.map((item) => ({
      id: item.id,
      title: item.title,
      note: item.note,
    })),
    MAX_VISIBLE_OUTPUT_ITEMS,
  );

  const planItems = limitItems(
    activePlanSteps.map((step) => ({
      id: step.stepId,
      title: step.objective,
      status: humanizeStatus(step.status),
      meta: [
        step.delegatedRole ? `Role ${step.delegatedRole}` : null,
        step.dependsOnStepIds?.length ? `Depends on ${step.dependsOnStepIds.join(", ")}` : null,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · "),
      note: normalizeSummary(step.summary ?? step.error ?? step.successCriteria),
    })),
    MAX_VISIBLE_PLAN_STEPS,
  );

  const roleItems = limitItems(
    [
      ...roleSteps.map((step) => ({
        id: `role-${step.stepId}`,
        title: step.label ?? step.role,
        status: humanizeStatus(step.status),
        meta: [step.providerId ?? "provider auto", step.model]
          .filter((value): value is string => Boolean(value))
          .join(" · "),
        note: normalizeSummary(step.summary ?? step.error, 120),
      })),
      ...delegationSteps.map((step) => ({
        id: `delegation-${step.stepId}`,
        title: `${step.label ?? step.role} delegation`,
        status: humanizeStatus(step.status),
        meta: step.output ? "Output ready in run details" : undefined,
        note: normalizeSummary(step.summary ?? step.output ?? step.error, 120),
      })),
    ],
    MAX_VISIBLE_ROLE_ITEMS,
  );

  const timelineItems = limitItems(
    [...orchestrationCheckpoints].reverse().map((checkpoint) => ({
      id: checkpoint.checkpointId,
      title: CHECKPOINT_LABELS[checkpoint.checkpointKind] ?? humanizeStatus(checkpoint.checkpointKind),
      meta: buildCheckpointMeta(checkpoint),
      note:
        normalizeSummary(
          typeof checkpoint.details.error === "string"
            ? checkpoint.details.error
            : typeof checkpoint.details.lifecycleState === "string"
              ? `Execution ${checkpoint.details.lifecycleState}`
              : undefined,
          120,
        ) ?? normalizeSummary(checkpoint.createdAt, 48),
    })),
    MAX_VISIBLE_TIMELINE_ITEMS,
  );

  const outputItems = limitItems(
    [
      ...(delegationRun?.stitchedOutput
        ? [
            {
              id: "stitched-output",
              title: buildDelegationOutputTitle(delegationRun.status),
              note: buildDelegationOutputNote(delegationRun.status),
            },
          ]
        : []),
      ...(workbenchState?.worktreeStatus
        ? [
            {
              id: "worktree-state",
              title: "Worktree ready",
              note: `Cowork has a ${humanizeStatus(workbenchState.worktreeStatus)} worktree attached to this session.`,
            },
          ]
        : []),
    ],
    MAX_VISIBLE_OUTPUT_ITEMS,
  );
  const stateGaps = [
    orchestrationError ? "Run state refresh needs attention" : null,
    orchestration?.runId && !orchestrationRun && !delegationRunLoaded ? "Canonical run not loaded" : null,
    waitingForApproval ? "Approval unresolved" : null,
    waitingForUserInput ? "Operator answer required" : null,
    delegationContinuationNeeded ? "Delegation continuation needed" : null,
    durableRecoveryState && durableRecoveryState !== "none"
      ? `Durable worker recovery: ${humanizeStatus(durableRecoveryState)}`
      : null,
    orchestrationRun?.status === "completed" && outputItemsMissingProof(workbenchState)
      ? "Manual UI proof not attached"
      : null,
  ].filter((value): value is string => Boolean(value));
  const evidenceGapCount = stateGaps.filter((gap) =>
    ["Run state refresh needs attention", "Canonical run not loaded", "Manual UI proof not attached"].includes(gap),
  ).length;
  const continuationGate =
    readContinuationGateFromCheckpoint(orchestrationCheckpoints) ??
    buildDerivedContinuationGate({
      waitingForApproval,
      waitingForUserInput,
      failedToolRunCount,
      toolRuns,
      checkpoints: orchestrationCheckpoints,
      evidenceGapCount,
      orchestrationError,
      runFailure: Boolean(runFailureSummary),
      delegationContinuationNeeded,
    });
  const checkpointItems = [...orchestrationCheckpoints]
    .reverse()
    .slice(0, 8)
    .map((checkpoint) => ({
      id: checkpoint.checkpointId,
      title: CHECKPOINT_LABELS[checkpoint.checkpointKind] ?? humanizeStatus(checkpoint.checkpointKind),
      meta: checkpoint.createdAt,
      note: buildCheckpointMeta(checkpoint),
    }));
  const planNodes = buildPlanNodes({
    activePlanSteps,
    roleSteps,
    delegationSteps,
    planState,
  });
  const evidenceSummary = {
    label:
      continuationGate.decision === "continue" ? "Evidence: current" : `Evidence: ${continuationGate.decision} gate`,
    detail: [
      `${toolRuns} tool call${toolRuns === 1 ? "" : "s"}`,
      `${orchestrationCheckpoints.length} checkpoint${orchestrationCheckpoints.length === 1 ? "" : "s"}`,
      evidenceGapCount > 0 ? `${evidenceGapCount} state gap${evidenceGapCount === 1 ? "" : "s"}` : "no state gaps",
    ].join(" · "),
    toolCallCount: toolRuns,
    checkpointCount: orchestrationCheckpoints.length,
    evidenceGapCount,
  };
  const agenticRuntime = buildAgenticRuntimeSummary(agenticRunTree);

  return {
    empty,
    activeTurnId: activeTurn?.turnId ?? null,
    selectedTurnId: selectedTurn?.turnId ?? null,
    hasHistoricalSelection: Boolean(selectedTurn && activeTurn && selectedTurn.turnId !== activeTurn.turnId),
    headerTitle: "Cowork run",
    headerSummary: [sourceLabel, freshnessLabel, completenessLabel].join(" · "),
    sourceLabel,
    freshnessLabel,
    completenessLabel,
    selectionLabel,
    stageCards: [
      { label: "Workflow", value: humanizeStatus(planState) },
      { label: "Execution", value: executionState },
      { label: "Approval", value: waitingForUserInput ? "answer required" : waitingForApproval ? "blocked" : "clear" },
      { label: "Worktree", value: humanizeStatus(worktreeState) },
      { label: "Tools", value: String(toolRuns) },
    ],
    now: {
      label: empty ? "Ready" : blockers.length > 0 ? "Now" : "Now",
      title: nowTitle,
      summary: nowSummary,
      facts,
    },
    nextAction,
    blockers,
    operatorActionItems,
    planItems,
    roleItems,
    timelineItems,
    outputItems,
    continuationGate,
    runMap: {
      objective:
        normalizeSummary(executionPlan?.objective, 120) ??
        normalizeSummary(orchestration?.objective, 120) ??
        normalizeSummary(activeTurn?.userMessage.content, 120) ??
        "Cowork objective",
      currentState: nowTitle,
      nextAction: nextAction?.label ?? "Review run details",
      planNodes,
      checkpoints: checkpointItems,
    },
    stateGaps,
    evidenceSummary,
    agenticRuntime,
    raw: {
      activeTurn,
      selectedTurn,
      orchestration,
      orchestrationRun,
      orchestrationCheckpoints,
      executionPlan,
      delegationRun,
      workbenchState,
      orchestrationError,
      agenticRunTree,
    },
  };
}
