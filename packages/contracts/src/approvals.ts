import type { McpElicitationRequest } from "./mcp.js";

export const APPROVAL_EXPIRY_ACTOR_ID = "system:approval-expiry" as const;

export type ApprovalStatus = "pending" | "approved" | "rejected" | "edited";
export type ApprovalExplanationStatus = "not_requested" | "pending" | "completed" | "failed";

export interface ApprovalLinkage {
  sessionId?: string;
  turnId?: string;
  taskId?: string;
  workspaceId?: string;
  runId?: string;
  durableRunId?: string;
  proactiveRunId?: string;
  originSurface?: import("./proactive.js").ProactiveOriginSurface;
  externalReferenceRoots?: import("./proactive.js").ProactiveReferenceRootRecord[];
  correlationId?: string;
  traceId?: string;
  connectorId?: string;
  tokenId?: string;
  toolName?: string;
  actionType?: string;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion" | "a2a_peer" | "mesh_node";
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
}

export interface ApprovalExplanation {
  summary: string;
  riskExplanation: string;
  saferAlternative?: string;
  generatedAt: string;
  providerId?: string;
  model?: string;
}

export type ApprovalFollowUpStatus = "none" | "queued" | ApprovalEffectStatus;

export interface ApprovalFollowUpState {
  status: ApprovalFollowUpStatus;
  effectId?: string;
  effectKind?: ApprovalEffectKind;
  targetKind?: ApprovalEffectTargetKind;
  targetId?: string;
  reason?: string;
  updatedAt?: string;
  completedAt?: string;
}

export type ShellRiskLevel = "info" | "caution" | "danger";

export interface ShellRiskFinding {
  readonly level: ShellRiskLevel;
  readonly label: string;
  readonly explanation: string;
}

export interface ShellExplanationDetail {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly noteLevel?: ShellRiskLevel;
}

export interface ShellCommandExplanation {
  readonly command: string;
  readonly parsed: boolean;
  readonly program?: string;
  readonly summary: string;
  readonly details: readonly ShellExplanationDetail[];
  readonly risks: readonly ShellRiskFinding[];
  readonly highestRisk: ShellRiskLevel;
}

export interface ApprovalRequest {
  approvalId: string;
  kind: string;
  riskLevel: "safe" | "caution" | "danger" | "nuclear";
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  rollbackNote?: string;
  linkage?: ApprovalLinkage;
  createdAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
  explanationStatus: ApprovalExplanationStatus;
  explanation?: ApprovalExplanation;
  explanationError?: string;
  followUp?: ApprovalFollowUpState;
  shellExplanations?: readonly ShellCommandExplanation[];
  /**
   * MCP server-initiated elicitation (clarifying question) surfaced through the
   * approval inbox, so an operator/agent can answer it in-band with other approvals
   * (MCP v2 elicitation). Absent for ordinary tool/action approvals.
   */
  mcpElicitation?: McpElicitationRequest;
}

export interface ApprovalListResponse {
  items: ApprovalRequest[];
  nextCursor?: string;
}

export interface ApprovalCreateInput {
  kind: string;
  riskLevel: ApprovalRequest["riskLevel"];
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  rollbackNote?: string;
  linkage?: ApprovalLinkage;
  expiresAt?: string | null;
}

export type ApprovalEffectKind =
  | "approval_wait_materialize"
  | "approval_wait_wake"
  | "proactive_run_wake"
  | "orchestration_parent_wake"
  | "linked_chat_turn_wake"
  | "pending_action_execute"
  | "approval_inbox_follow_up"
  | "approval_after_hooks"
  | "approval_resolution_signals"
  | "skill_hub_lifecycle_apply"
  | "external_source_knowledge_snapshot_apply"
  | "mesh_capability_activation_apply"
  | "memory_lifecycle_apply"
  | "skill_lifecycle_apply"
  | "capability_lifecycle_apply"
  | "improvement_lifecycle_apply"
  | "approval_observability";

export type ApprovalObservabilityAuditStream = "tool_invocations" | "policy_blocks" | "approvals" | "hooks";

export type ApprovalObservabilityDelivery =
  | {
      kind: "audit";
      stream: ApprovalObservabilityAuditStream;
      payload: Record<string, unknown>;
    }
  | {
      kind: "realtime";
      eventType: string;
      source: string;
      payload: Record<string, unknown>;
      options?: Pick<
        import("./monitoring.js").RealtimeEvent,
        "eventClass" | "eventAuthority" | "links" | "correlationId"
      >;
    };

