import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const hash = (content) => createHash("sha256").update(content).digest("hex");

export function selectedPath(thread, leafTurnId = thread.activeLeafTurnId) {
  const byId = new Map(thread.turns.map((turn) => [turn.turnId, turn]));
  const path = [];
  let current = byId.get(leafTurnId);
  assert.ok(current, "The canonical selected leaf is missing.");
  while (current) {
    assert.ok(!path.some((turn) => turn.turnId === current.turnId), "Cyclic Chat ancestry.");
    path.unshift(current);
    if (current.parentTurnId) assert.ok(byId.has(current.parentTurnId), "The selected path has a missing ancestor.");
    current = current.parentTurnId ? byId.get(current.parentTurnId) : undefined;
  }
  return path;
}

export function assertIndependentFork({ sourceSession, sourceThread, sourceTurnId, response, ownerSession, forkThread, request }) {
  const { session, manifest } = response;
  assert.equal(manifest.manifestVersion, "chat.session-fork-manifest.v1");
  assert.equal(manifest.sourceSessionId, sourceSession.sessionId);
  assert.equal(manifest.sourceTurnId, sourceTurnId);
  assert.equal(manifest.workspaceId, sourceSession.workspaceId);
  assert.equal(manifest.newSessionId, session.sessionId);
  assert.notEqual(session.sessionId, sourceSession.sessionId);
  assert.equal(ownerSession.sessionId, session.sessionId);
  assert.equal(ownerSession.workspaceId, sourceSession.workspaceId);
  assert.equal(ownerSession.title, request.title);
  assert.equal(request.expectedRevision, sourceSession.revision);
  assert.deepEqual(Object.keys(request).sort(), ["expectedRevision", "title"]);
  assert.match(manifest.transcriptPathHash, /^[a-f0-9]{64}$/);
  assert.ok(ownerSession.forkRelationships.some((item) => item.forkId === manifest.forkId
    && item.direction === "forked_from" && item.relatedSessionId === sourceSession.sessionId
    && item.sourceTurnId === sourceTurnId && item.transcriptPathHash === manifest.transcriptPathHash));
  const sourcePath = selectedPath(sourceThread, sourceTurnId);
  assert.deepEqual(manifest.turnMappings.map((item) => item.sourceTurnId), sourcePath.map((turn) => turn.turnId));
  assert.equal(forkThread.sessionId, session.sessionId);
  assert.equal(forkThread.turns.length, sourcePath.length);
  assert.equal(new Set(manifest.turnMappings.map((item) => item.copiedTurnId)).size, sourcePath.length);
  for (const mapping of manifest.turnMappings) {
    const original = sourcePath.find((turn) => turn.turnId === mapping.sourceTurnId);
    const copied = forkThread.turns.find((turn) => turn.turnId === mapping.copiedTurnId);
    assert.ok(copied, "Manifest copy is missing from its canonical thread.");
    assert.ok(!sourceThread.turns.some((turn) => turn.turnId === copied.turnId));
    assert.equal(copied.parentTurnId, mapping.copiedParentTurnId);
    assert.equal(mapping.sourceParentTurnId, original.parentTurnId);
    assert.equal(copied.trace.routing.forkImport.sourceSessionId, sourceSession.sessionId);
    assert.equal(copied.trace.routing.forkImport.sourceTurnId, original.turnId);
    assert.equal(copied.trace.routing.forkImport.sourceTraceHash, mapping.sourceTraceHash);
    assert.match(mapping.sourceTraceHash, /^[a-f0-9]{64}$/);
    assert.match(mapping.copiedTraceHash, /^[a-f0-9]{64}$/);
    assert.equal(copied.trace.durable?.runId, undefined, "Fork replayed imported execution authority.");
    assert.equal(copied.toolRuns.length, 0, "Fork replayed source tool executions.");
    for (const role of ["user", "assistant"]) {
      const before = original[`${role}Message`];
      const after = copied[`${role}Message`];
      if (!before) { assert.equal(after, undefined); continue; }
      const message = manifest.messageMappings.find((item) => item.sourceMessageId === before.messageId);
      assert.ok(message, "Source message is absent from the fork manifest.");
      assert.notEqual(after.messageId, before.messageId);
      assert.equal(message.copiedMessageId, after.messageId);
      assert.equal(message.sourceTurnId, original.turnId);
      assert.equal(message.copiedTurnId, copied.turnId);
      assert.equal(message.role, role);
      assert.equal(after.content, before.content);
      assert.equal(message.contentHash, hash(before.content));
    }
  }
  assert.equal(forkThread.activeLeafTurnId, manifest.turnMappings.at(-1).copiedTurnId);
}

