import assert from "node:assert/strict";
import test from "node:test";
import { assertPolicyEvaluationOwnerAgreement } from "./cockpit-library-policy-proof.mjs";

function fixture() {
  const expected = { toolName: "fs.read", workspaceId: "workspace-a", sessionId: "session-a", agentId: "agent-a",
    surface: "tools", trustLevel: "trusted_operator", args: { path: " ./a b.txt ", start: 0, optional: false, nested: { values: [null, "1", 1] } } };
  return { expected, submitted: structuredClone(expected),
    owner: { toolName: "fs.read", allowed: true, requiresApproval: true, riskLevel: "safe", reasonCodes: ["approval_required"], permissionProfileId: "safe" },
    effective: { workspaceId: "workspace-a", sessionId: "session-a", surface: "tools", permissionProfile: { profileId: "safe" } } };
}

test("policy proof accepts exact context and argument semantics, including omitted arguments", () => {
  assertPolicyEvaluationOwnerAgreement(fixture());
  const value = fixture(); delete value.expected.args; delete value.submitted.args;
  assertPolicyEvaluationOwnerAgreement(value);
  value.submitted.args = {};
  assert.throws(() => assertPolicyEvaluationOwnerAgreement(value), /changed selected identity/u);
});

test("policy proof rejects identity substitution and dropped or normalized argument values", () => {
  for (const field of ["workspaceId", "sessionId", "agentId", "toolName", "surface", "trustLevel"]) {
    const value = fixture(); value.submitted[field] = "foreign";
    assert.throws(() => assertPolicyEvaluationOwnerAgreement(value));
  }
  for (const change of [
    (args) => { args.path = args.path.trim(); },
    (args) => { delete args.optional; },
    (args) => { args.start = "0"; },
    (args) => { args.nested.values[2] = "1"; },
  ]) {
    const value = fixture(); change(value.submitted.args);
    assert.throws(() => assertPolicyEvaluationOwnerAgreement(value));
  }
});

test("policy proof rejects foreign effective context, profile, or override", () => {
  for (const change of [
    (value) => { value.effective.workspaceId = "workspace-b"; },
    (value) => { value.effective.sessionId = "session-b"; },
    (value) => { value.effective.surface = "chat"; },
    (value) => { value.effective.permissionProfile.profileId = "other"; },
    (value) => { value.owner.localOperatorOverrideId = "unexpected"; },
  ]) {
    const value = fixture(); change(value);
    assert.throws(() => assertPolicyEvaluationOwnerAgreement(value));
  }
});

test("policy proof refuses incomplete or mismatched evaluation envelopes", () => {
  for (const change of [
    (owner) => { delete owner.allowed; },
    (owner) => { owner.requiresApproval = "true"; },
    (owner) => { owner.toolName = "fs.write"; },
    (owner) => { owner.riskLevel = "unknown"; },
    (owner) => { owner.reasonCodes = [null]; },
  ]) {
    const value = fixture(); change(value.owner);
    assert.throws(() => assertPolicyEvaluationOwnerAgreement(value));
  }
});
