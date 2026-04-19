import type {
  InternalToolCallV1,
  InternalToolResultV1,
  SecretResolutionBoundary,
  ToolAuditRecord,
  ToolExecutionTrustLevel,
} from "./internal-tooling.js";
import type { ContextSourceAttribution } from "./ingestion.js";

export type ToolProfile =
  | "minimal"
  | "standard"
  | "coding"
  | "ops"
  | "research"
  | "chat-agent"
  | "danger";

export type FilesystemReadAccessMode =
  | "roots_only"
  | "approval_required"
  | "full_disk";

export type ToolLoopDetectorKind =
  | "repeated_same_call"
  | "no_progress_polling"
  | "ping_pong";

export interface ToolLoopDetectionConfig {
  enabled: boolean;
  historySize: number;
  warningThreshold: number;
  criticalThreshold: number;
  globalThreshold: number;
  detectors: Record<ToolLoopDetectorKind, boolean>;
}

export interface ToolPolicyConfig {
  profiles: Record<string, string[]>;
  tools: {
    profile: ToolProfile;
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
  };
}

export interface ToolInvokeRequest {
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  sessionId: string;
  workspaceId?: string;
  taskId?: string;
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
  dryRun?: boolean;
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
  profile: string;
  allowSet: Set<string>;
  denySet: Set<string>;
  effectiveTools: Set<string>;
}
