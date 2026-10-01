import assert from "node:assert/strict";

export function assertBackgroundIdentity({ scope, parent, watcher, detail, child, rail, terminal = false }) {
  assert.equal(parent.runId, scope.parentRunId); assert.equal(parent.status, "completed");
  assert.equal(parent.payload.sessionId, scope.sessionId); assert.equal(parent.payload.workspaceId, scope.workspaceId);
  assert.equal(parent.payload.version, "chat.turn.execute.v2");
  assert.equal(watcher.parentRunId, parent.runId); assert.equal(watcher.source, "chat_delegation");
  assert.equal(detail.run.runId, watcher.metadata.delegationRunId);
  assert.equal(detail.run.parentRunId, scope.parentRunId); assert.equal(detail.run.mode, "sequential");
  assert.deepEqual(detail.run.roles, ["researcher"]);
  assert.equal(detail.run.sessionId, scope.sessionId); assert.equal(detail.steps.length, 1);
  const step = detail.steps[0];
  assert.equal(watcher.watcherId, `delegation-child:${step.stepId}`);
  assert.equal(watcher.metadata.stepId, step.stepId); assert.equal(step.role, "researcher");
  assert.equal(step.durableRunId, watcher.childRunId); assert.equal(child.runId, watcher.childRunId);
  assert.equal(child.workflowKey, "chat.turn.execute"); assert.equal(child.status, terminal ? "cancelled" : "running");
  assert.equal(child.payload.version, "chat.turn.execute.v2");
  assert.equal(child.payload.workspaceId, scope.workspaceId);
  assert.equal(step.childSessionId, watcher.metadata.childSessionId);
  assert.equal(step.childTurnId, watcher.metadata.childTurnId);
  assert.equal(child.payload.sessionId, step.childSessionId); assert.equal(child.payload.turnId, step.childTurnId);
  assert.equal(child.payload.request.parentDelegationStepId, step.stepId);
  assert.equal(child.payload.request.policyRunId, detail.run.runId);
  assert.equal(child.payload.request.policyTaskId, detail.run.taskId);
  assert.deepEqual(child.payload.requestActor, parent.payload.requestActor);
  assert.equal(child.payload.requestActor.actorKind, "operator");
  assert.ok(child.payload.requestActor.actorId);
  for (const payload of [parent.payload, child.payload]) {
    assert.equal(payload.capabilityProfileId, undefined); assert.equal(payload.capabilityProfileHash, undefined);
    assert.match(payload.admissionMaterialSha256, /^[a-f0-9]{64}$/);
    assert.ok(payload.admissionId && payload.sessionIncarnationId);
  }
  assert.equal(child.metadata.remoteWorkerChatContextSha256, undefined);
  assert.equal(rail.version, "durable.background_task_rail.v1");
  assert.deepEqual(rail.scope, { workspaceId: scope.workspaceId, sessionId: scope.sessionId, verified: true });
  assert.equal(rail.parent.runId, parent.runId); assert.equal(rail.tasks.length, 1);
  const task = rail.tasks[0];
  assert.equal(task.watcherId, watcher.watcherId); assert.equal(task.childRunId, child.runId);
  assert.equal(task.watcherState, watcher.state); assert.equal(task.watcherRevision, watcher.revision);
  assert.equal(task.childVersion, child.version); assert.equal(task.canonicalStatus, child.status);
  assert.equal(task.delegationRunId, detail.run.runId); assert.equal(task.delegationStepId, step.stepId);
  assert.equal(task.scope.verified, true); assert.equal(task.scope.workspaceId, scope.workspaceId);
  assert.equal(task.scope.sessionId, child.payload.sessionId);
  assert.deepEqual(task.tools, []); assert.deepEqual(task.approvals, []);
  return task;
}

/** Read-only reconciliation; every retry must be solely a real same-owner lease renewal. */
export async function readConsistentBackgroundIdentity(readSnapshot) {
  let previous;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = await readSnapshot();
    assert.equal(snapshot.rail.tasks.length, 1);
    const task = snapshot.rail.tasks[0];
    if (previous) assertHeartbeatOnlyReadAdvance(previous, snapshot);
    if (task.childVersion === snapshot.child.version) return assertBackgroundIdentity(snapshot);
    assert.equal(snapshot.terminal, false, "Terminal owner reads must already agree.");
    assert.ok(Number.isSafeInteger(snapshot.child.version) && Number.isSafeInteger(task.childVersion));
    assert.ok(task.childVersion > snapshot.child.version, "The later rail cannot precede its canonical child read.");
    previous = snapshot;
  }
  throw new Error("Background canonical child and rail did not agree within four bounded read snapshots.");
}

