import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCESSIBILITY_EVIDENCE_BYTE_LIMIT, captureAccessibilityEvidence } from "./ux-budget-accessibility-evidence.mjs";

const identityRedactor = async () => ({ redactSecretText: (value) => ({ value }) });
function input(audit = { violations: [] }) {
  return { artifactRoot: "/safe-artifacts", scenarioId: "ux-budgets.cockpit-inbox-document-proposal.desktop",
    variant: "desktop", phase: "document-review", workspaceId: "workspace", proposalId: "proposal",
    viewport: { width: 1440, height: 900 }, overflow: { pass: true, overflow: 0 }, audit };
}
function recorder() {
  const writes = [];
  return { writes, writeJson: async (file, value) => { writes.push({ file, value }); } };
}
const rule = (id, nodes) => ({ id, impact: "serious", tags: ["wcag22aa"], help: "Explain target", helpUrl: "https://example.test/rule?discard=1#discard", nodes });
const node = (target, html = "<button>Details</button>") => ({ target, html, failureSummary: "Target is too small" });

test("projects every node/target and exact rule counts from the same audit without mutating it", async () => {
  const audit = { testEngine: { name: "axe-core", version: "4.10" }, url: "https://ui.test/inbox?token=not-for-evidence#fragment",
    violations: [rule("target-size", [node(["#one", "#two"]), node([["#frame", "#inside"]])]), rule("contrast", [node(["#third"])])] };
  const before = structuredClone(audit); const output = recorder();
  const result = await captureAccessibilityEvidence(input(audit), output);
  assert.equal(result.complete, true); assert.equal(output.writes.length, 1);
  const evidence = output.writes[0].value;
  assert.deepEqual(evidence.counts, { expectedViolations: 2, writtenViolations: 2, expectedNodes: 3, writtenNodes: 3 });
  assert.deepEqual(evidence.violations.map((entry) => [entry.expectedNodes, entry.writtenNodes]), [[2, 2], [1, 1]]);
  assert.deepEqual(evidence.violations[0].nodes.map((entry) => entry.target), [["#one", "#two"], [["#frame", "#inside"]]]);
  assert.equal(evidence.url, "https://ui.test/inbox"); assert.equal(evidence.testEngine.version, "4.10");
  assert.deepEqual(audit, before); assert.equal(result.relativePath, "diagnostics/ux-budgets.cockpit-inbox-document-proposal.desktop-document-review-axe.json");
});

test("retains complete evidence for an empty audit", async () => {
  const output = recorder(); const result = await captureAccessibilityEvidence(input(), output);
  assert.equal(result.complete, true); assert.equal(output.writes[0].value.counts.expectedNodes, 0);
  assert.deepEqual(output.writes[0].value.violations, []);
});

test("canonical redaction protects every string, URL, HTML, target and supplied short fixture secrets before any write", async () => {
  const fixtureSecret = "tiny-secret"; const labeled = "password=syntheticSensitiveValue";
  const audit = { testEngine: { name: labeled, version: fixtureSecret }, url: "https://name:syntheticSensitiveValue@ui.test/inbox?password=syntheticSensitiveValue#tiny-secret",
    violations: [rule(fixtureSecret, [node([fixtureSecret, labeled, '[value="target-private-value"]'], '<input value="unlabeled-field-value" data-key="password=syntheticSensitiveValue"><textarea>private textarea value</textarea>')])] };
  audit.violations[0].failureSummary = labeled;
  audit.violations[0].nodes[0].failureSummary = labeled + " " + fixtureSecret;
  audit.violations[0].help = labeled; audit.violations[0].tags = [fixtureSecret];
  const output = recorder(); const result = await captureAccessibilityEvidence({ ...input(audit), workspaceId: fixtureSecret, sensitiveValues: [fixtureSecret] }, output);
  assert.equal(result.complete, true);
  for (const write of output.writes) {
    const serialized = JSON.stringify(write.value);
    for (const secret of [fixtureSecret, "syntheticSensitiveValue", "unlabeled-field-value", "private textarea value", "target-private-value"]) assert.equal(serialized.includes(secret), false);
    assert.match(serialized, /REDACTED/); assert.equal(serialized.includes("?password="), false);
  }
});

