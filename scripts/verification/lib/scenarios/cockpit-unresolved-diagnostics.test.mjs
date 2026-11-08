import assert from "node:assert/strict";
import test from "node:test";
import { projectWorkspaceRestoreDiagnostic, retainWorkspaceRestoreDiagnostic } from "./cockpit-workspaces-proof.mjs";
import { projectShellGeometryDiagnostic, retainShellGeometryDiagnostic, captureShellGeometryDiagnostic } from "./cockpit-shell-controls-proof.mjs";
import { projectLocalAiAuditDiagnostic, retainLocalAiAuditDiagnostic, captureLocalAiAuditDiagnostic } from "./cockpit-local-ai-proof.mjs";
const canary = "private-prompt-path-token-canary";
const workspace = () => ({ stage: "restore_confirm", action: "restore", counts: { pointerdown: 1, click: 20_000, directoryReads: 2, parentReads: 1, lifecyclePosts: 0, responses: 0, requestFailures: 0 },
  status: null, ui: { dialogVisible: true, confirmVisible: true, confirmDisabled: false, checking: false },
  owner: { recordPresent: true, revisionMatches: true, parentActive: true }, body: canary, id: canary, url: canary, unknown: canary });
const geometry = () => ({ stage: "inspector_resize", stateWidth: 360,
  outer: { x: 1000, y: 0, width: 360, height: 900 }, body: { x: 1001, y: 48, width: 359, height: 852 },
  handle: { x: 994, y: 0, width: 24, height: 900 }, main: { x: 56, y: 0, width: 944, height: 900 },
  styles: { outerWidth: 360, bodyWidth: 359, borderLeftWidth: 1, borderRightWidth: 0, paddingLeft: 12, paddingRight: 12, boxSizing: "border-box", cssText: canary },
  viewportWidth: 1360, viewportHeight: 900, dpr: 1, animationCount: 0, uiText: canary, personalPath: canary });
