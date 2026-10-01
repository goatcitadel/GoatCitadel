import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { assertIndependentFork, assertSiblingSelection, assertTimerMutation, providerSnapshot, selectedPath } from "./cockpit-chat-thread-actions-assertions.mjs";

const hash = (content) => createHash("sha256").update(content).digest("hex");
const original = {
  turnId: "source-turn", userMessage: { messageId: "source-user", content: "A recorded message" },
  assistantMessage: { messageId: "source-answer", content: "A recorded answer" }, toolRuns: [], trace: {},
};
const forkProof = () => {
  const sourceSession = { sessionId: "source", workspaceId: "workspace", revision: 3 };
  const mapping = { sourceTurnId: "source-turn", copiedTurnId: "copy-turn", sourceTraceHash: "a".repeat(64), copiedTraceHash: "b".repeat(64) };
  const manifest = {
    manifestVersion: "chat.session-fork-manifest.v1", forkId: "fork", sourceSessionId: "source", sourceTurnId: "source-turn",
    newSessionId: "copy", workspaceId: "workspace", transcriptPathHash: "c".repeat(64), turnMappings: [mapping],
    messageMappings: ["user", "assistant"].map((role) => ({
      sourceMessageId: original[`${role}Message`].messageId, copiedMessageId: `copy-${role}`, sourceTurnId: "source-turn",
      copiedTurnId: "copy-turn", role, contentHash: hash(original[`${role}Message`].content),
    })),
  };
  const session = { sessionId: "copy", workspaceId: "workspace", title: "Fork of source", forkRelationships: [{
    forkId: "fork", direction: "forked_from", relatedSessionId: "source", sourceTurnId: "source-turn", transcriptPathHash: "c".repeat(64),
  }] };
  const copied = { ...structuredClone(original), turnId: "copy-turn",
    userMessage: { ...original.userMessage, messageId: "copy-user" },
    assistantMessage: { ...original.assistantMessage, messageId: "copy-assistant" },
    trace: { routing: { forkImport: { sourceSessionId: "source", sourceTurnId: "source-turn", sourceTraceHash: "a".repeat(64) } } },
  };
  return { sourceSession, sourceThread: { sessionId: "source", activeLeafTurnId: "source-turn", turns: [structuredClone(original)] },
    sourceTurnId: "source-turn", response: { session, manifest }, ownerSession: structuredClone(session),
    forkThread: { sessionId: "copy", activeLeafTurnId: "copy-turn", turns: [copied] }, request: { expectedRevision: 3, title: "Fork of source" } };
};

describe("cockpit independent Fork proof", () => {
  it("requires a distinct canonical session with exact manifest and copied message hashes", () => assert.doesNotThrow(() => assertIndependentFork(forkProof())));
  it("rejects wrong source scope, substituted parent, duplicate session, and stale revision", () => {
    for (const change of [
      (proof) => { proof.response.manifest.workspaceId = "foreign"; },
      (proof) => { proof.response.manifest.sourceTurnId = "other"; },
      (proof) => { proof.response.session.sessionId = "source"; },
      (proof) => { proof.request.expectedRevision = 2; },
      (proof) => { proof.ownerSession.forkRelationships[0].forkId = "other"; },
    ]) { const proof = forkProof(); change(proof); assert.throws(() => assertIndependentFork(proof)); }
  });
  it("rejects altered content, missing copies, reused message IDs, and replayed execution authority", () => {
    for (const change of [
      (proof) => { proof.forkThread.turns[0].assistantMessage.content = "Not the copied answer"; },
      (proof) => { proof.forkThread.turns = []; },
      (proof) => { proof.forkThread.turns[0].userMessage.messageId = "source-user"; },
      (proof) => { proof.forkThread.turns[0].trace.durable = { runId: "source-run" }; },
      (proof) => { proof.forkThread.turns[0].toolRuns = [{ toolRunId: "source-tool" }]; },
      (proof) => { proof.response.manifest.messageMappings[0].contentHash = "d".repeat(64); },
    ]) { const proof = forkProof(); change(proof); assert.throws(() => assertIndependentFork(proof)); }
  });
  it("does not accept a broken or cyclic selected path", () => {
    assert.throws(() => selectedPath({ activeLeafTurnId: "missing", turns: [original] }));
    assert.throws(() => selectedPath({ activeLeafTurnId: "source-turn", turns: [{ ...original, parentTurnId: "missing" }] }));
    assert.throws(() => selectedPath({ activeLeafTurnId: "source-turn", turns: [{ ...original, parentTurnId: "source-turn" }] }));
  });
});

