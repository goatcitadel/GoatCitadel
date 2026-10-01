import assert from "node:assert/strict";
import { test } from "node:test";
import { assertMcpEditorOwnerAgreement } from "./cockpit-mcp-editor-proof.mjs";
const fixture = () => {
  const before = { serverId: "server", revision: "a".repeat(64), label: "Before", command: "node", args: ["--version"], enabled: false, category: "development", status: "disconnected", policy: { allow: [] } };
  const owner = { ...before, label: "After", category: "research", revision: "b".repeat(64) };
  return { before, owner, receipt: structuredClone(owner), label: "After", category: "research",
    request: { expectedRevision: before.revision, label: "After", command: "node", enabled: false, category: "research" } };
};
test("requires exact revision and reviewed fields plus independent saved owner", () => {
  assertMcpEditorOwnerAgreement(fixture());
  for (const patch of [{ expectedRevision: "old" }, { label: "wrong" }, { enabled: true }, { category: "other" }, { command: "unreviewed" }, { authType: "token" }]) {
    const value = fixture(); Object.assign(value.request, patch); assert.throws(() => assertMcpEditorOwnerAgreement(value));
  }
});
test("rejects changed unrelated config, runtime execution claims and an unrelated receipt", () => {
  for (const patch of [{ args: [] }, { policy: { allow: ["*"] } }, { status: "connected" }, { serverId: "foreign" }]) {
    const value = fixture(); Object.assign(value.owner, patch); value.receipt = structuredClone(value.owner); assert.throws(() => assertMcpEditorOwnerAgreement(value));
  }
  const value = fixture(); value.receipt.revision = "c".repeat(64); assert.throws(() => assertMcpEditorOwnerAgreement(value));
});