const audit = () => ({ stage: "readiness", violations: [{ id: "link-in-text-block", impact: "serious", nodes: [
  { role: "local_ai_setup_link", rect: { x: 10, y: 20, width: 80, height: 20 }, target: [canary], html: canary, failureSummary: canary },
] }], prompt: canary });
test("RED: restore projection keeps fixed owner/count facts and no request, identity or UI content", () => {
  const projected = projectWorkspaceRestoreDiagnostic(workspace());
  assert.equal(projected.format, "workspace-restore-diagnostic.v1");assert.equal(projected.counts.click, 10_000);
  assert.equal(projected.action, "restore");assert.equal(projected.ui.confirmDisabled, false);
  assert.equal(projected.owner.revisionMatches, true);assert.ok(!JSON.stringify(projected).includes(canary));
});
test("RED: shell projection retains exact distinct outer/body geometry without changing the oracle", () => {
  const projected = projectShellGeometryDiagnostic(geometry());
  assert.equal(projected.format, "shell-geometry-diagnostic.v1");assert.equal(projected.outer.width, 360);assert.equal(projected.body.width, 359);
  assert.equal(projected.styles.borderLeftWidth, 1);assert.equal(projected.styles.boxSizing, "border-box");
  assert.ok(!JSON.stringify(projected).includes(canary));
});
test("RED: malformed shell geometry is a bounded explicit gap, not invented measurement", () => {
  const value = geometry();value.outer.width = Infinity;value.styles.boxSizing = canary;
  const projected = projectShellGeometryDiagnostic(value);assert.equal(projected.outer.width, null);
  assert.equal(projected.styles.boxSizing, "other");assert.equal(projected.diagnosticGap, true);
  assert.ok(!JSON.stringify(projected).includes(canary));
});
test("RED: same-audit evidence is bounded to closed rule/impact/role facts while original audit survives", () => {
  const input = audit();input.violations = Array.from({ length: 40 }, () => ({ ...input.violations[0], nodes: Array.from({ length: 40 }, () => input.violations[0].nodes[0]) }));
  const before = structuredClone(input), projected = projectLocalAiAuditDiagnostic(input);
  assert.equal(projected.format, "local-ai-audit-diagnostic.v1");assert.ok(projected.violations.length <= 16);
  assert.ok(projected.violations.every(row => row.nodes.length <= 16));assert.equal(projected.diagnosticGap, true);
  assert.equal(projected.violations[0].nodes[0].role, "local_ai_setup_link");assert.ok(!JSON.stringify(projected).includes(canary));
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 32_768);assert.deepEqual(input, before);
});
test("RED: unknown audit nodes remain explicitly unclassified and cannot invent a safe selector", () => {
  const input = audit();input.violations[0].id = canary;input.violations[0].nodes[0].role = canary;
  const projected = projectLocalAiAuditDiagnostic(input);
  assert.equal(projected.violations[0].id, "other");assert.equal(projected.violations[0].nodes[0].role, "other");
  assert.equal(projected.diagnosticGap, true);assert.ok(!JSON.stringify(projected).includes(canary));
});
test("geometry acquisition failure produces a fixed gap rather than leaking or replacing the failing journey", async () => {
  const captured = await captureShellGeometryDiagnostic({ evaluate: async () => { throw new Error(canary); } }, "inspector_resize");
  assert.equal(captured.diagnosticGap, true);assert.ok(!JSON.stringify(captured).includes(canary));
});
test("same-audit acquisition caps DOM classification work but retains original rule/node counts", async () => {
  const original = audit();original.violations = Array.from({ length: 40 }, () => ({ ...original.violations[0], nodes: Array.from({ length: 40 }, () => original.violations[0].nodes[0]) }));
  const before = structuredClone(original);
  const captured = await captureLocalAiAuditDiagnostic({ evaluate: async (_fn, targets) => {
    assert.equal(targets.length, 128);return targets.map(() => ({ role: "local_ai_setup_link", rect: { x: 1, y: 2, width: 3, height: 4 } }));
  } }, original, "readiness");
  const projected = projectLocalAiAuditDiagnostic(captured);
  assert.equal(projected.violationCount, 40);assert.equal(projected.violations[0].nodeCount, 40);assert.equal(projected.diagnosticGap, true);
  assert.ok(!JSON.stringify(projected).includes(canary));assert.deepEqual(original, before);
});
test("failed same-audit DOM classification retains unknown nodes and an explicit bounded gap", async () => {
  const original = audit(), before = structuredClone(original);
  const captured = await captureLocalAiAuditDiagnostic({ evaluate: async () => { throw new Error(canary); } }, original, "readiness");
  const projected = projectLocalAiAuditDiagnostic(captured);
  assert.equal(projected.diagnosticGap, true);assert.equal(projected.violations[0].nodes[0].role, "other");
  assert.ok(!JSON.stringify(projected).includes(canary));assert.deepEqual(original, before);
});
for (const [name, retain, input] of [["workspace", retainWorkspaceRestoreDiagnostic, workspace], ["shell", retainShellGeometryDiagnostic, geometry], ["local-ai", retainLocalAiAuditDiagnostic, audit]]) {
  test(`RED: ${name} actual diagnostic boundary projects then canonical-redacts before writer`, async () => {
    const order = [];
    const result = await retain(input(), "synthetic-diagnostic.json", {
      redact: async text => { order.push("redact");assert.ok(!text.includes(canary));return "canonical-only"; },
      write: async (file, payload) => { order.push("write");assert.equal(file, "synthetic-diagnostic.json");assert.equal(payload.redactedEvidence, "canonical-only"); },
    });
    assert.deepEqual(order, ["redact", "write"]);assert.equal(result.retained, true);assert.equal(result.writeFailure, false);
  });
  test(`RED: ${name} writer failure settles safely at the actual collector boundary without mutating its evidence`, async () => {
    const evidence = input(), unchanged = structuredClone(evidence);
    const result = await retain(evidence, "synthetic-diagnostic.json", { redact: async () => "canonical-only", write: async () => { throw new Error(canary); } });
    assert.equal(result.retained, false);assert.equal(result.writeFailure, true);assert.ok(!JSON.stringify(result).includes(canary));
    assert.deepEqual(evidence, unchanged);
  });
  test(`RED: ${name} canonical-redactor failure cannot write unredacted evidence`, async () => {
    let writes = 0;
    const result = await retain(input(), "synthetic-diagnostic.json", { redact: async () => { throw new Error(canary); }, write: async () => { writes++; } });
    assert.equal(writes, 0);assert.equal(result.retained, false);assert.equal(result.writeFailure, true);
  });
}
