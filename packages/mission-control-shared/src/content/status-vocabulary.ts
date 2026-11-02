import type {
  ApprovalRequest,
  ApprovalResolutionOutcome,
  ApprovalStatus,
  ChatMessagingChannelStatus,
  ChatTurnLifecycleStatus,
  ChangePlanStatus,
  DurableRunStatus,
  TaskStatus,
} from "@goatcitadel/contracts";
import type { BrowserErrandOutcome, BrowserErrandState } from "../api/browser-errands.js";

export type StatusTone = "running" | "waiting" | "done" | "failed" | "neutral";
export interface StatusPresentation {
  label: string;
  tone: StatusTone;
}

const status = (label: string, tone: StatusTone): StatusPresentation => ({ label, tone });

const runStatuses: Record<DurableRunStatus, StatusPresentation> = {
  queued: status("Queued", "neutral"),
  running: status("Running", "running"),
  waiting: status("Waiting", "neutral"),
  paused: status("Paused", "neutral"),
  completed: status("Done", "done"),
  failed: status("Failed", "failed"),
  cancelled: status("Cancelled", "neutral"),
  dead_lettered: status("Failed · needs recovery", "failed"),
};

const chatTurnStatuses: Record<ChatTurnLifecycleStatus, StatusPresentation> = {
  queued: status("Queued", "neutral"),
  running: status("Running", "running"),
  waiting_for_tool: status("Waiting for a tool", "neutral"),
  waiting_for_approval: status("Waiting on you", "waiting"),
  waiting_for_user_input: status("Needs your input", "waiting"),
  completed: status("Done", "done"),
  partial: status("Partial", "waiting"),
  failed: status("Failed", "failed"),
  cancelled: status("Cancelled", "neutral"),
};

const changePlanStatuses: Record<ChangePlanStatus, StatusPresentation> = {
  draft: status("Draft", "neutral"),
  awaiting_input: status("Needs your input", "waiting"),
  awaiting_confirmation: status("Needs confirmation", "waiting"),
  staging: status("Applying", "running"),
  awaiting_approval: status("Waiting on you", "waiting"),
  applying: status("Applying", "running"),
  verifying: status("Verifying", "running"),
  monitoring: status("Monitoring", "running"),
  completed: status("Done", "done"),
  applied: status("Done", "done"),
  manual_required: status("Needs a manual step", "waiting"),
  failed: status("Failed", "failed"),
  cancelled: status("Cancelled", "neutral"),
  rolling_back: status("Rolling back", "running"),
  rolled_back: status("Rolled back", "neutral"),
  rollback_failed: status("Rollback failed", "failed"),
};

const approvalStatuses: Record<ApprovalStatus, StatusPresentation> = {
  pending: status("Waiting on you", "waiting"),
  approved: status("Approved", "done"),
  rejected: status("Denied", "neutral"),
  edited: status("Approved with edits", "done"),
};

const approvalOutcomes: Record<ApprovalResolutionOutcome, StatusPresentation> = {
  approved: status("Approved", "done"),
  denied: status("Denied", "neutral"),
  withdrawn: status("Withdrawn", "neutral"),
  expired: status("Expired", "neutral"),
  policy_blocked: status("Blocked by policy", "failed"),
  delivery_failed: status("Couldn't deliver", "failed"),
  unknown: status("Outcome unknown", "waiting"),
};

// DESIGN.md: risk reads Safe, Caution, Danger, Nuclear everywhere.
const riskLevels: Record<ApprovalRequest["riskLevel"], StatusPresentation> = {
  safe: status("Safe", "neutral"),
  caution: status("Caution", "waiting"),
  danger: status("Danger", "failed"),
  nuclear: status("Nuclear", "failed"),
};

const channelStatuses: Record<ChatMessagingChannelStatus, StatusPresentation> = {
  on: status("On", "done"),
  off: status("Off", "neutral"),
  needs_attention: status("Needs you", "waiting"),
  removed: status("Removed", "neutral"),
};

const taskStatuses: Record<TaskStatus, StatusPresentation> = {
  planning: status("Planning", "neutral"),
  inbox: status("Not started", "neutral"),
  assigned: status("Assigned", "neutral"),
  in_progress: status("In progress", "running"),
  testing: status("Testing", "running"),
  review: status("In review", "waiting"),
  done: status("Done", "done"),
  blocked: status("Blocked", "failed"),
};

const browserErrandStates: Record<Exclude<BrowserErrandState, "finished">, StatusPresentation> = {
  running: status("Running", "running"),
  waiting_on_you: status("Waiting on you", "waiting"),
  taken_over: status("Paused", "neutral"),
};

const browserErrandOutcomes: Record<BrowserErrandOutcome, StatusPresentation> = {
  done: status("Done", "done"),
  stopped: status("Cancelled", "neutral"),
  declined: status("Cancelled", "neutral"),
  window_closed: status("Cancelled", "neutral"),
  expired: status("Failed", "failed"),
  failed: status("Failed", "failed"),
  step_limit: status("Failed", "failed"),
  time_limit: status("Failed", "failed"),
};

/** A browser errand's label: its live state while it runs, its outcome once it has finished. */
export function presentBrowserErrand(state: BrowserErrandState, outcome?: BrowserErrandOutcome): StatusPresentation {
  if (state !== "finished") return browserErrandStates[state];
  return outcome ? browserErrandOutcomes[outcome] : status("Done", "done");
}

export function humanizeToken(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_.\s-]+/)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "";
}

export function presentRunStatus(
  value: DurableRunStatus,
  options: { waitingOnOperator?: boolean } = {},
): StatusPresentation {
  return value === "waiting" && options.waitingOnOperator ? status("Waiting on you", "waiting") : runStatuses[value];
}

export function presentChatTurnStatus(value: ChatTurnLifecycleStatus | string): StatusPresentation {
  return chatTurnStatuses[value as ChatTurnLifecycleStatus] ?? status(humanizeToken(value), "neutral");
}

export function presentChangePlanStatus(value: ChangePlanStatus): StatusPresentation {
  return changePlanStatuses[value];
}

export function presentApprovalStatus(value: ApprovalStatus): StatusPresentation {
  return approvalStatuses[value];
}

export function presentApprovalOutcome(value: ApprovalResolutionOutcome): StatusPresentation {
  return approvalOutcomes[value];
}

export function presentRiskLevel(value: ApprovalRequest["riskLevel"]): StatusPresentation {
  // A risk level this build doesn't know yet keeps its own name and the most severe tone.
  return riskLevels[value] ?? status(humanizeToken(String(value)), "failed");
}

export function presentChannelStatus(value: ChatMessagingChannelStatus): StatusPresentation {
  // A status a newer Gateway sends keeps its own name and a neutral tone rather than rendering blank.
  return channelStatuses[value] ?? status(humanizeToken(String(value)), "neutral");
}

export function presentTaskStatus(value: TaskStatus | string): StatusPresentation {
  return taskStatuses[value as TaskStatus] ?? status(humanizeToken(value), "neutral");
}

export function presentEventClass(value: string | null | undefined): string {
  if (value === "domain_fact") return "Record";
  if (value === "operational_signal") return "System signal";
  if (value === "ui_notification") return "Notice";
  return value ? humanizeToken(value) : "Event";
}

export function presentEventType(value: string): string {
  return humanizeToken(value);
}

export function presentToolEffectOutcome(value: "none" | "uncertain" | "concrete"): string {
  if (value === "concrete") return "Made an outside change. A receipt is recorded.";
  if (value === "uncertain") return "Outcome uncertain. Check before retrying.";
  return "No outside changes.";
}
