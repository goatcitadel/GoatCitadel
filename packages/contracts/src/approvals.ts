export type ApprovalStatus = "pending" | "approved" | "rejected" | "edited";
export type ApprovalExplanationStatus = "not_requested" | "pending" | "completed" | "failed";

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
  createdAt: string;
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
}

export interface ApprovalResolveInput {
  decision: "approve" | "reject" | "edit";
  editedPayload?: Record<string, unknown>;
  resolutionNote?: string;
  resolvedBy: string;
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
  actionType: "tool.invoke";
  request: Record<string, unknown>;
  createdAt: string;
  resolvedAt?: string;
  resolutionStatus?: "pending" | "executed" | "rejected" | "failed";
  result?: Record<string, unknown>;
}

export type RemoteActionTokenState = "pending" | "consumed" | "expired";
export type RemoteActionType = "approval.resolve" | "connector.mutation";

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
