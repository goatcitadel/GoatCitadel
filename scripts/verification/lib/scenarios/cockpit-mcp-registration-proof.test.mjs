import assert from "node:assert/strict";
import { test } from "node:test";
import { assertMcpRegistrationAgreement } from "./cockpit-mcp-registration-proof.mjs";
const fixture = () => {
  const request = { label: "Fixture", transport: "stdio", command: "node", args: ["--version"], authType: "none", enabled: false, category: "development", trustTier: "restricted", costTier: "unknown",
    policy: { requireFirstToolApproval: false, redactionMode: "basic", allowedToolPatterns: [], blockedToolPatterns: [], allowedEnvKeys: [] } };
  const receipt = { ...structuredClone(request), serverId: "new-server", revision: "a".repeat(64), status: "disconnected" };
  return { request, receipt, owner: structuredClone(receipt), label: "Fixture", existingIds: ["other"] };
};
test("binds exact disabled registration to a new canonical identity and readback", () => {
  assertMcpRegistrationAgreement(fixture());
  for (const patch of [{ enabled: true }, { args: [] }, { command: "other" }, { authType: "token" }, { trustTier: "trusted" }]) {
    const value = fixture(); Object.assign(value.request, patch); assert.throws(() => assertMcpRegistrationAgreement(value));
  }
});
test("rejects old identities, unbound receipts, changed policy or execution claims", () => {
  for (const patch of [{ serverId: "other" }, { revision: "bad" }, { status: "connected" }, { policy: {} }]) {
    const value = fixture(); Object.assign(value.receipt, patch); value.owner = structuredClone(value.receipt); assert.throws(() => assertMcpRegistrationAgreement(value));
  }
  const value = fixture(); value.owner.revision = "b".repeat(64); assert.throws(() => assertMcpRegistrationAgreement(value));
});
