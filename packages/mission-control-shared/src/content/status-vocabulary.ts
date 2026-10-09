import type {
  ApprovalRequest,
  ApprovalResolutionOutcome,
  ApprovalStatus,
  ChatTurnLifecycleStatus,
  ChangePlanStatus,
  DurableRunStatus,
} from "@goatcitadel/contracts";

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

const riskLevels: Record<ApprovalRequest["riskLevel"], StatusPresentation> = {
  safe: status("Low", "neutral"),
  caution: status("Medium", "waiting"),
  danger: status("High", "failed"),
  nuclear: status("Critical", "failed"),
};

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
