import type { AutonomousActivationGrantRecord } from "@goatcitadel/contracts";
export const autonomousGrantFixture: AutonomousActivationGrantRecord = {
  grantId: "grant-fixture",
  status: "active",
  workspaceId: "workspace-a",
  surfaces: ["chat"],
  maxRiskLevel: "caution",
  capabilityPatterns: ["skill:review"],
  toolPatterns: [],
  activationKinds: ["capability"],
  maxActivations: 5,
  usedActivations: 1,
  budgetUsd: 2,
  usedBudgetUsd: 0.2,
  grantor: "operator",
  reason: "Reviewed fixture authority",
  expiresAt: "2099-01-01T00:00:00.000Z",
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
};
export const revokedAutonomousGrantFixture: AutonomousActivationGrantRecord = {
  ...autonomousGrantFixture,
  status: "revoked",
  updatedAt: "2026-09-30T00:01:00.000Z",
  revokedAt: "2026-09-30T00:01:00.000Z",
  revokedBy: "operator",
  revocationReason: "Revoked from Settings.",
};
