import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPermissionActivationOwnerAgreement } from "./cockpit-permission-profile-proof.mjs";

const fixture = () => ({ workspaceId: "workspace", reviewed: { input: { operation: "activate", workspaceId: "workspace", surface: "chat" },
  target: { workspaceId: "workspace", operatorId: "operator" }, profile: { profileId: "safe", revision: "a".repeat(64) }, revision: "b".repeat(64) },
request: { profileId: "safe", workspaceId: "workspace", surface: "chat", expectedProfileRevision: "a".repeat(64), expectedSelectionRevision: "b".repeat(64) },
receipt: { activationId: "activation", active: true, workspaceId: "workspace", operatorId: "operator", surface: "chat", profileId: "safe" },
effective: { permissionProfile: { profileId: "safe" } } });

test("requires exact reviewed workspace, profile and both CAS revisions plus owner readback", () => {
  assertPermissionActivationOwnerAgreement(fixture());
  for (const field of ["workspaceId", "profileId", "surface", "expectedProfileRevision", "expectedSelectionRevision"]) {
    const value = fixture(); value.request[field] = "wrong";
    assert.throws(() => assertPermissionActivationOwnerAgreement(value));
  }
});
test("rejects a foreign actor/session receipt, inactive result, or unrelated effective policy", () => {
  for (const patch of [{ operatorId: "foreign" }, { sessionId: "invented" }, { active: false }, { workspaceId: "foreign" }, { profileId: "other" }]) {
    const value = fixture(); Object.assign(value.receipt, patch);
    assert.throws(() => assertPermissionActivationOwnerAgreement(value));
  }
  const value = fixture(); value.effective.permissionProfile.profileId = "other";
  assert.throws(() => assertPermissionActivationOwnerAgreement(value));
});
