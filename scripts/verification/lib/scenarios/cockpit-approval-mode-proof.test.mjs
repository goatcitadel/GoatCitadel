import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertApprovalModeInspection, assertApprovalModeBypassReview, assertInboxToastOwnerBinding, assertInboxChangeBinding, assertApprovedDecisionReceipt } from "./cockpit-approval-mode-proof.mjs";

describe("native approved decision receipt", () => {
  const evidence = () => ({ approvalId: "approval-one", decision: { approval: { approvalId: "approval-one", status: "approved" } },
    rendered: "Decision recorded: approved. Follow-on execution needs separate verification.",
    recordHref: "/ops/approvals?approvalId=approval-one&shell=classic" });
  it("accepts the native owner receipt without claiming execution completed", () => {
    assert.doesNotThrow(() => assertApprovedDecisionReceipt(evidence()));
    for (const suffix of ["Follow-on settlement is pending.", "Follow-on work failed. Inspect the persisted outcome before retrying.",
      "Follow-on action is blocked by policy.", "Approval effects settled. Linked work has its own execution outcome."])
      assert.doesNotThrow(() => assertApprovedDecisionReceipt({ ...evidence(), rendered: `Decision recorded: approved. ${suffix}` }));
  });
  it("preserves relative owner query ordering, encoded identity, and navigation context", () => {
    for (const recordHref of ["/ops/approvals?shell=classic&approvalId=approval-one&shellScope=visit",
      "/ops/approvals?approvalId=approval%2Done&workspaceId=default&shell=classic#record"])
      assert.doesNotThrow(() => assertApprovedDecisionReceipt({ ...evidence(), recordHref }));
  });
  for (const [label, recordHref] of Object.entries({
    "foreign absolute origin": "https://foreign.invalid/ops/approvals?approvalId=approval-one",
    "sentinel absolute origin": "http://verification.invalid/ops/approvals?approvalId=approval-one",
    "protocol relative origin": "//foreign.invalid/ops/approvals?approvalId=approval-one",
    "foreign scheme": "file:///ops/approvals?approvalId=approval-one",
    "backslash authority": "/\\foreign.invalid/ops/approvals?approvalId=approval-one",
    "backslash path": "/ops\\approvals?approvalId=approval-one",
    "normalized traversal": "/other/../ops/approvals?approvalId=approval-one",
    "trimmed prefix": " /ops/approvals?approvalId=approval-one",
    "normalized control": "/ops/approvals?approvalId=approval-\none",
    "duplicate substituted identity": "/ops/approvals?approvalId=approval-one&approvalId=other",
    "duplicate identical identity": "/ops/approvals?approvalId=approval-one&approvalId=approval-one",
    "encoded duplicate key": "/ops/approvals?approvalId=approval-one&approval%49d=other",
    "substituted identity": "/ops/approvals?approvalId=other",
    "missing identity": "/ops/approvals?shell=classic",
    "substituted owner": "/ops/runs?approvalId=approval-one",
  })) it(`rejects ${label}`, () => {
    assert.throws(() => assertApprovedDecisionReceipt({ ...evidence(), recordHref }));
  });
  it("rejects missing receipts, wrong decisions, substituted owners, and invented completion", () => {
    for (const mutate of [
      value => { value.rendered = ""; },
      value => { value.rendered = "Approved decision recorded."; },
      value => { value.rendered = "Decision recorded: denied. Follow-on execution needs separate verification."; },
      value => { value.rendered = "Decision recorded: approved. Execution completed."; },
      value => { value.decision.approval.status = "pending"; },
      value => { value.decision.approval.approvalId = "other"; },
      value => { value.recordHref = "/ops/approvals?approvalId=other&shell=classic"; },
    ]) { const value = evidence(); mutate(value); assert.throws(() => assertApprovedDecisionReceipt(value)); }
  });
});

const proof = () => ({ before: { revision: 4, toolApprovalMode: "approve_risky", deploymentProfile: "trusted_local" },
  after: { revision: 4, toolApprovalMode: "approve_risky", deploymentProfile: "trusted_local" },
  rendered: { current: "Current: Ask for risky work · settings revision 4", selection: "approve_risky" }, mutations: [] });
