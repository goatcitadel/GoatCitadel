import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GUIDED_CHANNEL_CATALOG_IDS, assertGuidedChannelCatalog, assertGuidedNarrowCoverage, assertExactChannelPlanHandoff, filterAssertedChannelApprovalConflict, assertResumedChannelDraftEvidence } from "./channel-guided-setup-lane.mjs";
describe("Guided Channels browser proof assertions", () => {
  it("rejects a same-sized catalog that silently loses or adds an adapter", () => {
    const definitions = GUIDED_CHANNEL_CATALOG_IDS.map(catalogId => ({ catalog: { catalogId }, wizard: { introSummary: "Guided preparation", steps: [{}] }, lifecycle: { supportsDrafts: true } }));
    assert.doesNotThrow(() => assertGuidedChannelCatalog(definitions));
    assert.throws(() => assertGuidedChannelCatalog([...definitions.slice(1), { ...definitions[0], catalog: { catalogId: "channel.fake" } }]));
    assert.throws(() => assertGuidedChannelCatalog(definitions.map((item, index) => index ? item : { ...item, wizard: { ...item.wizard, steps: [] } })));
  });
  it("requires real 390-pixel coverage for all fourteen unique adapters", () => {
    const records = GUIDED_CHANNEL_CATALOG_IDS.map(catalogId => ({ catalogId, width: 390, stepId: "identity", title: "Account identity" }));
    assert.doesNotThrow(() => assertGuidedNarrowCoverage(records));
    assert.throws(() => assertGuidedNarrowCoverage(records.slice(1)));
    assert.throws(() => assertGuidedNarrowCoverage([...records.slice(1), records[1]]));
    assert.throws(() => assertGuidedNarrowCoverage(records.map((item, index) => index ? item : { ...item, width: 1440 })));
    assert.throws(() => assertGuidedNarrowCoverage(records.map((item, index) => index ? item : { ...item, stepId: "" })));
  });
  it("rejects a generic Chat navigation, another draft, stale revision, or fabricated session origin", () => {
    const plan = { planId: "plan-a", revision: 3, origin: { surface: "settings", workspaceId: "workspace-a" },
      request: { kind: "channel_connection", draftId: "draft-a" }, target: { ownerId: "channel_setup_draft", resourceId: "draft-a" } };
    const input = { plan, workspaceId: "workspace-a", draftId: "draft-a",
      url: "http://127.0.0.1/chat?channelPlan=plan-a&channelDraft=draft-a&channelRevision=3&channelWorkspace=workspace-a" };
    assert.doesNotThrow(() => assertExactChannelPlanHandoff(input));
    assert.throws(() => assertExactChannelPlanHandoff({ ...input, url: "http://127.0.0.1/chat" }));
    assert.throws(() => assertExactChannelPlanHandoff({ ...input, draftId: "draft-b" }));
    assert.throws(() => assertExactChannelPlanHandoff({ ...input, plan: { ...plan, revision: 4 } }));
    assert.throws(() => assertExactChannelPlanHandoff({ ...input, plan: { ...plan, origin: { ...plan.origin, sessionId: "made-up-chat" } } }));
  });
});

