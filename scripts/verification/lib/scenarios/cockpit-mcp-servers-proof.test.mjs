import assert from "node:assert/strict";
import { it } from "node:test";
import { assertMcpEnabledSaved } from "./cockpit-mcp-servers-proof.mjs";
const before = { serverId: "fixture", revision: "a".repeat(64), enabled: false, label: "Fixture", command: "node", status: "disconnected", policy: { requireFirstToolApproval: true } };
const after = { ...before, revision: "b".repeat(64), enabled: true };
const fixture = () => ({ before, after, receipt: after, request: { expectedRevision: before.revision, enabled: true }, enabled: true });
it("accepts exact canonical saved MCP enabled state", () => assert.doesNotThrow(() => assertMcpEnabledSaved(fixture())));
it("rejects stale revisions, extra mutations and substituted configuration", () => {
  assert.throws(() => assertMcpEnabledSaved({ ...fixture(), after: { ...after, revision: before.revision } }));
  assert.throws(() => assertMcpEnabledSaved({ ...fixture(), request: { ...fixture().request, command: "other" } }));
  assert.throws(() => assertMcpEnabledSaved({ ...fixture(), after: { ...after, command: "other" } }));
});
it("does not call a connection attempt proof of saved-only configuration", () => {
  assert.throws(() => assertMcpEnabledSaved({ ...fixture(), after: { ...after, status: "connected" } }));
  assert.throws(() => assertMcpEnabledSaved({ ...fixture(), receipt: before }));
});
