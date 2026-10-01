import assert from "node:assert/strict";
import { it } from "node:test";
import { Storage } from "../../../../packages/storage/dist/index.js";
import { RECORDED_OPENCODE_REPORT, seedDelegationDisplayRecords, seedRenderingRecords } from "./cockpit-chat-rendering-records.mjs";

function fixture() {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  const now = "2026-09-30T18:00:00.000Z";
  storage.chatSessionMeta.ensure("session", now, "workspace");
  storage.chatTurnTraces.create({ turnId: "turn", sessionId: "session", userMessageId: "message", status: "completed",
    mode: "chat", webMode: "off", memoryMode: "off", thinkingLevel: "off", startedAt: now, finishedAt: now });
  storage.chatSessionBranchState.setActiveLeaf("session", "turn", now);
  return storage;
}

it("records idempotent display evidence without changing runtime authority or effects", () => {
  const storage = fixture();
  try {
    const before = storage.chatTurnTraces.get("turn");
    const scope = { workspaceId: "workspace", sessionId: "session", turnId: "turn" };
    const first = seedRenderingRecords(storage, scope);
    assert.deepEqual(seedRenderingRecords(storage, scope), first);
    const after = storage.chatTurnTraces.get("turn");
    const normalizedTrace = (trace) => ({ ...trace, citations: [],
      capabilityUpgradeSuggestions: trace.capabilityUpgradeSuggestions ?? [],
      specialistCandidateSuggestions: trace.specialistCandidateSuggestions ?? [] });
    assert.deepEqual(normalizedTrace(after), normalizedTrace(before));
    assert.deepEqual(after.citations.map((item) => item.url), ["javascript:alert(1)"]);
    const runs = storage.chatToolRuns.listByTurn("turn");
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].result.externalAgent, RECORDED_OPENCODE_REPORT);
    assert.equal(runs[0].effectPotential, "none");
    assert.equal(runs[0].effectOutcomeKind, "none");
    assert.equal(runs[0].approvalId, undefined);
    assert.equal(after.capabilityProfileId, undefined);
    assert.equal(after.durable, undefined);
  } finally { storage.close(); }
});

it("withholds display fixtures for foreign scope, active-turn drift or unfinished execution", () => {
  const storage = fixture();
  try {
    const scope = { workspaceId: "workspace", sessionId: "session", turnId: "turn" };
    assert.throws(() => seedRenderingRecords(storage, { ...scope, workspaceId: "foreign" }));
    assert.throws(() => seedRenderingRecords(storage, { ...scope, sessionId: "foreign" }));
    assert.throws(() => seedRenderingRecords(storage, { ...scope, turnId: "foreign" }));
    storage.chatTurnTraces.patch("turn", { status: "running" });
    assert.throws(() => seedRenderingRecords(storage, scope));
    assert.equal(storage.chatToolRuns.listByTurn("turn").length, 0);
    assert.equal(storage.chatTurnTraces.get("turn").citations.length, 0);
  } finally { storage.close(); }
});

it("adds terminal delegation display records without worker or child execution authority", () => {
  const storage = fixture();
  try {
    const before = storage.chatTurnTraces.get("turn");
    const scope = { workspaceId: "workspace", sessionId: "session", turnId: "turn" };
    assert.throws(() => seedDelegationDisplayRecords(storage, { ...scope, workspaceId: "foreign" }));
    const display = seedDelegationDisplayRecords(storage, scope);
    const after = storage.chatTurnTraces.get("turn");
    assert.equal(after.orchestration.runId, display.runId);
    assert.equal(after.orchestration.status, "partial");
    assert.deepEqual(after.durable, before.durable);
    assert.equal(after.capabilityProfileId, before.capabilityProfileId);
    assert.equal(after.capabilityProfileHash, before.capabilityProfileHash);
    const run = storage.chatDelegationRuns.get(display.runId);
    assert.equal(run.status, "partial");
    assert.equal(run.parentRunId, undefined);
    const steps = storage.chatDelegationSteps.listByRun(display.runId);
    assert.deepEqual(steps.map((step) => step.status), ["completed", "failed"]);
    for (const step of steps) {
      assert.equal(step.durableRunId, undefined);
      assert.equal(step.childSessionId, undefined);
      assert.equal(step.childTurnId, undefined);
    }
    assert.throws(() => seedDelegationDisplayRecords(storage, scope), /Never replace/u);
    assert.equal(storage.chatToolRuns.listByTurn("turn").length, 0);
  } finally { storage.close(); }
});