export interface ApprovalObservabilityEffectInput {
  operationId: string;
  delivery: ApprovalObservabilityDelivery;
}

export interface ApprovalObservabilityAttribution {
  correlationId?: string;
  traceId?: string;
  originSurface?: string;
  actorId?: string;
  deviceId?: string;
  grantId?: string;
  companionSessionId?: string;
}

export interface ApprovalObservabilityEnvelope {
  schemaVersion: "approval_observability.v1";
  deliveryId: string;
  operationId: string;
  occurredAt: string;
  orderIndex: number;
  predecessorDeliveryId?: string;
  attribution?: ApprovalObservabilityAttribution;
  delivery: ApprovalObservabilityDelivery;
}

export type ApprovalEffectStatus = "pending" | "running" | "completed" | "skipped" | "failed";

export type ApprovalEffectTargetKind =
  | "durable_run"
  | "chat_turn"
  | "pending_action"
  | "remote_token"
  | "approval"
  | "skill_hub_operation"
  | "external_source_import_item"
  | "mesh_capability_activation"
  | "memory_record"
  | "skill_state"
  | "capability_candidate"
  | "improvement_operation";

export interface ApprovalEffectRecord {
  effectId: string;
  approvalId: string;
  effectKind: ApprovalEffectKind;
  targetKind: ApprovalEffectTargetKind;
  targetId: string;
  idempotencyKey: string;
  status: ApprovalEffectStatus;
  attemptCount: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  lastError?: string;
  claimedBy?: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ApprovalResolveInput {
  decision: "approve" | "reject" | "edit";
  editedPayload?: Record<string, unknown>;
  resolutionNote?: string;
  resolvedBy: string;
}

export interface ApprovalBulkResolveInput {
  decision: "approve" | "reject";
  resolutionNote?: string;
  resolvedBy: string;
  status?: "pending";
}

export interface ApprovalBulkResolveItemResult {
  approvalId: string;
  outcome: "resolved" | "skipped" | "failed";
  status?: ApprovalStatus;
  error?: string;
}

export interface ApprovalBulkResolveResult {
  decision: "approve" | "reject";
  statusFilter: "pending";
  attemptedCount: number;
  resolvedCount: number;
  skippedCount: number;
  failedCount: number;
  items: ApprovalBulkResolveItemResult[];
}

export interface ApprovalReplayEvent {
  eventId: string;
  approvalId: string;
  eventType:
    | "created"
    | "resolved"
    | "pending_action_registered"
    | "pending_action_refused"
    | "approved_action_executed"
    | "code_mode_execution_claim_lost"
    | "replayed"
    | "explanation_requested"
    | "explanation_generated"
    | "explanation_failed";
  actorId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface PendingApprovalAction {
  approvalId: string;
  actionType: "tool.invoke" | "code_mode.run" | "integration.dry_run_commit";
  request: Record<string, unknown>;
  linkage?: ApprovalLinkage;
  createdAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolutionStatus?: "pending" | "executed" | "rejected" | "failed";
  result?: Record<string, unknown>;
}

export interface ApprovalReplaySnapshot {
  approval: ApprovalRequest;
  events: ApprovalReplayEvent[];
  pendingAction?: PendingApprovalAction;
  durableRunId?: string;
  effects: ApprovalEffectRecord[];
}

export type RemoteActionTokenState = "pending" | "consumed" | "expired";
export type RemoteActionType = "approval.resolve" | "connector.mutation";
export type ApprovalInboxItemState = "pending" | "approved" | "rejected" | "edited" | "expired" | "failed";

export interface RemoteActionTokenRecord {
  tokenId: string;
  actionType: RemoteActionType;
  approvalId?: string;
  connectorId: string;
  mutation: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  state: RemoteActionTokenState;
  consumedAt?: string;
  consumedBy?: string;
}

export interface ApprovalInboxItemRecord {
  inboxItemId: string;
  approvalId: string;
  connectorId: string;
  receiverKind: "mcp";
  receiverId: string;
  tokenId: string;
  token: string;
  actionType: "approval.resolve";
  state: ApprovalInboxItemState;
  approvalKind: string;
  riskLevel: ApprovalRequest["riskLevel"];
  approvalStatus: ApprovalStatus;
  preview: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  lastError?: string;
  deliveryCount: number;
  lastDeliveredAt: string;
}
