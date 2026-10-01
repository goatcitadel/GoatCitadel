import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPermissionProfileWrite, assertPermissionProfileArchive, assertTemporaryOverrideWrite, assertTemporaryOverrideEnded } from "./cockpit-permission-management-assertions.mjs";

const stamp = "2026-09-30T00:00:00.000Z";
function fixture() {
  const request = { label: "Disposable", description: "Read-only fixture", approvalMode: "approve_all", toolPatterns: ["session.status"],
    allow: ["session.status"], deny: ["shell.*"], readAccessMode: "roots_only", defaultForSurfaces: [], scope: "workspace", scopeRef: "work-a" };
  const receipt = { ...request, profileId: "profile-a", revision: "a".repeat(64), builtin: false, status: "active", createdBy: "operator", createdAt: stamp, updatedAt: stamp };
  return { request, receipt, owner: structuredClone(receipt), workspaceId: "work-a" };
}
test("profile evidence requires exact scope, all submitted fields and independent owner receipt", () => {
  assertPermissionProfileWrite(fixture());
  for (const patch of [{ scopeRef: "foreign" }, { allow: ["*"] }, { approvalMode: "bypass" }, { builtin: true }, { status: "archived" }, { defaultForSurfaces: ["chat"] }]) {
    const value = fixture(); Object.assign(value.receipt, patch); value.owner = structuredClone(value.receipt);
    assert.throws(() => assertPermissionProfileWrite(value));
  }
  const value = fixture(); value.owner.revision = "b".repeat(64); assert.throws(() => assertPermissionProfileWrite(value));
});
test("profile editing evidence requires exact old revision and stable identity", () => {
  const value = fixture(); value.before = structuredClone(value.receipt);
  delete value.request.scope; delete value.request.scopeRef; value.request.expectedRevision = value.before.revision;
  value.receipt.revision = "b".repeat(64); value.owner = structuredClone(value.receipt);
  assertPermissionProfileWrite(value);
  value.request.expectedRevision = "c".repeat(64); assert.throws(() => assertPermissionProfileWrite(value));
  value.request.expectedRevision = value.before.revision; value.receipt.profileId = "foreign"; value.owner = structuredClone(value.receipt);
  assert.throws(() => assertPermissionProfileWrite(value));
});
test("archive evidence cannot adopt another profile or alter preserved rules", () => {
  const before = fixture().receipt;
  const value = { before, request: { expectedRevision: before.revision }, receipt: { archived: true, profileId: before.profileId },
    owner: { ...before, status: "archived", revision: "b".repeat(64), archivedAt: stamp } };
  assertPermissionProfileArchive(value);
  value.owner.allow = ["*"]; assert.throws(() => assertPermissionProfileArchive(value));
});
function overrideFixture() {
  const request = { scope: "workspace", scopeRef: "work-a", reason: "Disposable proof", ttlSeconds: 600 };
  const receipt = { overrideId: "override-a", operatorId: "operator", scope: "workspace", scopeRef: "work-a", reason: request.reason,
    status: "active", createdBy: "operator", createdAt: stamp, expiresAt: "2026-09-30T00:10:00.000Z" };
  return { request, receipt, owner: structuredClone(receipt), workspaceId: "work-a", priorIds: [] };
}
test("temporary override evidence binds exact workspace, reason, fresh ID and owner expiry", () => {
  assertTemporaryOverrideWrite(overrideFixture());
  for (const patch of [{ scopeRef: "foreign" }, { reason: "Other" }, { expiresAt: stamp }, { status: "revoked" }]) {
    const value = overrideFixture(); Object.assign(value.receipt, patch); value.owner = structuredClone(value.receipt);
    assert.throws(() => assertTemporaryOverrideWrite(value));
  }
  const value = overrideFixture(); value.priorIds = [value.receipt.overrideId]; assert.throws(() => assertTemporaryOverrideWrite(value));
});
test("ending evidence requires canonical revoked record and independent active absence", () => {
  const before = overrideFixture().receipt;
  const record = { ...before, status: "revoked", revokedBy: before.operatorId, revokedAt: "2026-09-30T00:01:00.000Z" };
  const value = { before, request: {}, receipt: { revoked: true, overrideId: before.overrideId, status: "revoked", revokedBy: record.revokedBy, revokedAt: record.revokedAt, override: record }, active: [] };
  assertTemporaryOverrideEnded(value);
  value.active = [before]; assert.throws(() => assertTemporaryOverrideEnded(value));
  value.active = []; value.receipt.override.reason = "Other"; assert.throws(() => assertTemporaryOverrideEnded(value));
});
