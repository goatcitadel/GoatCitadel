import type { WardEffect } from "./citadel-wards.js";
import type { ContextSourceAttribution } from "./ingestion.js";
import type { ToolExecutionTrustLevel } from "./internal-tooling.js";
import type { ToolPolicyActorContext } from "./policy.js";
import type { ToolRiskLevel } from "./tools.js";

// "citadel"/"chamber" let a grant be scoped to a protected Citadel operating
// world or one of its Chambers. They are additive: a request only produces these
// scope candidates when the gateway has resolved an effective citadelId/chamberId,
// so legacy unscoped requests continue to use the older scope chain.
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
  /** Protected parent operating-world scope resolved by the gateway when available. */
  citadelId?: string;
  /** A Chamber within the Citadel when a surface is operating inside one. */
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
  /**
   * The raw Citadel Ward effect that matched this action, when a Ward matched
   * with a non-`allow` effect. Surfaced (not persisted) so downstream execution
   * can enforce the previously-silent effects (`require_dry_run`, `route_local`,
   * `redact`) that neither deny nor require_approval already act on. `undefined`
   * when no Ward matched or the match resolved to `allow`.
   */
  wardEffect?: WardEffect;
}