function assertHeartbeatOnlyReadAdvance(before, after) {
  for (const field of ["scope", "parent", "watcher", "detail", "terminal"])
    assert.deepEqual(after[field], before[field], `Background read reconciliation changed ${field}.`);
  assert.equal(before.terminal, false);
  assert.equal(before.child.status, "running"); assert.equal(after.child.status, "running");
  assert.ok(typeof before.child.leaseOwnerId === "string" && before.child.leaseOwnerId.length > 0);
  const authority = ({ version: _version, leaseHeartbeatAt: _heartbeat, leaseExpiresAt: _expiry,
    updatedAt: _updated, ...rest }) => rest;
  assert.deepEqual(authority(after.child), authority(before.child), "A reconciliation read changed child authority or effects.");
  assert.ok(Number.isSafeInteger(before.child.version) && Number.isSafeInteger(after.child.version));
  assert.ok(after.child.version > before.child.version);
  const oldHeartbeat = Date.parse(before.child.leaseHeartbeatAt), newHeartbeat = Date.parse(after.child.leaseHeartbeatAt);
  const oldExpiry = Date.parse(before.child.leaseExpiresAt), newExpiry = Date.parse(after.child.leaseExpiresAt);
  assert.ok([oldHeartbeat, newHeartbeat, oldExpiry, newExpiry].every(Number.isFinite));
  assert.ok(newHeartbeat > oldHeartbeat && newExpiry > oldExpiry);
  assert.ok(oldExpiry > oldHeartbeat); assert.equal(newExpiry - newHeartbeat, oldExpiry - oldHeartbeat);
  assert.equal(after.child.updatedAt, after.child.leaseHeartbeatAt);
  const railState = ({ generatedAt: _generatedAt, tasks, ...rest }) => ({ ...rest,
    tasks: tasks.map(({ childVersion: _childVersion, ...task }) => task) });
  assert.deepEqual(railState(after.rail), railState(before.rail), "A reconciliation read changed rail authority or effects.");
  assert.ok(Number.isFinite(Date.parse(before.rail.generatedAt)) && Date.parse(after.rail.generatedAt) >= Date.parse(before.rail.generatedAt));
  assert.ok(before.rail.tasks[0].childVersion <= after.child.version, "The independent owner did not confirm the prior rail version.");
}

export function assertBackgroundControl({ before, receipt, request, action, scope, after }) {
  assert.deepEqual(request, { workspaceId: scope.workspaceId, sessionId: scope.sessionId, action,
    expectedWatcherRevision: before.watcherRevision,
    ...(action === "cancel" ? { expectedChildVersion: before.childVersion, reason: "Operator cancelled from cockpit Chat" } : {}) });
  assert.equal(receipt.version, "durable.background_task_control.v1"); assert.equal(receipt.action, action);
  assert.equal(receipt.outcome, "applied"); assert.equal(receipt.watcherId, before.watcherId);
  assert.equal(receipt.childRunId, before.childRunId);
  const committed = receipt.rail.tasks.find(task => task.watcherId === before.watcherId);
  assert.ok(committed); assert.equal(committed.childRunId, before.childRunId);
  assert.equal(after.watcherId, before.watcherId); assert.equal(after.childRunId, before.childRunId);
  assert.ok(committed.watcherRevision >= before.watcherRevision + 1);
  assert.ok(after.watcherRevision >= committed.watcherRevision);
  assert.ok(Number.isSafeInteger(committed.childVersion) && Number.isSafeInteger(after.childVersion));
  assert.ok(committed.childVersion >= before.childVersion + (action === "cancel" ? 1 : 0));
  assert.ok(after.childVersion >= committed.childVersion);
  assert.equal(committed.canonicalStatus, action === "cancel" ? "cancelled" : "running");
  assert.equal(after.canonicalStatus, committed.canonicalStatus);
  assert.equal(committed.watcherState, action === "detach" ? "detached" : "attached");
  assert.equal(after.watcherState, committed.watcherState);
}

