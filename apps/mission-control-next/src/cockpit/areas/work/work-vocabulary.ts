import type {
  ChatDelegationRunStatus,
  ChatDelegationStepStatus,
  ChatExecutionPlanStatus,
  ChatExecutionPlanStepStatus,
  ChatSessionWorkbenchWorktreeStatus,
  ChatToolRunRecord,
  CronJobAction,
  DurableChildWatcherState,
  TaskActivityType,
  TaskDeliverableType,
  TaskPriority,
} from "@goatcitadel/contracts";
import type { RunTraceAvailabilityState } from "@goatcitadel/mission-control-shared/api/durable";
import {
  humanizeToken,
  type StatusPresentation,
  type StatusTone,
} from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { WorkRunAction } from "./work-run-control-guard";

/** Plain words for the Work area's wire enums. Typed records so a new enum value fails typecheck. */

const status = (label: string, tone: StatusTone): StatusPresentation => ({ label, tone });

/** Text colour for a notice whose outcome follows a returned status, so a failed result never reads as success. */
export const NOTICE_TONE_CLASS: Readonly<Record<StatusTone, string>> = {
  running: "text-status-running",
  waiting: "text-status-waiting",
  done: "text-status-done",
  failed: "text-status-failed",
  neutral: "text-fg-secondary",
};

/** Confirm-button verbs for reviewed run controls. */
export const RUN_ACTION_CONFIRM: Readonly<Record<WorkRunAction, string>> = {
  pause: "Pause run",
  resume: "Resume run",
  cancel: "Cancel run",
  retry: "Retry run",
  recover: "Recover run",
};

export const SCHEDULE_ACTION_LABELS: Readonly<Record<CronJobAction, string>> = {
  task: "Task",
  improvement: "Improvement",
  curator: "Curator",
  backup: "Backup",
  memory_flush: "Memory flush",
  memory_consolidation: "Memory consolidation",
  cost_report: "Cost report",
  update_review: "Update review",
  watchdog: "Watchdog",
  no_agent: "No agent",
  agent_turn: "Agent turn",
};

export function presentScheduleAction(action: CronJobAction | undefined): string {
  return action ? (SCHEDULE_ACTION_LABELS[action] ?? humanizeToken(action)) : "Action not reported";
}

/** Skip and partial reasons are open strings written by each schedule handler; humanize them as a fallback. */
export function presentScheduleReason(reason: string): string {
  return humanizeToken(reason);
}

export const TASK_PRIORITY_LABELS: Readonly<Record<TaskPriority, string>> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const TASK_ACTIVITY_LABELS: Readonly<Record<TaskActivityType, string>> = {
  spawned: "Created",
  updated: "Updated",
  completed: "Completed",
  file_created: "File created",
  status_changed: "Status changed",
  comment: "Comment",
  diagnostic: "Diagnostic",
  heartbeat: "Heartbeat",
  control: "Control",
  handoff: "Handoff",
  delivery: "Delivery",
};

export const TASK_DELIVERABLE_LABELS: Readonly<Record<TaskDeliverableType, string>> = {
  file: "File",
  url: "Link",
  artifact: "Artifact",
};

/** Lower-case words that complete "… evidence is …". */
export const EVIDENCE_STATE_WORDS: Readonly<Record<RunTraceAvailabilityState, string>> = {
  available: "available",
  not_available: "not available",
  unknown: "unknown",
};

export const PLAN_STATUSES: Readonly<Record<ChatExecutionPlanStatus, StatusPresentation>> = {
  drafted: status("Draft", "neutral"),
  ready: status("Ready", "neutral"),
  running: status("Running", "running"),
  completed: status("Done", "done"),
  partial: status("Partial", "waiting"),
  failed: status("Failed", "failed"),
  cancelled: status("Cancelled", "neutral"),
};

export const PLAN_STEP_STATUSES: Readonly<Record<ChatExecutionPlanStepStatus, StatusPresentation>> = {
  pending: status("Pending", "neutral"),
  running: status("Running", "running"),
  completed: status("Done", "done"),
  failed: status("Failed", "failed"),
  cancelled: status("Cancelled", "neutral"),
};

