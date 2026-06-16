import type { ContextSourceAttribution } from "./ingestion.js";
import type { ToolExecutionTrustLevel } from "./internal-tooling.js";
import type { ToolPolicyActorContext } from "./policy.js";
import type { ToolRiskLevel } from "./tools.js";

// "citadel"/"chamber" let a grant be scoped to a protected Citadel space (= workspace
// extended with a Charter) or one of its Chambers. They are additive and dormant by
// default: a request only produces these scope candidates when it carries a citadelId/
// chamberId, which nothing on the request path sets yet — so existing decisions are
// unchanged until the scope is threaded onto requests.
export type ToolGrantScope = "global" | "session" | "workspace" | "agent" | "task" | "citadel" | "chamber";
export type ToolGrantDecision = "allow" | "deny";
export type ToolGrantType = "one_time" | "ttl" | "persistent";

export interface ToolReferenceRootGrant {
  label: string;
  rootPath: string;
  access: "read_only";
}

export interface ToolGrantConstraints {
  allowedHosts?: string[];
  allowedPaths?: string[];
  referenceRoots?: ToolReferenceRootGrant[];
  maxWritesPerHour?: number;
  maxCallsPerHour?: number;
  mutationAllowed?: boolean;
}

export interface ToolGrantRecord {
  grantId: string;
  toolPattern: string;
  decision: ToolGrantDecision;
  scope: ToolGrantScope;
  scopeRef: string;
  grantType: ToolGrantType;
  constraints?: ToolGrantConstraints;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  usesRemaining?: number;
}

export interface ToolGrantCreateInput {
  toolPattern: string;
  decision: ToolGrantDecision;
  scope: ToolGrantScope;
  scopeRef?: string;
  grantType?: ToolGrantType;
  constraints?: ToolGrantConstraints;
  createdBy: string;
  expiresAt?: string;
  usesRemaining?: number;
}

export interface ToolAccessDecision {
  allowed: boolean;
  reasonCodes: string[];
  requiresApproval: boolean;
  matchedGrantId?: string;
  riskLevel: ToolRiskLevel;
}

export interface ToolAccessEvaluateRequest {
  toolName: string;
  agentId: string;
  sessionId: string;
  workspaceId?: string;
  /** Protected-space scope (= workspaceId once the workspace is a Citadel). Dormant until threaded. */
  citadelId?: string;
  /** A Chamber within the Citadel. Dormant until threaded. */
  chamberId?: string;
  taskId?: string;
  runId?: string;
  args?: Record<string, unknown>;
  trustLevel?: ToolExecutionTrustLevel;
  sourceAttribution?: ContextSourceAttribution[];
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  surface?: ToolPolicyActorContext["surface"];
  policyContext?: ToolPolicyActorContext;
}

export interface ToolAccessEvaluateResponse extends ToolAccessDecision {
  toolName: string;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
}