const turnContent = ({ branch: _branch, ...turn }) => turn;

export function assertSiblingSelection({ before, after, targetId, otherId, expectedTarget }) {
  assert.equal(after.sessionId, before.sessionId);
  const priorPath = selectedPath(before), nextPath = selectedPath(after);
  assert.equal(priorPath.length, before.turns.length, "The previous projection must contain only its selected path.");
  assert.equal(nextPath.length, after.turns.length, "The selected projection included an unselected record.");
  assert.equal(nextPath.length, priorPath.length, "Sibling selection changed the path length.");
  assert.deepEqual(nextPath.slice(0, -1).map(turnContent), priorPath.slice(0, -1).map(turnContent), "Sibling selection changed the shared prefix.");
  assert.equal(before.activeLeafTurnId, otherId);
  assert.equal(after.activeLeafTurnId, targetId);
  assert.equal(after.selectedTurnId, targetId);
  const target = nextPath.at(-1), other = priorPath.at(-1);
  assert.equal(target.turnId, targetId);
  assert.ok(expectedTarget && expectedTarget.turnId === targetId, "The target must match a previously observed owner record.");
  assert.deepEqual(turnContent(target), turnContent(expectedTarget), "Sibling selection changed the known target record.");
  assert.ok(!after.turns.some((turn) => turn.turnId === otherId), "The old sibling remained in the selected path.");
  assert.equal(target.parentTurnId, other.parentTurnId);
  assert.ok(nextPath.every((turn) => turn.branch.isSelectedPath));
  assert.deepEqual([...other.branch.siblingTurnIds].sort(), [targetId, otherId].sort());
  assert.deepEqual(target.branch.siblingTurnIds, other.branch.siblingTurnIds);
  assert.equal(target.branch.siblingCount, 2);
  assert.equal(target.branch.activeSiblingIndex, target.branch.siblingTurnIds.indexOf(targetId));
}

export function assertTimerMutation({ receipt, owner, request, scope, expected, previous }) {
  assert.deepEqual(receipt.item, owner, "Timer receipt differs from canonical owner readback.");
  assert.equal(owner.workspaceId, scope.workspaceId);
  assert.equal(owner.sessionId, scope.sessionId);
  assert.ok(owner.timerId);
  assert.ok(Number.isInteger(owner.revision) && owner.revision > 0);
  assert.equal(owner.status, previous ? "cancelled" : "active");
  for (const field of ["dueAt", "timezone", "message", "cancelOnNextReply"]) assert.deepEqual(owner[field], expected[field]);
  assert.equal(owner.notificationRuleId, undefined);
  if (previous) {
    assert.equal(owner.timerId, previous.timerId);
    assert.ok(owner.revision > previous.revision);
    assert.deepEqual(request, { expectedRevision: previous.revision });
    assert.ok(owner.cancelledAt);
    assert.equal(owner.firedAt, undefined);
  } else assert.deepEqual(request, expected);
}

export function providerSnapshot(stub) {
  assert.equal(typeof stub?.completionDispatchRecords, "function", "Provider-free proof requires the lane's deterministic provider recorder.");
  assert.equal(typeof stub?.imageGenerationDispatches, "function");
  return { completions: stub.completionDispatchRecords().length, images: stub.imageGenerationDispatches() };
}
