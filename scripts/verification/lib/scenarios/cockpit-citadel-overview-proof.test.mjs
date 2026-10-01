import assert from "node:assert/strict";
import { it } from "node:test";
import { assertOverviewBriefClipboard, assertOverviewCharterOwner, assertOverviewTemplateOwner } from "./cockpit-citadel-overview-proof.mjs";
const sample = () => {
  const before = { citadelId: "one", revision: "a".repeat(64), record: { name: "One" }, chambers: [{ chamberId: "old", name: "Retained", sensitivity: "private", sealed: false }],
    charter: { purpose: "Old", kind: "team", goals: ["Goal"], boundaries: ["Bound"], successDefinition: ["Success"], defaultChamberId: "old", riskPosture: "balanced", modelPolicyDefault: "hybrid_guarded", createdAt: "today" } };
  const { createdAt: _createdAt, ...input } = before.charter;
  const receipt = { ...before, revision: "b".repeat(64), charter: { ...before.charter, purpose: "Reviewed" } };
  return { before, purpose: "Reviewed", request: { ...input, purpose: "Reviewed", expectedRevision: before.revision }, receipt, owner: structuredClone(receipt) };
};
it("requires exact Charter request, unchanged remaining fields and independent owner", () => {
  assert.doesNotThrow(() => assertOverviewCharterOwner(sample()));
  for (const change of [value => { value.request.expectedRevision = "wrong"; }, value => { value.receipt.charter.defaultChamberId = "wrong"; }, value => { value.owner.revision = "wrong"; }, value => { value.receipt.chambers = []; }]) {
    const value = sample(); change(value); assert.throws(() => assertOverviewCharterOwner(value));
  }
});
it("requires exact template identity/revision and normalized actual structure", () => {
  const before = { ...sample().before, charter: null };
  const template = { id: "personal", revision: "c".repeat(64), name: "Personal", purpose: "Template", kind: "personal", goals: [], boundaries: [], successDefinition: [], chambers: [{ name: "New" }] };
  const receipt = { ...before, revision: "b".repeat(64), charter: { purpose: "Template", kind: "personal", goals: [], boundaries: [], successDefinition: [], riskPosture: "balanced", modelPolicyDefault: "hybrid_guarded" }, chambers: [...before.chambers, { chamberId: "new", name: "New", sensitivity: "private", sealed: false }] };
  const value = { before, template, receipt, owner: structuredClone(receipt), request: { templateId: "personal", expectedRevision: before.revision, expectedTemplateRevision: template.revision } };
  assert.doesNotThrow(() => assertOverviewTemplateOwner(value)); value.request.expectedTemplateRevision = "wrong"; assert.throws(() => assertOverviewTemplateOwner(value));
});
it("binds clipboard to the displayed owner window and installation spend", () => {
  const brief = { citadelId: "one", citadelName: "One", since: "yesterday", generatedAt: "today", approvals: { pendingCount: 0, pending: [] }, activity: { eventsSince: 2, completedSince: 1, failedSince: 0, wardHitsSince: 0 }, spend: { scope: "instance", sinceUsd: 1, sinceTokens: 8, complete: false }, memory: { unavailable: "held" } };
  const markdown = "# Daily brief — One\nWindow: yesterday → today\n\n- Pending approvals: 0\n- Activity: 2 events · 1 completed · 0 failed · 0 ward hits\n- Spend (instance): $1.00 · 8 tokens (partial data)\n- Memory: unavailable (held)";
  assert.doesNotThrow(() => assertOverviewBriefClipboard({ brief, markdown }));
  assert.throws(() => assertOverviewBriefClipboard({ brief, markdown: markdown.replace("today", "stale") }));
  assert.throws(() => assertOverviewBriefClipboard({ brief, markdown: markdown.replace("instance", "Citadel") }));
});
