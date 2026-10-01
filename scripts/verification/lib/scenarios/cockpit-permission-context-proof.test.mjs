import assert from "node:assert/strict";
import { test } from "node:test";
import { assertInertAutonomousGrant, assertAutonomousGrantRevocation } from "./cockpit-permission-context-proof.mjs";

function fixture() {
  const request = {
    workspaceId: "isolated-workspace",
    surfaces: ["tools"],
    maxRiskLevel: "safe",
    capabilityPatterns: ["verification.inert-permission-grant.desktop-1234"],
    toolPatterns: ["verification.inert-permission-tool.desktop-1234"],
    activationKinds: ["capability"],
    maxActivations: 1,
    budgetUsd: 0,
    grantor: "verification",
    reason: "Disposable proof",
    expiresAt: "2099-01-01T00:10:00Z",
  };
  const receipt = {
    ...request,
    grantId: "owner-grant",
    status: "active",
    usedActivations: 0,
    usedBudgetUsd: 0,
    createdAt: "2099-01-01T00:00:00Z",
    updatedAt: "2099-01-01T00:00:00Z",
  };
  return { request, receipt, owner: structuredClone(receipt), prior: [], catalog: [] };
}

test("browser grant setup cannot widen scope, budget or activation and must target an absent exact capability", () => {
  assertInertAutonomousGrant(fixture());
  for (const patch of [
    { surfaces: ["all"] },
    { workspaceId: "*" },
    { maxRiskLevel: "danger" },
    { activationKinds: ["tool"] },
    { capabilityPatterns: ["*"] },
    { toolPatterns: [] },
    { toolPatterns: ["*"] },
    { toolPatterns: ["shell.*"] },
    { budgetUsd: 1 },
    { maxActivations: 2 },
  ]) {
    const value = fixture();
    Object.assign(value.request, patch);
    Object.assign(value.receipt, patch);
    value.owner = structuredClone(value.receipt);
    assert.throws(() => assertInertAutonomousGrant(value));
  }
  const existing = fixture();
  existing.catalog = [{ capabilityId: existing.request.capabilityPatterns[0] }];
  assert.throws(() => assertInertAutonomousGrant(existing));
  const existingTool = fixture();
  existingTool.catalog = [{ toolName: existingTool.request.toolPatterns[0] }];
  assert.throws(() => assertInertAutonomousGrant(existingTool));
  const mismatch = fixture();
  mismatch.owner.workspaceId = "other";
  assert.throws(() => assertInertAutonomousGrant(mismatch));
});

test("revocation evidence preserves exact policy and verifies a fresh unused revoked owner record", () => {
  const before = fixture().receipt;
  const request = { revokedBy: "operator", reason: "Revoked from Settings." };
  const receipt = {
    ...before,
    status: "revoked",
    revokedBy: request.revokedBy,
    revocationReason: request.reason,
    updatedAt: "2099-01-01T00:01:00Z",
    revokedAt: "2099-01-01T00:01:00Z",
  };
  const value = { before, request, receipt, owner: structuredClone(receipt) };
  assertAutonomousGrantRevocation(value);
  for (const patch of [
    { grantId: "foreign" },
    { workspaceId: "foreign" },
    { status: "active" },
    { usedActivations: 1 },
    { capabilityPatterns: ["*"] },
    { revokedBy: "other" },
    { revocationReason: "other" },
  ]) {
    const changed = { ...value, receipt: { ...receipt, ...patch } };
    changed.owner = structuredClone(changed.receipt);
    assert.throws(() => assertAutonomousGrantRevocation(changed));
  }
  const stale = { ...value, owner: structuredClone(before) };
  assert.throws(() => assertAutonomousGrantRevocation(stale));
});
