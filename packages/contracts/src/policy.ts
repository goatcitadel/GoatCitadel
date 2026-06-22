import type {
  InternalToolCallV1,
  InternalToolResultV1,
  SecretResolutionBoundary,
  ToolAuditRecord,
  ToolExecutionTrustLevel,
} from "./internal-tooling.js";
import type { ContextSourceAttribution } from "./ingestion.js";

export type ToolApprovalMode = "approve_all" | "approve_risky" | "bypass";

export type ToolProfile = "minimal" | "standard" | "coding" | "ops" | "research" | "chat-agent" | "danger";

export type FilesystemReadAccessMode = "roots_only" | "approval_required" | "full_disk";

export type PermissionProfileBuiltinId = "safe" | "trusted_local_power";
export type PermissionProfileStatus = "active" | "archived";
export type PermissionProfileScope = "global" | "operator" | "workspace";
export type PermissionProfileCreateScope = Exclude<PermissionProfileScope, "global">;
export type PermissionProfileActivationScope = "operator" | "workspace" | "session";
export type PermissionSurface = "chat" | "cowork" | "code" | "tools" | "mcp" | "all";

export interface PermissionProfileRecord {
  profileId: string;
  label: string;
  description?: string;
  builtin: boolean;
  status: PermissionProfileStatus;
  scope: PermissionProfileScope;
  scopeRef?: string;
  approvalMode: ToolApprovalMode;
  legacyToolProfile?: string;
  toolPatterns: string[];
  allow: string[];
  deny: string[];
  readAccessMode?: FilesystemReadAccessMode;
  defaultForSurfaces?: PermissionSurface[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface PermissionProfileCreateInput {
  label: string;
  description?: string;
  scope?: PermissionProfileCreateScope;
  scopeRef?: string;
  approvalMode: ToolApprovalMode;
  legacyToolProfile?: string;
  toolPatterns?: string[];
  allow?: string[];
  deny?: string[];
  readAccessMode?: FilesystemReadAccessMode;
  defaultForSurfaces?: PermissionSurface[];
  createdBy: string;
}

export interface PermissionProfileUpdateInput {
  label?: string;
  description?: string;
  approvalMode?: ToolApprovalMode;
  legacyToolProfile?: string;
  toolPatterns?: string[];
  allow?: string[];
  deny?: string[];
  readAccessMode?: FilesystemReadAccessMode;
  defaultForSurfaces?: PermissionSurface[];
  updatedBy: string;
}

export interface PermissionProfileActivationRecord {
  activationId: string;
  profileId: string;
  operatorId?: string;
  workspaceId?: string;
  sessionId?: string;
  surface?: PermissionSurface;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionProfileActivationInput {
  profileId: string;
  operatorId?: string;
  workspaceId?: string;
  sessionId?: string;
  surface?: PermissionSurface;
  createdBy: string;
}

export type LocalOperatorOverrideScope = "operator" | "workspace" | "session" | "run";
export type LocalOperatorOverrideStatus = "active" | "expired" | "revoked";

export interface LocalOperatorOverrideRecord {
  overrideId: string;
  operatorId: string;
  scope: LocalOperatorOverrideScope;
  scopeRef?: string;
  reason: string;
  status: LocalOperatorOverrideStatus;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface LocalOperatorOverrideCreateInput {
  operatorId: string;
  scope: LocalOperatorOverrideScope;
  scopeRef?: string;
  reason: string;
  ttlSeconds: number;
  createdBy: string;
}

export interface ToolPolicyActorContext {
  operatorId?: string;
  authActorId?: string;
  authActorSource?: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion" | "a2a_peer";
  permissionProfileId?: string;
  permissionProfile?: PermissionProfileRecord;
  localOperatorOverrideId?: string;
  localOperatorOverride?: LocalOperatorOverrideRecord;
  surface?: PermissionSurface;
  workspaceId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  approvedCodeModeRunId?: string;
  matchedGrantId?: string;
  matchedGrantAllowedHosts?: string[];
  fullWebAccess?: boolean;
}

export type ToolLoopDetectorKind = "repeated_same_call" | "no_progress_polling" | "ping_pong";

export interface ToolLoopDetectionConfig {
  enabled: boolean;
  historySize: number;
  warningThreshold: number;
  criticalThreshold: number;
  globalThreshold: number;
  detectors: Record<ToolLoopDetectorKind, boolean>;
}

/**
 * Intent-based destructive-argument gate. Generalizes the shell-risk pattern to
 * arbitrary tools: a tool is permitted in general but its specific high-risk
 * argument values (e.g. `terraform destroy`) require approval even under a bypass
 * approval mode. Empty/absent config leaves the gate inert (no behavior change).
 */
export interface ToolRiskyArgumentPattern {
  /** Glob over tool names (exact, or trailing `*`, or `*`). e.g. "shell.exec", "terraform.*", "*". */
  toolNamePattern: string;
  /** Dot path into the tool args to test (e.g. "command", "input.operation"). Omit to test the whole args JSON. */
  argumentPath?: string;
  /** Glob patterns matched (case-insensitive, word-bounded) against the resolved argument value. */
  valuePatterns: string[];
}

export interface ToolPolicyConfig {
  profiles?: Record<string, string[]>;
  tools: {
    approvalMode?: ToolApprovalMode;
    profile?: ToolProfile;
    allow: string[];
    deny: string[];
    loopDetection?: ToolLoopDetectionConfig;
  };
  agents: Record<string, { tools?: Partial<ToolPolicyConfig["tools"]> }>;
  sandbox: {
    writeJailRoots: string[];
    readOnlyRoots: string[];
    readAccessMode?: FilesystemReadAccessMode;
    networkAllowlist: string[];
    riskyShellPatterns: string[];
    requireApprovalForRiskyShell: boolean;
    /** Intent-based destructive-argument patterns (generalizes riskyShellPatterns to any tool). */
    riskyArgumentPatterns?: ToolRiskyArgumentPattern[];
  };
}

export interface ToolInvokeRequest {
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  sessionId: string;
  workspaceId?: string;
  taskId?: string;
  runId?: string;
  signal?: AbortSignal;
  trustLevel?: ToolExecutionTrustLevel;
  sourceAttribution?: ContextSourceAttribution[];
  authContext?: {
    boundary?: SecretResolutionBoundary;
    secretRefs?: string[];
  };
  consentContext?: {
    operatorId?: string;
    source?: "ui" | "tui" | "agent";
    reason?: string;
  };
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  surface?: PermissionSurface;
  policyContext?: ToolPolicyActorContext;
  dryRun?: boolean;
  externalRuntime?: boolean;
}

export interface ToolInvokeResult {
  outcome: "executed" | "approval_required" | "blocked";
  approvalId?: string;
  expiresAt?: string;
  policyReason: string;
  auditEventId: string;
  result?: Record<string, unknown>;
  internalCall?: InternalToolCallV1;
  internalResult?: InternalToolResultV1;
  audit?: ToolAuditRecord;
}

export interface EffectiveToolPolicy {
  approvalMode: ToolApprovalMode;
  profile?: string;
  permissionProfileId?: string;
  permissionProfileLabel?: string;
  localOperatorOverrideId?: string;
  allowSet: Set<string>;
  denySet: Set<string>;
  effectiveTools: Set<string>;
  readAccessMode?: FilesystemReadAccessMode;
}

/**
 * Two orthogonal policy axes (the Codex PermissionProfile × AskForApproval shape):
 * sandbox access ("what the agent can touch") is independent of approval escalation
 * ("when to interrupt the human"). The engine already evaluates these independently;
 * these types make the composition explicit and auditable for operator-facing config.
 */
export interface SandboxAccessPolicy {
  filesystemReadMode: FilesystemReadAccessMode;
  networkAllowlist: string[];
  writeJailRoots: string[];
  readOnlyRoots: string[];
  riskyShellPatterns: string[];
  riskyArgumentPatterns: ToolRiskyArgumentPattern[];
}

export interface ApprovalEscalationPolicy {
  approvalMode: ToolApprovalMode;
  requireApprovalForRiskyShell: boolean;
}

export interface ToolPolicyAxes {
  sandbox: SandboxAccessPolicy;
  approval: ApprovalEscalationPolicy;
}
