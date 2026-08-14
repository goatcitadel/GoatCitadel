import type { PermissionSurface } from "./policy.js";

export type AutonomousActivationRiskLevel = "safe" | "caution" | "danger" | "nuclear";
export type AutonomousActivationGrantStatus = "active" | "expired" | "revoked";
/**
 * `subagent_fanout` is deliberately separate from the historical broad
 * capability/tool grants. It is never implied by a legacy grant: automatic
 * fan-out needs an exact, temporary project binding.
 */
export type AutonomousActivationKind = "capability" | "tool" | "mcp_tool" | "code_mode" | "subagent_fanout";

export interface AutonomousActivationGrantRecord {
  grantId: string;
  status: AutonomousActivationGrantStatus;
  workspaceId: string;
  /**
   * Optional for backwards compatibility. Required for `subagent_fanout`,
   * where it is an exact project scope rather than a workspace wildcard.
   */
  projectId?: string;
  surfaces: PermissionSurface[];
  maxRiskLevel: AutonomousActivationRiskLevel;
  capabilityPatterns: string[];
  toolPatterns: string[];
  activationKinds: AutonomousActivationKind[];
  maxActivations?: number;
  usedActivations: number;
  budgetUsd?: number;
  usedBudgetUsd?: number;
  grantor: string;
  reason: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  revokedBy?: string;
  revocationReason?: string;
  lastUsedAt?: string;
  /**
   * Durable aggregate reservation identifiers. Kept with the grant so a
   * recovery can repeat its compare-and-reserve mutation without consuming
   * quota or budget a second time.
   */
  reservationIds?: string[];
}

export interface AutonomousActivationGrantCreateInput {
  workspaceId?: string;
  projectId?: string;
  surfaces?: PermissionSurface[];
  maxRiskLevel: AutonomousActivationRiskLevel;
  capabilityPatterns?: string[];
  toolPatterns?: string[];
  activationKinds?: AutonomousActivationKind[];
  maxActivations?: number;
  budgetUsd?: number;
  grantor: string;
  reason: string;
  expiresAt: string;
}

export interface AutonomousActivationGrantRevokeInput {
  revokedBy: string;
  reason?: string;
}

export interface AutonomousActivationGrantEvaluationInput {
  workspaceId?: string;
  projectId?: string;
  surface: PermissionSurface;
  riskLevel: AutonomousActivationRiskLevel;
  activationKind: AutonomousActivationKind;
  capabilityId?: string;
  toolName?: string;
  estimatedCostUsd?: number;
}

/**
 * One conservative, atomic reservation. `requiredActivations` and
 * `estimatedCostUsd` are totals for the aggregate (not per-child values).
 */
export interface AutonomousActivationGrantReservationInput extends AutonomousActivationGrantEvaluationInput {
  grantId: string;
  requiredActivations: number;
  /** Server-authored, durable idempotency key for an aggregate reservation. */
  reservationId?: string;
}

export interface AutonomousActivationGrantEvaluationResult {
  allowed: boolean;
  matchedGrantId?: string;
  blockers: string[];
  governance: string[];
}