describe("approval rule browser owner assertions", () => {
  it("requires approved Critical risk wording and the complete unchanged consequence and gate disclosure", () => {
    const current = "Change the installation default at settings revision 4. Allowed tools may run without normal prompts. Deny rules, Critical risk and risky-shell approvals, read boundaries, and tool grants remain in force.";
    assert.doesNotThrow(() => assertApprovalModeBypassReview(current, 4));
    for (const token of ["Allowed tools may run without normal prompts.", "Deny rules, ", "Critical risk and ", "risky-shell approvals, ", "read boundaries, ", "and tool grants "])
      assert.throws(() => assertApprovalModeBypassReview(current.replace(token, ""), 4));
    assert.throws(() => assertApprovalModeBypassReview(current, 5));
    assert.throws(() => assertApprovalModeBypassReview(current.replace("Critical risk", "nuclear-risk"), 4));
  });
  it("accepts exact live owner agreement and a cancelled review without a mutation", () => {
    assert.doesNotThrow(() => assertApprovalModeInspection(proof()));
  });
  it("rejects wrong rule, revision, or profile even if the selected UI rule appears correct", () => {
    for (const change of [{ toolApprovalMode: "bypass" }, { revision: 5 }, { deploymentProfile: "remote_hardened" }]) {
      const input = proof();
      assert.throws(() => assertApprovalModeInspection({ ...input, after: { ...input.after, ...change } }));
    }
  });
  it("rejects stale or substituted rendered rule evidence", () => {
    for (const change of [{ current: "Current: Ask every time · settings revision 4" }, { selection: "bypass" }]) {
      const input = proof();
      assert.throws(() => assertApprovalModeInspection({ ...input, rendered: { ...input.rendered, ...change } }));
    }
  });
  it("rejects a mutation even if settings were later restored", () => {
    assert.throws(() => assertApprovalModeInspection({ ...proof(), mutations: ["PATCH /api/v1/settings"] }), /mutation/);
  });
});

describe("retained Inbox invalidation browser assertions", () => {
  const evidence = () => ({ source: { eventId: "approval-event", timestamp: "2026-09-30T14:00:00Z", links: { workspaceId: "w", approvalId: "one" } },
    derived: { afterReady: true, eventType: "inbox.changed", source: "operator_inbox", eventClass: "operational_signal", eventAuthority: "retained_stream",
      timestamp: "2026-09-30T14:00:00Z", links: { workspaceId: "w" }, payload: { sourceEventId: "approval-event", deliveryId: "inbox.changed:approval-event", family: "approvals", scope: "workspace" } } });
  it("accepts exact source identity and minimal linked workspace scope", () => {
    assert.doesNotThrow(() => assertInboxChangeBinding(evidence()));
  });
  it("rejects another source, extra payload, replay, fabricated workspace, or altered occurrence time", () => {
    for (const mutate of [
      (value) => { value.derived.payload.sourceEventId = "other"; },
      (value) => { value.derived.payload.approvalId = "one"; },
      (value) => { value.derived.afterReady = false; },
      (value) => { value.derived.links.workspaceId = "other"; },
      (value) => { value.derived.timestamp = "2026-09-30T14:00:01Z"; },
    ]) { const value = evidence(); mutate(value); assert.throws(() => assertInboxChangeBinding(value)); }
  });
});

describe("approval notification browser owner assertions", () => {
  const evidence = () => {
    const item = { id: "approval:one", title: "Later enriched title", source: { workspaceId: "w", approvalId: "one" } };
    return { item, title: "Current owner title", signal: { afterReady: true, observedAt: 20, links: { approvalId: "one" } },
      reads: [{ status: 200, startedAt: 21, workspaceId: "w", authority: "derived_projection",
        approvals: [{ ...item, title: "Current owner title" }] }] };
  };
  it("binds title to the exact item from a post-signal owner read, allowing later title enrichment", () => {
    assert.doesNotThrow(() => assertInboxToastOwnerBinding(evidence()));
  });
  it("rejects a pre-event response, replay, foreign owner, wrong item, and invented title", () => {
    for (const mutate of [
      (value) => { value.reads[0].startedAt = 19; },
      (value) => { value.signal.afterReady = false; },
      (value) => { value.reads[0].workspaceId = "other"; },
      (value) => { value.reads[0].approvals[0].id = "approval:other"; },
      (value) => { value.title = "Signal text instead of owner title"; },
    ]) { const value = evidence(); mutate(value); assert.throws(() => assertInboxToastOwnerBinding(value)); }
  });
});
