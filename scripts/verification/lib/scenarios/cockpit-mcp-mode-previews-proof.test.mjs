import assert from "node:assert/strict";
import test from "node:test";
import { assertMcpModePreviewOwnerAgreement } from "./cockpit-mcp-mode-previews-proof.mjs";

function fixture() {
  const tools = Array.from({ length: 21 }, (_, index) => ({ name: `descriptor-${index}` }));
  const items = Array.from({ length: 21 }, (_, index) => ({ id: `template-${index}`, source: "template" }));
  return {
    manifest: { generatedAt: "2026-09-30T00:00:00Z", readOnly: true, mutationSemantics: "none", protocol: "mcp",
      evidence: { catalogScope: "callable" }, summary: { exportedToolDescriptors: tools.length }, tools },
    remote: { generatedAt: "2026-09-30T00:00:02Z", readOnly: true, mutationSemantics: "none",
      summary: { remoteServers: 0, remoteTemplates: items.length }, items },
    rendered: { descriptors: tools.slice(0, 20).map((item) => item.name), records: items.slice(0, 20).map((item) => item.id) },
  };
}
test("accepts independently generated snapshots with exactly bounded owner identities", () => {
  const { manifest, remote, rendered } = fixture(); assertMcpModePreviewOwnerAgreement(manifest, remote, rendered);
});
test("rejects broadened invocation semantics and fabricated catalog counts", () => {
  for (const mutation of [(value) => { value.manifest.mutationSemantics = "governed_tool_invocation"; },
    (value) => { value.manifest.evidence.catalogScope = "inspectable"; },
    (value) => { value.remote.summary.remoteServers = 1; }]) {
    const value = fixture(); mutation(value);
    assert.throws(() => assertMcpModePreviewOwnerAgreement(value.manifest, value.remote, value.rendered));
  }
});
test("rejects duplicated or substituted records, stale descriptors and unbounded rendering", () => {
  for (const mutation of [(value) => { value.remote.items[1] = value.remote.items[0]; },
    (value) => { value.rendered.records[0] = "foreign-record"; },
    (value) => { value.rendered.descriptors[0] = "stale-descriptor"; },
    (value) => { value.rendered.records.push("template-20"); }]) {
    const value = fixture(); mutation(value);
    assert.throws(() => assertMcpModePreviewOwnerAgreement(value.manifest, value.remote, value.rendered));
  }
});
