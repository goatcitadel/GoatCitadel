import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertApprovalModeInspection, assertInboxToastOwnerBinding, assertInboxChangeBinding } from "./cockpit-approval-mode-proof.mjs";

const proof = () => ({ before: { revision: 4, toolApprovalMode: "approve_risky", deploymentProfile: "trusted_local" },
  after: { revision: 4, toolApprovalMode: "approve_risky", deploymentProfile: "trusted_local" },
  rendered: { current: "Current: Ask for risky work · settings revision 4", selection: "approve_risky" }, mutations: [] });
describe("approval rule browser owner assertions", () => {
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
