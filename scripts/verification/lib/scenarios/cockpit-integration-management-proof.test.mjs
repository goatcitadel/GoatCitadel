import assert from "node:assert/strict";
import { it } from "node:test";
import { assertIntegrationManagementReceipt } from "./cockpit-integration-management-proof.mjs";
it("binds metadata saves to exact receipt, owner readback and previous revision", () => {
  const previous = { connectionId: "fixture", catalogId: "productivity.github", revision: "a".repeat(64), enabled: false, label: "Before", config: {} };
  const receipt = { ...previous, revision: "b".repeat(64), label: "After" };
  const args = { previous, submitted: { expectedRevision: previous.revision, label: "After", enabled: false, config: {} }, receipt, observed: receipt };
  assert.doesNotThrow(() => assertIntegrationManagementReceipt(args));
  assert.throws(() => assertIntegrationManagementReceipt({ ...args, observed: previous }));
  assert.throws(() => assertIntegrationManagementReceipt({ ...args, submitted: { ...args.submitted, expectedRevision: "c".repeat(64) } }));
  assert.throws(() => assertIntegrationManagementReceipt({ ...args, receipt: { ...receipt, enabled: true }, observed: { ...receipt, enabled: true } }));
});