/** A heartbeat-only stale child version is the sole public conflict this proof may re-review. */
export function assertBackgroundCancellationConflict({ status, receipt, request, before, after, scope }) {
  assert.equal(status, 409); assert.deepEqual(Object.keys(receipt), ["error"]);
  assert.deepEqual(request, { workspaceId: scope.workspaceId, sessionId: scope.sessionId, action: "cancel",
    expectedWatcherRevision: before.watcherRevision, expectedChildVersion: before.childVersion,
    reason: "Operator cancelled from cockpit Chat" });
  const prefix = `Durable run ${before.childRunId} changed from version ${before.childVersion} to `;
  const suffix = " before cancellation.";
  assert.ok(receipt.error.startsWith(prefix) && receipt.error.endsWith(suffix));
  const version = receipt.error.slice(prefix.length, -suffix.length); assert.match(version, /^\d+$/);
  assert.ok(Number(version) > before.childVersion && Number(version) <= after.childVersion);
  for (const field of ["watcherId", "childRunId", "watcherRevision", "watcherState", "delegationRunId", "delegationStepId"])
    assert.deepEqual(after[field], before[field], `Conflict changed ${field}.`);
  assert.deepEqual(after.scope, before.scope);
  assert.equal(before.canonicalStatus, "running"); assert.equal(after.canonicalStatus, "running");
  assert.equal(after.controls.cancel.enabled, true);
  assert.deepEqual(after.tools, []); assert.deepEqual(after.approvals, []);
}

/** The review becomes stale solely through the running executor's real lease heartbeat. */
export function assertBackgroundLeaseAdvance({ reviewed, before, after, current, providerCounts }) {
  assert.equal(before.runId, reviewed.childRunId); assert.equal(after.runId, reviewed.childRunId);
  assert.equal(before.status, "running"); assert.equal(after.status, "running");
  assert.deepEqual(after.payload, before.payload);
  assert.ok(Number.isSafeInteger(before.version) && Number.isSafeInteger(after.version));
  assert.ok(before.version >= reviewed.childVersion && after.version > before.version);
  assert.ok(Number.isFinite(Date.parse(before.leaseHeartbeatAt)) && Date.parse(after.leaseHeartbeatAt) > Date.parse(before.leaseHeartbeatAt));
  for (const field of ["watcherId", "childRunId", "watcherRevision", "watcherState", "delegationRunId", "delegationStepId", "scope"])
    assert.deepEqual(current[field], reviewed[field], `Lease advancement changed ${field}.`);
  assert.equal(current.canonicalStatus, "running"); assert.ok(current.childVersion >= after.version);
  assert.equal(current.controls.cancel.enabled, true);
  assert.deepEqual(current.tools, []); assert.deepEqual(current.approvals, []);
  assert.equal(providerCounts.childStreams, 1); assert.equal(providerCounts.held, 1); assert.equal(providerCounts.childClosed, 0);
}

export function assertProviderBaseUrlChange({ before, receipt, after, providerId, baseUrl }) {
  assert.ok(Number.isSafeInteger(before.revision) && before.revision >= 0);
  assert.equal(receipt.revision, before.revision + 1); assert.equal(after.revision, receipt.revision);
  // GET includes saved providerConfigs; PATCH returns the public runtime config
  // from Settings (providers), not the editable profile collection.
  for (const config of [before, after]) for (const key of ["providerConfigs", "providers"]) {
    assert.ok(Array.isArray(config[key]), `The canonical GET must expose ${key}.`);
    assert.equal(config[key].filter(item => item.providerId === providerId).length, 1);
    assert.equal(new Set(config[key].map(item => item.providerId)).size, config[key].length);
  }
  const replaceBaseUrl = items => items.map(item => item.providerId === providerId ? { ...item, baseUrl } : item);
  assert.deepEqual(after.providerConfigs, replaceBaseUrl(before.providerConfigs));
  assert.deepEqual(after.providers, replaceBaseUrl(before.providers));
  const { providerConfigs: _savedAfter, ...runtimeAfter } = after;
  assert.deepEqual(receipt, runtimeAfter, "The PATCH runtime receipt differs from independent canonical GET.");
  const { revision: _beforeRevision, providerConfigs: _beforeProfiles, providers: _beforeProviders, ...beforeRoute } = before;
  const { revision: _afterRevision, providerConfigs: _afterProfiles, providers: _afterProviders, ...afterRoute } = after;
  assert.deepEqual(afterRoute, beforeRoute);
}
