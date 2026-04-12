export type ApprovalStatus = "pending" | "approved" | "rejected" | "edited";
export type ApprovalExplanationStatus = "not_requested" | "pending" | "completed" | "failed";

export interface ApprovalLinkage {
  sessionId?: string;
  turnId?: string;
  taskId?: string;
  workspaceId?: string;
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
}

export interface ApprovalExplanation {
  summary: string;
  riskExplanation: string;
  saferAlternative?: string;
  generatedAt: string;
  providerId?: string;
  model?: string;
}

export interface ApprovalRequest {
  approvalId: string;
  kind: string;
  riskLevel: "safe" | "caution" | "danger" | "nuclear";
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  linkage?: ApprovalLinkage;
  createdAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
  explanationStatus: ApprovalExplanationStatus;
  explanation?: ApprovalExplanation;
  explanationError?: string;
}

export interface ApprovalCreateInput {
  kind: string;
  riskLevel: ApprovalRequest["riskLevel"];
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  linkage?: ApprovalLinkage;
  expiresAt?: string | null;
}

export type ApprovalEffectKind =
  | "approval_wait_wake"
  | "proactive_run_wake"
  | "linked_chat_turn_wake"
  | "pending_action_execute"
  | "approval_inbox_follow_up"
  | "approval_after_hooks";

export type ApprovalEffectStatus = "pending" | "running" | "completed" | "skipped" | "failed";

export type ApprovalEffectTargetKind = "durable_run" | "chat_turn" | "pending_action" | "remote_token" | "approval";

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
    | "approved_action_executed"
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
  actionType: "tool.invoke" | "code_mode.run";
  request: Record<string, unknown>;
  linkage?: ApprovalLinkage;
  createdAt: string;
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