describe("exact asserted approval-conflict console binding", () => {
  const requestPath = "/api/v1/change-plans/plan-a/responses";
  const resourceError = { type: "error", text: "Failed to load resource: the server responded with a status of 409 (Conflict)",
    timestamp: "2026-10-09T04:05:03.000Z", location: { path: requestPath } };
  const record = { kind: "response", method: "POST", path: requestPath, status: 409, timestamp: "2026-10-09T04:05:02.000Z" };
  const proof = { guardAsserted: true, requestPath, networkRecords: [record], networkEvidenceTruncated: false };
  const snapshot = { consoleMessages: [resourceError], pageErrors: [{ message: "retained page error" }], networkRecords: [record] };
  it("acknowledges one exact asserted POST resource error and retains unrelated errors and page errors", () => {
    const unrelated = { ...resourceError, location: { path: "/api/v1/comms/diagnostics/connection-a" } };
    const arbitrary = { ...resourceError, text: "unexpected application failure" };
    const filtered = filterAssertedChannelApprovalConflict({ ...snapshot, consoleMessages: [resourceError, unrelated, arbitrary] }, proof);
    assert.equal(filtered.acknowledgedCount, 1);
    assert.deepEqual(filtered.snapshot.consoleMessages, [unrelated, arbitrary]);
    assert.deepEqual(filtered.snapshot.pageErrors, snapshot.pageErrors);
    assert.deepEqual(filtered.snapshot.networkRecords, snapshot.networkRecords);
  });
  it("fails closed for missing, unasserted, truncated, wrong-plan, method, status, or duplicate network proof", () => {
    const invalid = [undefined, { ...proof, guardAsserted: false }, { ...proof, networkEvidenceTruncated: true },
      { ...proof, requestPath: "/api/v1/comms/diagnostics/connection-a" }, { ...proof, networkRecords: [] },
      { ...proof, networkRecords: [{ ...record, path: "/api/v1/change-plans/plan-b/responses" }] },
      { ...proof, networkRecords: [{ ...record, method: "GET" }] },
      { ...proof, networkRecords: [{ ...record, status: 200 }] },
      { ...proof, networkRecords: [{ ...record, timestamp: "unknown" }] },
      { ...proof, networkRecords: [record, record] }];
    for (const input of invalid) {
      assert.equal(filterAssertedChannelApprovalConflict(snapshot, input).acknowledgedCount, 0);
      assert.deepEqual(filterAssertedChannelApprovalConflict(snapshot, input).snapshot.consoleMessages, [resourceError]);
    }
  });
  it("retains duplicate, unbound, other-status, wrong-plan, or preceding console errors", () => {
    const invalid = [[resourceError, { ...resourceError }], [{ ...resourceError, location: undefined }],
      [{ ...resourceError, text: resourceError.text.replace("409 (Conflict)", "500 (Internal Server Error)") }],
      [{ ...resourceError, location: { path: "/api/v1/change-plans/plan-b/responses" } }],
      [{ ...resourceError, timestamp: "2026-10-09T04:05:01.000Z" }]];
    for (const consoleMessages of invalid) {
      const filtered = filterAssertedChannelApprovalConflict({ ...snapshot, consoleMessages }, proof);
      assert.equal(filtered.acknowledgedCount, 0); assert.deepEqual(filtered.snapshot.consoleMessages, consoleMessages);
    }
  });
});

describe("persisted exact draft test resume proof", () => {
  const test = { draftId: "draft-a", draftRevision: 3, evidenceId: "evidence-a", status: "ok", checkedAt: "2026-10-09T04:05:02.000Z",
    probe: { checkedAt: "2026-10-09T04:05:02.000Z", steps: [{ key: "send", label: "Sandbox delivery", status: "pass", providerMessageId: "fixture-receipt" }] },
    finalizationEligibility: { allowed: true, blockingReasons: [] } };
  const input = { draftId: "draft-a", draftRevision: 3, test };
  const evidence = { draftId: "draft-a", draftRevision: 3, currentTest: test,
    items: [{ ...test, phase: "test", createdAt: test.checkedAt }] };
  it("requires the original immutable receipt and current Gateway-authorized probe after reload", () => {
    assert.doesNotThrow(() => assertResumedChannelDraftEvidence(evidence, input));
  });
  it("rejects history-only, foreign owners, stale revisions, different receipts, expired eligibility, or changed probes", () => {
    const invalid = [ { ...evidence, currentTest: undefined }, { ...evidence, draftId: "draft-b" },
      { ...evidence, draftRevision: 4 }, { ...evidence, currentTest: { ...test, draftId: "draft-b" } },
      { ...evidence, currentTest: { ...test, draftRevision: 2 } }, { ...evidence, currentTest: { ...test, evidenceId: "evidence-b" } },
      { ...evidence, currentTest: { ...test, status: "warn" } }, { ...evidence, currentTest: { ...test, checkedAt: "other" } },
      { ...evidence, currentTest: { ...test, probe: { ...test.probe, steps: [] } } },
      { ...evidence, currentTest: { ...test, finalizationEligibility: { allowed: false, blockingReasons: ["Expired"] } } },
      { ...evidence, items: [] }, { ...evidence, items: [{ ...evidence.items[0], phase: "activation" }] },
      { ...evidence, items: [{ ...evidence.items[0], draftId: "draft-b" }] },
      { ...evidence, items: [{ ...evidence.items[0], checkedAt: "other" }] },
      { ...evidence, items: [{ ...evidence.items[0], probe: { ...test.probe, steps: [] } }] } ];
    for (const response of invalid) assert.throws(() => assertResumedChannelDraftEvidence(response, input));
  });
});