const siblingProof = () => {
  const parent = { turnId: "parent", userMessage: { content: "Shared prefix" }, branch: { isSelectedPath: true } };
  const turn = (turnId) => ({ turnId, parentTurnId: "parent", userMessage: { content: `${turnId} message` },
    trace: { sessionId: "fork", turnId }, branch: { isSelectedPath: true, siblingTurnIds: ["left", "right"],
      siblingCount: 2, activeSiblingIndex: turnId === "left" ? 0 : 1 } });
  return { before: { sessionId: "fork", activeLeafTurnId: "right", turns: [structuredClone(parent), turn("right")] },
    after: { sessionId: "fork", activeLeafTurnId: "left", selectedTurnId: "left", turns: [structuredClone(parent), turn("left")] },
    expectedTarget: turn("left"), targetId: "left", otherId: "right" };
};
describe("cockpit sibling selection proof", () => {
  it("accepts a selected-path-only response with an unchanged prefix and known alternate leaf", () => assert.doesNotThrow(() => assertSiblingSelection(siblingProof())));
  it("rejects foreign sessions, changed ancestry, extra siblings, altered target content, and wrong branch bindings", () => {
    for (const change of [
      (proof) => { proof.after.sessionId = "foreign"; },
      (proof) => { proof.after.activeLeafTurnId = "right"; },
      (proof) => { proof.after.turns[1].parentTurnId = "other-parent"; },
      (proof) => { proof.after.turns.push(structuredClone(proof.before.turns[1])); },
      (proof) => { proof.after.turns[0].userMessage.content = "Changed prefix"; },
      (proof) => { proof.after.turns[1].userMessage.content = "Changed leaf"; },
      (proof) => { proof.after.turns[1].branch.isSelectedPath = false; },
      (proof) => { proof.after.turns[1].branch.siblingTurnIds.push("extra"); },
      (proof) => { proof.after.turns[1].branch.activeSiblingIndex = 1; },
      (proof) => { proof.after.turns[1].branch.siblingCount = 3; },
      (proof) => { proof.expectedTarget = undefined; },
    ]) { const proof = siblingProof(); change(proof); assert.throws(() => assertSiblingSelection(proof)); }
  });
});

const timerProof = (cancel = false) => {
  const scope = { workspaceId: "workspace", sessionId: "session" };
  const expected = { dueAt: "2026-10-01T12:00:00.000Z", timezone: "UTC", message: "Disposable timer", cancelOnNextReply: false };
  const previous = { ...scope, ...expected, timerId: "timer", revision: 1, status: "active" };
  const owner = cancel ? { ...previous, revision: 2, status: "cancelled", cancelledAt: "2026-10-01T11:51:00.000Z" } : previous;
  return { receipt: { item: structuredClone(owner) }, owner, request: cancel ? { expectedRevision: 1 } : { ...expected },
    scope, expected, ...(cancel ? { previous } : {}) };
};
describe("provider-free timer lifecycle proof", () => {
  it("requires an exact created record and revision-bound cancellation", () => {
    assert.doesNotThrow(() => assertTimerMutation(timerProof()));
    assert.doesNotThrow(() => assertTimerMutation(timerProof(true)));
  });
  it("rejects foreign scope, changed request values, wrong receipt, and extra mutation fields", () => {
    for (const change of [
      (proof) => { proof.owner.workspaceId = "foreign"; },
      (proof) => { proof.owner.sessionId = "foreign"; },
      (proof) => { proof.owner.message = "Other reminder"; },
      (proof) => { proof.receipt.item.timerId = "other"; },
      (proof) => { proof.request.notificationRuleId = "foreign"; },
    ]) { const proof = timerProof(); change(proof); assert.throws(() => assertTimerMutation(proof)); }
  });
  it("rejects stale cancellation, substituted timer identity, firing, and non-advancing revision", () => {
    for (const change of [
      (proof) => { proof.request.expectedRevision = 2; },
      (proof) => { proof.owner.timerId = "other"; proof.receipt.item.timerId = "other"; },
      (proof) => { proof.owner.firedAt = "2026-10-01T12:00:00.000Z"; proof.receipt.item.firedAt = proof.owner.firedAt; },
      (proof) => { proof.owner.revision = 1; proof.receipt.item.revision = 1; },
    ]) { const proof = timerProof(true); change(proof); assert.throws(() => assertTimerMutation(proof)); }
  });
  it("requires the real recorder and measures provider execution independently of Chat turns", () => {
    assert.throws(() => providerSnapshot(undefined));
    assert.throws(() => providerSnapshot({ completionDispatchRecords: () => [] }));
    let count = 0;
    const stub = { completionDispatchRecords: () => Array(count), imageGenerationDispatches: () => 0 };
    const before = providerSnapshot(stub);
    assert.deepEqual(before, { completions: 0, images: 0 });
    count = 1;
    assert.notDeepEqual(providerSnapshot(stub), before);
  });
});