export const DELEGATION_RUN_STATUSES: Readonly<Record<ChatDelegationRunStatus, StatusPresentation>> = {
  running: status("Running", "running"),
  completed: status("Done", "done"),
  failed: status("Failed", "failed"),
  partial: status("Partial", "waiting"),
};

export const DELEGATION_STEP_STATUSES: Readonly<Record<ChatDelegationStepStatus, StatusPresentation>> = {
  pending: status("Pending", "neutral"),
  running: status("Running", "running"),
  completed: status("Done", "done"),
  failed: status("Failed", "failed"),
  skipped: status("Skipped", "neutral"),
  cancelled: status("Cancelled", "neutral"),
};

export const TOOL_RUN_STATUSES: Readonly<Record<ChatToolRunRecord["status"], StatusPresentation>> = {
  started: status("Running", "running"),
  executed: status("Done", "done"),
  blocked: status("Blocked", "waiting"),
  approval_required: status("Waiting on you", "waiting"),
  failed: status("Failed", "failed"),
};

/** A presenter that tolerates a value newer than this build: its own words, neutral tone. */
export function presentFrom<T extends string>(
  table: Readonly<Record<T, StatusPresentation>>,
  value: T,
): StatusPresentation {
  return table[value] ?? status(humanizeToken(value), "neutral");
}

export const WORKTREE_STATUS_LABELS: Readonly<Record<ChatSessionWorkbenchWorktreeStatus, string>> = {
  uninitialized: "Not set up",
  ready: "Ready",
  missing: "Missing",
  blocked: "Blocked",
};

export const WATCHER_STATE_LABELS: Readonly<Record<DurableChildWatcherState, string>> = {
  attached: "Watching",
  detached: "Detached",
  closed: "Closed",
};

export const SIGNAL_POSTURE_WORDS: Readonly<Record<"clean" | "degraded" | "unobserved", string>> = {
  clean: "clean",
  degraded: "degraded",
  unobserved: "unobserved",
};

export const LINEAGE_SOURCE_WORDS: Readonly<Record<"delegation_step" | "assistant_message", string>> = {
  delegation_step: "delegation step",
  assistant_message: "assistant message",
};

export const RECEIPT_OUTCOMES: Readonly<Record<"succeeded" | "failed" | "in_progress" | "unknown", string>> = {
  succeeded: "Succeeded",
  failed: "Failed",
  in_progress: "In progress",
  unknown: "Unknown",
};

export const RUN_ERROR_SOURCES: Readonly<Record<"durable_run" | "checkpoint" | "timeline" | "turn" | "tool", string>> =
  {
    durable_run: "Run",
    checkpoint: "Checkpoint",
    timeline: "Timeline",
    turn: "Turn",
    tool: "Tool",
  };

const ARTIFACT_KIND_LABELS: Readonly<Record<string, string>> = {
  markdown: "Markdown",
  html: "HTML",
  mermaid: "Diagram",
  code: "Code",
  text: "Text",
};

/** Artifact kinds are an open string on the trace; known ones get plain names. */
export function presentArtifactKind(kind: string): string {
  return ARTIFACT_KIND_LABELS[kind] ?? humanizeToken(kind);
}

export const EXPORT_VALIDATION_LABELS: Readonly<Record<"ready_for_operator_import_review" | "blocked", string>> = {
  ready_for_operator_import_review: "Ready for your import review",
  blocked: "Blocked",
};

export const IMPORT_COMPATIBILITY_LABELS: Readonly<Record<"not_verified", string>> = {
  not_verified: "Not verified",
};

export const SCHEDULER_REVIEW_STATUSES: Readonly<
  Record<"open" | "resolved" | "retrying" | "ignored", StatusPresentation>
> = {
  open: status("Needs review", "waiting"),
  resolved: status("Resolved", "done"),
  retrying: status("Retrying", "running"),
  ignored: status("Ignored", "neutral"),
};

export const REVIEW_SEVERITY_LABELS: Readonly<Record<"low" | "medium" | "high" | "critical", string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};
