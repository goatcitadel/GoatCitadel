import type {
  ChatExecutionPlanRecord,
  ChatOrchestrationSummary,
  ChatSessionWorkbenchRecord,
  ChatThreadResponse,
  ChatThreadTurnRecord,
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
  phase_approved: "Approval recorded",
  phase_executed: "Phase completed",
  wave_advanced: "Advanced to next wave",
  run_completed: "Run completed",
  run_stopped: "Run stopped by limit",
  run_failed: "Run failed",
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
  };
}

type CoworkBlocker = CoworkRunViewModel["blockers"][number];

function humanizeStatus(value?: string | null): string {
  if (!value) {
    return "unknown";
  }
  return value.replaceAll("_", " ");
}

function formatExecutionState(value?: OrchestrationRun["executionState"]): string {
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
  const planState = orchestrationRun?.status ?? orchestration?.status ?? currentTrace?.status ?? "idle";
  const executionState = formatExecutionState(orchestrationRun?.executionState);
  const selectionLabel = describeSelectionState({ selectedTurn, activeTurn });
  const errorSummary = formatCoworkFriendlyError(orchestrationError);
  const runFailureSummary = formatCoworkFriendlyError(orchestrationRun?.lastError ?? currentTrace?.failure?.message);
  const delegationFailure = delegationSteps.find((step) => step.error);
  const delegationFailureSummary = formatCoworkFriendlyError(delegationFailure?.error);

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
    delegationFailureSummary
      ? {
          id: "delegation-failed",
          title: `${delegationFailure?.role ?? "Delegated step"} failed`,
          summary: delegationFailureSummary.summary,
          raw: delegationFailureSummary.raw,
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
  ].filter((value): value is { label: string; value: string } => Boolean(value));

  const sourceLabel = orchestrationRun
    ? "Source: canonical run"
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
              title: "Stitched result available",
              note: "Open run details to inspect the stitched delegation result.",
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
    },
  };
}
