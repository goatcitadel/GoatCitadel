export type ToolExecutionTrustLevel =
  | "trusted_operator"
  | "trusted_workspace"
  | "mixed_untrusted"
  | "untrusted_external";

export type SecretResolutionBoundary = "provider_boundary" | "tool_host_boundary";

export type EgressApprovalState = "not_required" | "approval_required" | "blocked";

export type ToolAuditApprovalMode = "approve_all" | "approve_risky" | "bypass";

export interface EgressDecision {
  target: string;
  hostname: string;
  allowed: boolean;
  approvalState: EgressApprovalState;
  reason: string;
  matchedAllowlistPattern?: string;
}

export interface ToolCapabilityPolicy {
  toolName: string;
  family:
    | "memory"
    | "filesystem_read"
    | "filesystem_write"
    | "network_read"
    | "network_write"
    | "process_execution"
    | "browser_read"
    | "browser_control"
    | "mcp"
    | "comms"
    | "knowledge"
    | "git"
    | "ops"
    | "other";
  usesNetwork: boolean;
  readsFilesystem: boolean;
  mutatesFilesystem: boolean;
  mutatesRemoteState: boolean;
  resolvesSecrets: boolean;
  executesProcess: boolean;
  controlsBrowser: boolean;
  invokesMcp: boolean;
  blocksUntrustedEscalation: boolean;
}

export type ToolErrorKind =
  | "policy_block"
  | "approval_required"
  | "execution_error"
  | "validation_error"
  | "network_block"
  | "leak_scan_block";

export interface InternalToolCallV1 {
  version: "v1";
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  sessionId: string;
  workspaceId?: string;
  taskId?: string;
  trustLevel: ToolExecutionTrustLevel;
  capabilityPolicy: ToolCapabilityPolicy;
  authContext: {
    boundary: SecretResolutionBoundary;
    secretRefs: string[];
  };
  sourceAttribution?: Array<{
    sourceType: string;
    sourceRef: string;
    title?: string;
    backend?: string;
  }>;
  createdAt: string;
}

export interface InternalToolResultV1 {
  version: "v1";
  toolName: string;
  outcome: "executed" | "approval_required" | "blocked";
  errorKind?: ToolErrorKind;
  result?: Record<string, unknown>;
  leakDetections: string[];
  egressDecisions?: EgressDecision[];
  completedAt: string;
}

export interface ToolAuditRecord {
  auditEventId: string;
  toolName: string;
  agentId: string;
  sessionId: string;
  workspaceId?: string;
  taskId?: string;
  trustLevel: ToolExecutionTrustLevel;
  outcome: "executed" | "approval_required" | "blocked";
  policyReason: string;
  reasonCodes?: string[];
  startedAt: string;
  completedAt: string;
  approvalId?: string;
  matchedGrantId?: string;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  approvalMode?: ToolAuditApprovalMode;
  errorKind?: ToolErrorKind;
}