test("bounds the exact pretty-serialized sanitized report at 8 MiB, retaining all nodes at the boundary", async () => {
  const audit = { violations: [rule("target-size", [node(["#one"], "x")])] };
  const probe = recorder(); await captureAccessibilityEvidence(input(audit), { ...probe, loadRedactor: identityRedactor });
  const size = Buffer.byteLength(JSON.stringify(probe.writes[0].value, null, 2) + "\n");
  audit.violations[0].nodes[0].html = "x".repeat(1 + ACCESSIBILITY_EVIDENCE_BYTE_LIMIT - size);
  const boundary = recorder(); const result = await captureAccessibilityEvidence(input(audit), { ...boundary, loadRedactor: identityRedactor });
  assert.equal(result.complete, true); assert.equal(result.bytes, ACCESSIBILITY_EVIDENCE_BYTE_LIMIT);
  assert.equal(boundary.writes[0].value.counts.writtenNodes, 1);
  audit.violations[0].nodes[0].html += "x";
  const overflow = recorder(); const gap = await captureAccessibilityEvidence(input(audit), { ...overflow, loadRedactor: identityRedactor });
  assert.equal(gap.complete, false); assert.equal(gap.gapReason, "byte_limit");
  assert.deepEqual(overflow.writes[0].value.counts, { expectedViolations: 1, writtenViolations: 0, expectedNodes: 1, writtenNodes: 0 });
  assert.equal(JSON.stringify(overflow.writes[0].value).includes("#one"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(overflow.writes[0].value, null, 2) + "\n") < 4096);
});

for (const failure of ["redactor_unavailable", "redaction_failure", "serialization_failure"]) {
  test(failure + " writes only a fixed safe gap envelope and does not echo error content", async () => {
    const output = recorder(); const options = { ...output };
    if (failure === "redactor_unavailable") options.loadRedactor = async () => { throw new Error("password=neverWriteThisValue"); };
    if (failure === "redaction_failure") options.loadRedactor = async () => ({ redactSecretText() { throw new Error("password=neverWriteThisValue"); } });
    if (failure === "serialization_failure") { options.loadRedactor = identityRedactor; options.serialize = () => { throw new Error("password=neverWriteThisValue"); }; }
    const result = await captureAccessibilityEvidence(input({ violations: [rule("target-size", [node(["#secret"], "password=neverWriteThisValue")])] }), options);
    assert.equal(result.complete, false); assert.equal(result.gapReason, failure);
    assert.equal(output.writes[0].value.counts.expectedNodes, 1); assert.equal(output.writes[0].value.counts.writtenNodes, 0);
    assert.equal(JSON.stringify(output.writes).includes("neverWriteThisValue"), false);
  });
}

test("writer rejection attempts a safe gap envelope; persistent failure is an explicit unlinked gap", async () => {
  const writes = []; let calls = 0;
  const result = await captureAccessibilityEvidence(input(), { loadRedactor: identityRedactor, writeJson: async (file, value) => {
    writes.push({ file, value }); if (++calls === 1) throw new Error("password=neverWriteThisValue");
  } });
  assert.equal(result.complete, false); assert.equal(result.gapReason, "write_failure"); assert.equal(writes.length, 2);
  assert.equal(writes[1].value.complete, false); assert.ok(result.relativePath);
  const missing = await captureAccessibilityEvidence(input(), { loadRedactor: identityRedactor, writeJson: async () => { throw new Error("password=neverWriteThisValue"); } });
  assert.equal(missing.complete, false); assert.equal(missing.gapReason, "write_failure"); assert.equal(missing.relativePath, undefined);
  assert.equal(JSON.stringify(missing).includes("neverWriteThisValue"), false);
});

for (const overrides of [{ scenarioId: "../escape" }, { phase: "../escape" }, { variant: "../../mobile" }, { scenarioId: "ux-budgets.cockpit-inbox-document-proposal.mobile" }]) {
  test("rejects untrusted filename identity " + JSON.stringify(overrides), async () => {
    const output = recorder(); await assert.rejects(captureAccessibilityEvidence({ ...input(), ...overrides }, output), /Invalid accessibility evidence identity/);
    assert.equal(output.writes.length, 0);
  });
}

test("a malformed audit never leaks a throwing getter into an evidence write", async () => {
  const output = recorder(); const audit = { get violations() { throw new Error("password=neverWriteThisValue"); } };
  const result = await captureAccessibilityEvidence(input(audit), output);
  assert.equal(result.complete, false); assert.equal(result.gapReason, "audit_projection");
  assert.equal(output.writes[0].value.counts.expectedNodes, null); assert.equal(output.writes[0].value.counts.writtenNodes, 0);
  assert.equal(JSON.stringify(output.writes).includes("neverWriteThisValue"), false);
});

test("an incompatible serializer cannot under-report the atomic writer's actual JSON size", async () => {
  const output = recorder();
  const result = await captureAccessibilityEvidence(input({ violations: [rule("target-size", [node(["#one"])])] }),
    { ...output, loadRedactor: identityRedactor, serialize: () => "" });
  assert.equal(result.complete, false); assert.equal(result.gapReason, "serialization_failure");
  assert.equal(output.writes[0].value.complete, false); assert.equal(output.writes[0].value.counts.writtenNodes, 0);
});
