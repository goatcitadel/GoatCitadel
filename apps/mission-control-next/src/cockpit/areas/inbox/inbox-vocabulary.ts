import {
  APPROVAL_EXPIRY_ACTOR_ID,
  type ApprovalEffectKind,
  type ApprovalEffectStatus,
  type ApprovalReplayEvent,
  type ApprovalRequest,
  type CapabilityProposalKind,
  type CapabilityProposalStatus,
  type ChangePlanScope,
  type CodeModeRunStatus,
  type CuratorReviewItem,
  type DocumentPatchAuthorKind,
  type DocumentPatchProposalState,
  type DurableSupportedWorkflowKey,
  type ImprovementEvaluationStatus,
  type PendingApprovalAction,
  type ShellRiskLevel,
  type TraceMemoryCandidateAuthority,
  type TraceMemoryCandidateType,
} from "@goatcitadel/contracts";
import type { StatusPresentation, StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

/** Inbox-only wording for wire values that have no shared presenter. Raw values stay in technical details. */
const status = (label: string, tone: StatusTone): StatusPresentation => ({ label, tone });

export const approvalEventLabels: Readonly<Record<ApprovalReplayEvent["eventType"], string>> = {
  created: "Request created",
  resolved: "Decision recorded",
  pending_action_registered: "Action queued for approval",
  pending_action_refused: "Action refused",
  approved_action_executed: "Approved action ran",
  code_mode_execution_claim_lost: "Code run handed off",
  replayed: "Decision applied again",
  explanation_requested: "Explanation requested",
  explanation_generated: "Explanation ready",
  explanation_failed: "Explanation failed",
  cancellation_lineage_skipped: "Skipped during cancellation (invalid lineage)",
  errand_after_screenshot: "Screenshot after the action",
};

export function presentApprovalEvent(value: ApprovalReplayEvent["eventType"]): string {
  return approvalEventLabels[value] ?? "Recorded event";
}

const effectStatuses: Readonly<Record<ApprovalEffectStatus, StatusPresentation>> = {
  pending: status("Queued", "neutral"),
  running: status("Running", "running"),
  completed: status("Done", "done"),
  skipped: status("Skipped", "neutral"),
  failed: status("Failed", "failed"),
};

export function presentApprovalEffectStatus(value: ApprovalEffectStatus): StatusPresentation {
  return effectStatuses[value] ?? status("Status unknown", "neutral");
}

const effectKinds: Readonly<Record<ApprovalEffectKind, string>> = {
  approval_wait_materialize: "Record the approval wait",
  approval_wait_wake: "Wake the waiting run",
  proactive_run_wake: "Wake the background run",
  orchestration_parent_wake: "Wake the coordinating run",
  linked_chat_turn_wake: "Continue the chat turn",
  pending_action_execute: "Run the approved action",
  approval_inbox_follow_up: "Update the Inbox",
  approval_after_hooks: "Run follow-up hooks",
  approval_resolution_signals: "Send decision notices",
  skill_hub_lifecycle_apply: "Apply the skill change",
  external_source_knowledge_snapshot_apply: "Apply the knowledge import",
  mesh_capability_activation_apply: "Activate the shared capability",
  memory_lifecycle_apply: "Apply the memory change",
  skill_lifecycle_apply: "Apply the skill change",
  capability_lifecycle_apply: "Apply the capability change",
  improvement_lifecycle_apply: "Apply the improvement",
  delegation_scope_expansion_apply: "Widen the delegated scope",
  delegation_scope_expansion_resume: "Resume the delegated work",
  engineering_learning_lifecycle_apply: "Apply the engineering learning",
  communications_mail_send_apply: "Send the approved email",
  communications_calendar_create_apply: "Create the approved calendar event",
  citadel_ward_integration_action_apply: "Run the approved integration action",
  citadel_ward_a2a_outbound_apply: "Send the approved A2A call",
  citadel_ward_a2a_push_apply: "Deliver the approved A2A push",
  approval_observability: "Record the decision trail",
};

export function presentApprovalEffectKind(value: ApprovalEffectKind): string {
  return effectKinds[value] ?? "Follow-on step";
}

const pendingActionResolutions: Readonly<Record<NonNullable<PendingApprovalAction["resolutionStatus"]>, string>> = {
  pending: "Waiting for the decision",
  executed: "Ran",
  rejected: "Not run",
  failed: "Failed",
};

export function presentPendingActionResolution(value: PendingApprovalAction["resolutionStatus"]): string {
  return value ? (pendingActionResolutions[value] ?? "Status unknown") : "No pending action record";
}

/** Shell findings use info/caution/danger; the cockpit shows them on the shared Safe/Caution/Danger scale. */
export const shellRiskAsApprovalRisk: Readonly<Record<ShellRiskLevel, ApprovalRequest["riskLevel"]>> = {
  info: "safe",
  caution: "caution",
  danger: "danger",
};

/**
 * Who recorded an event, in plain words; the actor id itself belongs in technical details. Only a recorded decision
 * is known to come from an operator: other events (a queued action, an explanation) may be recorded by an agent.
 */
export function presentActor(actorId: string | undefined, role: "decision" | "event" = "decision"): string {
  if (!actorId) return "Not recorded";
  if (actorId === APPROVAL_EXPIRY_ACTOR_ID) return "Expiry check";
  if (actorId.startsWith("system:") || actorId === "system" || actorId === "gateway") return "GoatCitadel";
  return role === "decision" ? "An operator" : "An agent or operator";
}

const documentProposalStates: Readonly<Record<DocumentPatchProposalState, StatusPresentation>> = {
  pending: status("Waiting on you", "waiting"),
  applied: status("Applied", "done"),
  rejected: status("Rejected", "neutral"),
  conflicted: status("Conflicts with a newer version", "failed"),
};

export function presentDocumentProposalState(value: DocumentPatchProposalState): StatusPresentation {
  return documentProposalStates[value] ?? status("Status unknown", "neutral");
}

export const documentAuthorLabels: Readonly<Record<DocumentPatchAuthorKind, string>> = {
  assistant: "Assistant",
  operator: "Operator",
};

const capabilityProposalStatuses: Readonly<Record<CapabilityProposalStatus, StatusPresentation>> = {
  proposed: status("Proposed", "neutral"),
  validating: status("Validating", "running"),
  pending_approval: status("Waiting on you", "waiting"),
  approved: status("Approved", "done"),
  rejected: status("Rejected", "neutral"),
  activated: status("Active", "done"),
  failed: status("Failed", "failed"),
};

export function presentCapabilityProposalStatus(value: CapabilityProposalStatus): StatusPresentation {
  return capabilityProposalStatuses[value] ?? status("Status unknown", "neutral");
}

export const capabilityProposalKindLabels: Readonly<Record<CapabilityProposalKind, string>> = {
  skill: "Skill",
  tool: "Tool",
};

const changePlanScopes: Readonly<Record<ChangePlanScope, string>> = {
  current_chat: "This conversation",
  installation: "This installation",
  provider: "Provider settings",
  runtime: "Runtime settings",
  channel: "Channel settings",
  remediation: "Repair",
  capability: "Capabilities",
  improvement: "Improvement",
  product_source: "Product source",
};

export function presentChangePlanScope(value: ChangePlanScope): string {
  return changePlanScopes[value] ?? "Other";
}

const messageRoles: Readonly<Record<string, string>> = { user: "You", assistant: "Assistant", system: "System" };

export function presentMessageRole(value: string): string {
  return messageRoles[value] ?? "Message";
}

const workflowLabels: Readonly<Record<DurableSupportedWorkflowKey, string>> = {
  "chat.turn.execute": "Chat reply",
  "proactive.tick": "Background check-in",
  "approval.wait": "Approval wait",
  "connector.delivery": "Connector delivery",
  "hook.delivery": "Hook delivery",
  "memory.maintenance": "Memory upkeep",
  "orchestration.plan.execute": "Agent plan",
  "external_side_effect.replay": "Outside change, run again",
  "curator.tick": "Library curation",
};

/** Plain name for a known durable workflow only, so a caller can choose its own fallback. */
export function knownWorkflowName(workflowKey: string): string | undefined {
  return Object.hasOwn(workflowLabels, workflowKey)
    ? workflowLabels[workflowKey as DurableSupportedWorkflowKey]
    : undefined;
}

/** Plain name for a durable workflow; unknown keys read as generic background work. */
export function presentWorkflow(workflowKey: string): string {
  return knownWorkflowName(workflowKey) ?? "Background work";
}

export const memoryCandidateTypeLabels: Readonly<Record<TraceMemoryCandidateType, string>> = {
  fact: "Fact",
  decision: "Decision",
  tool_outcome: "Tool result",
  operator_preference: "Your preference",
  repo_fact: "Repository fact",
  workflow: "Workflow",
};

export const memoryCandidateAuthorityLabels: Readonly<Record<TraceMemoryCandidateAuthority, string>> = {
  agent_proposed: "Proposed by an agent",
  external_channel: "From an outside channel",
  unknown: "Unknown source",
};

const codeRunStatuses: Readonly<Record<CodeModeRunStatus, StatusPresentation>> = {
  approval_pending: status("Waiting on you", "waiting"),
  queued: status("Queued", "neutral"),
  running: status("Running", "running"),
  completed: status("Done", "done"),
  failed: status("Failed", "failed"),
  rejected: status("Denied", "neutral"),
  expired: status("Expired", "neutral"),
};

export function presentCodeRunStatus(value: CodeModeRunStatus): StatusPresentation {
  return codeRunStatuses[value] ?? status("Status unknown", "neutral");
}

/** Curator reviews rate risk low/medium/high; the cockpit shows the shared Safe/Caution/Danger scale. */
export const curatorRiskAsApprovalRisk: Readonly<Record<CuratorReviewItem["risk"], ApprovalRequest["riskLevel"]>> = {
  low: "safe",
  medium: "caution",
  high: "danger",
};

export const callableImpactLabels: Readonly<Record<CuratorReviewItem["callableImpact"], string>> = {
  none: "No change to what agents can call",
  narrows: "Narrows what agents can call",
  widens_after_approval: "Widens what agents can call, after approval",
};

export const improvementEvaluationLabels: Readonly<Record<ImprovementEvaluationStatus, string>> = {
  queued: "Queued",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
};
