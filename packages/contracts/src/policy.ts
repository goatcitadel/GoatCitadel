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

export interface ToolPolicyConfig {
  profiles: Record<string, string[]>;
  tools: { profile: ToolProfile; allow: string[]; deny: string[] };
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
  taskId?: string;
  signal?: AbortSignal;
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
  policyReason: string;
  auditEventId: string;
  result?: Record<string, unknown>;
}

export interface EffectiveToolPolicy {
  profile: string;
  allowSet: Set<string>;
  denySet: Set<string>;
  effectiveTools: Set<string>;
}
