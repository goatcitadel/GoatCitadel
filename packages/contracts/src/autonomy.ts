import type { PermissionSurface } from "./policy.js";

export type AutonomousActivationRiskLevel = "safe" | "caution" | "danger" | "nuclear";
export type AutonomousActivationGrantStatus = "active" | "expired" | "revoked";
export type AutonomousActivationKind = "capability" | "tool" | "mcp_tool" | "code_mode";

export interface AutonomousActivationGrantRecord {
  grantId: string;
  status: AutonomousActivationGrantStatus;
  workspaceId: string;
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
}

export interface AutonomousActivationGrantCreateInput {
  workspaceId?: string;
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
  surface: PermissionSurface;
  riskLevel: AutonomousActivationRiskLevel;
  activationKind: AutonomousActivationKind;
  capabilityId?: string;
  toolName?: string;
  estimatedCostUsd?: number;
}

export interface AutonomousActivationGrantEvaluationResult {
  allowed: boolean;
  matchedGrantId?: string;
  blockers: string[];
  governance: string[];
}
