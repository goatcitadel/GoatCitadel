import assert from "node:assert/strict";
import test from "node:test";
import { assertBackgroundIdentity, readConsistentBackgroundIdentity, assertBackgroundControl, assertBackgroundCancellationConflict, assertBackgroundLeaseAdvance, assertProviderBaseUrlChange } from "./cockpit-chat-background-assertions.mjs";
import { startBackgroundChildProvider } from "./cockpit-chat-background-fixture.mjs";

function sample() {
  const scope = { workspaceId: "workspace", sessionId: "parent-session", parentRunId: "parent-run" };
  const authority = { version: "chat.turn.execute.v2", workspaceId: scope.workspaceId,
    admissionId: "admission", sessionIncarnationId: "incarnation", admissionMaterialSha256: "a".repeat(64),
    requestActor: { actorKind: "operator", actorId: "operator-1", operatorId: "operator-1", authActorId: "operator-1", authActorSource: "token" } };
  const parent = { runId: scope.parentRunId, status: "completed", payload: { ...authority, sessionId: scope.sessionId } };
  const child = { runId: "child-run", status: "running", version: 5, workflowKey: "chat.turn.execute", metadata: {},
    payload: { ...structuredClone(authority), sessionId: "child-session", turnId: "child-turn",
      request: { parentDelegationStepId: "step", policyRunId: "delegation", policyTaskId: "task" } } };
  const watcher = { watcherId: "delegation-child:step", revision: 3, parentRunId: parent.runId,
    childRunId: child.runId, source: "chat_delegation", state: "attached",
    metadata: { delegationRunId: "delegation", stepId: "step", childSessionId: "child-session", childTurnId: "child-turn" } };
  const detail = { run: { runId: "delegation", parentRunId: parent.runId, sessionId: scope.sessionId,
    taskId: "task", roles: ["researcher"], mode: "sequential" },
  steps: [{ stepId: "step", role: "researcher", durableRunId: child.runId, childSessionId: "child-session", childTurnId: "child-turn" }] };
  const rail = { version: "durable.background_task_rail.v1", scope: { ...scope, verified: true }, parent: { runId: parent.runId },
    tasks: [{ watcherId: watcher.watcherId, watcherRevision: watcher.revision, watcherState: watcher.state,
      childRunId: child.runId, childVersion: child.version, canonicalStatus: child.status,
      delegationRunId: detail.run.runId, delegationStepId: "step", scope: { workspaceId: scope.workspaceId, sessionId: "child-session", verified: true }, tools: [], approvals: [] }] };
  delete rail.scope.parentRunId;
  return { scope, parent, watcher, detail, child, rail };
}

test("requires exact real parent, step, actor, child and projection identities", () => {
  assert.equal(assertBackgroundIdentity(sample()).watcherId, "delegation-child:step");
  for (const mutate of [
    data => { data.detail.steps[0].role = "Researcher"; },
    data => { data.detail.run.roles = ["Researcher"]; },
    data => { data.watcher.parentRunId = "foreign"; },
    data => { data.detail.run.parentRunId = "foreign"; },
    data => { data.detail.steps[0].childTurnId = "foreign"; },
    data => { data.child.payload.request.policyRunId = "foreign"; },
    data => { data.child.payload.workspaceId = "foreign"; },
    data => { data.child.payload.requestActor.actorId = "foreign"; },
    data => { data.child.payload.capabilityProfileId = "fabricated"; },
    data => { data.child.metadata.remoteWorkerChatContextSha256 = "a".repeat(64); },
    data => { data.rail.tasks[0].scope.verified = false; },
    data => { data.rail.tasks[0].tools.push({ toolName: "host.exec" }); },
    data => { data.rail.tasks.push(structuredClone(data.rail.tasks[0])); },
  ]) { const data = sample(); mutate(data); assert.throws(() => assertBackgroundIdentity(data)); }
});

test("terminal proof cannot pass while canonical child or rail remains running", () => {
  const data = sample(); data.terminal = true;
  assert.throws(() => assertBackgroundIdentity(data));
  data.child.status = "cancelled"; assert.throws(() => assertBackgroundIdentity(data));
  data.rail.tasks[0].canonicalStatus = "cancelled"; assertBackgroundIdentity(data);
});

function transition(action) {
  const data = sample(), before = data.rail.tasks[0];
  const after = { ...before, watcherRevision: before.watcherRevision + 1, childVersion: before.childVersion + (action === "cancel" ? 1 : 0),
    watcherState: action === "detach" ? "detached" : "attached", canonicalStatus: action === "cancel" ? "cancelled" : "running" };
  return { scope: data.scope, action, before, after, request: { workspaceId: data.scope.workspaceId,
    sessionId: data.scope.sessionId, action, expectedWatcherRevision: before.watcherRevision,
    ...(action === "cancel" ? { expectedChildVersion: before.childVersion, reason: "Operator cancelled from cockpit Chat" } : {}) },
  receipt: { version: "durable.background_task_control.v1", action, outcome: "applied", watcherId: before.watcherId,
    childRunId: before.childRunId, rail: { ...data.rail, tasks: [structuredClone(after)] } } };
}

test("control proof binds exact watcher CAS, cancellation version, response and independent readback", () => {
  for (const action of ["detach", "reattach", "cancel"]) assertBackgroundControl(transition(action));
  for (const mutate of [
    data => { data.request.expectedWatcherRevision--; },
    data => { delete data.request.expectedChildVersion; },
    data => { data.receipt.childRunId = "other"; },
    data => { data.after.childRunId = "other"; },
    data => { data.after.canonicalStatus = "running"; },
    data => { data.receipt.rail.tasks[0].watcherRevision = data.before.watcherRevision; },
    data => { data.receipt.rail.tasks[0].childVersion = data.before.childVersion; },
    data => { data.after.childVersion = data.before.childVersion; },
  ]) { const data = transition("cancel"); mutate(data); assert.throws(() => assertBackgroundControl(data)); }
});

test("fresh explicit cancellation review admits only an unchanged running owner with an exact precommit version conflict", () => {
  const sampleConflict = () => {
    const data = transition("cancel");
    data.status = 409;
    data.after = { ...data.before, childVersion: data.before.childVersion + 1, controls: { cancel: { enabled: true } } };
    data.receipt = { error: `Durable run ${data.before.childRunId} changed from version ${data.before.childVersion} to ${data.after.childVersion} before cancellation.` };
    return data;
  };
  assertBackgroundCancellationConflict(sampleConflict());
  for (const mutate of [
    data => { data.status = 500; },
    data => { data.receipt.mutationCommitted = true; },
    data => { data.receipt.error = "Owner unavailable"; },
    data => { data.receipt.error = data.receipt.error.replace("child-run", "foreign"); },
    data => { data.request.expectedChildVersion++; },
    data => { data.after.watcherRevision++; },
    data => { data.after.watcherState = "detached"; },
    data => { data.after.childRunId = "foreign"; },
    data => { data.after.canonicalStatus = "cancelled"; },
    data => { data.after.scope = { workspaceId: "foreign" }; },
    data => { data.after.controls.cancel.enabled = false; },
    data => { data.after.tools = [{ toolName: "host.exec" }]; },
  ]) { const data = sampleConflict(); mutate(data); assert.throws(() => assertBackgroundCancellationConflict(data)); }
});

test("stale review evidence requires an actual advancing lease and unchanged running child without executor cancellation", () => {
  const evidence = () => {
    const data = sample();
    data.child.leaseHeartbeatAt = "2026-10-01T00:00:00.000Z";
    const after = { ...structuredClone(data.child), version: data.child.version + 1, leaseHeartbeatAt: "2026-10-01T00:00:05.000Z" };
    return { reviewed: data.rail.tasks[0], before: data.child, after,
      current: { ...data.rail.tasks[0], childVersion: after.version, controls: { cancel: { enabled: true } } },
      providerCounts: { childStreams: 1, held: 1, childClosed: 0 } };
  };
  assertBackgroundLeaseAdvance(evidence());
  for (const mutate of [
    data => { data.after.leaseHeartbeatAt = data.before.leaseHeartbeatAt; },
    data => { data.after.version = data.before.version; },
    data => { data.after.status = "cancelled"; },
    data => { data.after.runId = "foreign"; },
    data => { data.after.payload.sessionId = "foreign"; },
    data => { data.current.watcherRevision++; },
    data => { data.current.scope = { workspaceId: "foreign" }; },
    data => { data.providerCounts.childStreams++; },
    data => { data.providerCounts.held = 0; },
    data => { data.providerCounts.childClosed = 1; },
  ]) { const data = evidence(); mutate(data); assert.throws(() => assertBackgroundLeaseAdvance(data)); }
});

test("loopback fixture changes only reviewed base URL and one numeric configuration revision", () => {
  const before = { revision: 4, activeProviderId: "verification-stub", activeModel: "model", defaultThinkingLevel: "standard", providerConfigs: [
    { providerId: "verification-stub", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "SYNTHETIC_KEY" },
    { providerId: "other", baseUrl: "http://127.0.0.1:2/v1" },
  ], providers: [
    { providerId: "verification-stub", baseUrl: "http://127.0.0.1:1/v1", hasApiKey: false, apiKeySource: "none" },
    { providerId: "other", baseUrl: "http://127.0.0.1:2/v1", hasApiKey: false, apiKeySource: "none" },
  ] };
  const after = structuredClone(before); after.revision++;
  after.providerConfigs[0].baseUrl = after.providers[0].baseUrl = "http://127.0.0.1:3/v1";
  const { providerConfigs: _profiles, ...receipt } = structuredClone(after);
  const data = { before, receipt, after, providerId: "verification-stub", baseUrl: after.providerConfigs[0].baseUrl };
  assertProviderBaseUrlChange(data);
  // The same shape and exact CAS verify restoration; no fabricated profile receipt.
  const restored = { ...structuredClone(before), revision: after.revision + 1 };
  const { providerConfigs: _restoredProfiles, ...restoreReceipt } = restored;
  assertProviderBaseUrlChange({ before: after, receipt: restoreReceipt, after: restored,
    providerId: data.providerId, baseUrl: before.providerConfigs[0].baseUrl });
  for (const mutate of [
    value => { value.after.providerConfigs[0].apiKeyEnv = "UNRELATED"; },
    value => { value.after.providerConfigs[1].baseUrl = "http://foreign.invalid"; },
    value => { value.after.activeModel = "foreign"; },
    value => { value.after.defaultThinkingLevel = value.receipt.defaultThinkingLevel = "extended"; },
    value => { value.receipt.revision--; },
    value => { value.receipt.providers[0].baseUrl = "http://foreign.invalid"; },
    value => { value.after.providerConfigs.push({ ...value.after.providerConfigs[0] }); },
    value => { delete value.after.providerConfigs; },
    value => { delete value.receipt.providers; },
  ]) { const value = structuredClone(data); mutate(value); assert.throws(() => assertProviderBaseUrlChange(value)); }
});

test("fixture holds only the marked user stream and observes caller cancellation", { timeout: 5_000 }, async () => {
  const marker = "LOCAL_CHILD_HOLD_fixture_unique";
  const fixture = await startBackgroundChildProvider({ marker, model: "model" });
  const controller = new AbortController();
  try {
    const post = body => fetch(`${fixture.baseUrl}/chat/completions`, { method: "POST",
      body: JSON.stringify({ model: "model", ...body }), signal: controller.signal });
    assert.equal((await (await fetch(`${fixture.baseUrl}/models`)).json()).data[0].id, "model");
    await (await post({ stream: false, messages: [{ role: "user", content: marker }] })).json();
    await (await post({ stream: true, messages: [{ role: "system", content: marker }, { role: "user", content: "parent" }] })).text();
    assert.deepEqual(fixture.counts(), { streams: 1, childStreams: 0, childClosed: 0, auxiliary: 1, held: 0 });
    const response = await post({ stream: true, messages: [{ role: "user", content: marker }] });
    assert.equal(response.status, 200); assert.equal(fixture.counts().held, 1);
    const reader = response.body.getReader(); await reader.read(); controller.abort();
    await reader.cancel().catch(() => undefined);
    for (let attempt = 0; attempt < 50 && fixture.counts().held; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(fixture.counts(), { streams: 2, childStreams: 1, childClosed: 1, auxiliary: 1, held: 0 });
  } finally { controller.abort(); await fixture.close(); }
});


function heartbeatReadSnapshot(index, railAhead = false) {
  const data = sample();
  const instant = Date.parse("2026-10-01T00:00:00.000Z") + index * 5_000;
  data.terminal = false;
  data.child.version += index;
  data.child.leaseOwnerId = "actual-same-worker";
  data.child.leaseHeartbeatAt = new Date(instant).toISOString();
  data.child.leaseExpiresAt = new Date(instant + 120_000).toISOString();
  data.child.updatedAt = data.child.leaseHeartbeatAt;
  data.rail.generatedAt = new Date(instant + 1).toISOString();
  data.rail.tasks[0].childVersion = data.child.version + Number(railAhead);
  return data;
}

test("read-only snapshots require exact identity when the child and rail already agree", async () => {
  const data = sample();
  assert.deepEqual(await readConsistentBackgroundIdentity(async () => data), data.rail.tasks[0]);
  const foreign = sample(); foreign.child.payload.requestActor.actorId = "foreign";
  await assert.rejects(readConsistentBackgroundIdentity(async () => foreign));
});

test("reconciles a sequential GET crossing only a verified same-owner heartbeat then requires exact versions", async () => {
  const frames = [heartbeatReadSnapshot(0, true), heartbeatReadSnapshot(1)];
  const originals = structuredClone(frames);
  let reads = 0;
  const task = await readConsistentBackgroundIdentity(async () => frames[reads++]);
  assert.equal(reads, 2); assert.equal(task.childVersion, 6);
  assert.deepEqual(task, frames[1].rail.tasks[0]); assert.deepEqual(frames, originals);
});

test("bounded heartbeat reconciliation rejects owner, payload, identity, watcher, status and effect drift", async () => {
  for (const mutate of [
    data => { data.child.leaseOwnerId = "other-worker"; },
    data => { data.child.payload.requestActor.actorId = "foreign"; },
    data => { data.child.payload.admissionMaterialSha256 = "b".repeat(64); },
    data => { data.child.payload.sessionIncarnationId = "foreign"; },
    data => { data.child.payload.workspaceId = "foreign"; },
    data => { data.child.runId = "foreign"; },
    data => { data.child.status = "cancelled"; },
    data => { data.child.metadata.foreignEffect = true; },
    data => { data.watcher.revision++; },
    data => { data.watcher.state = "detached"; },
    data => { data.detail.steps[0].childTurnId = "foreign"; },
    data => { data.parent.payload.sessionId = "foreign"; },
    data => { data.scope.sessionId = "foreign"; },
    data => { data.rail.tasks[0].tools.push({ toolName: "host.exec" }); },
    data => { data.rail.tasks[0].approvals.push({ approvalId: "foreign" }); },
    data => { data.rail.tasks[0].scope.sessionId = "foreign"; },
  ]) {
    const frames = [heartbeatReadSnapshot(0, true), heartbeatReadSnapshot(1)];
    mutate(frames[1]); let reads = 0;
    await assert.rejects(readConsistentBackgroundIdentity(async () => frames[reads++]));
    assert.equal(reads, 2);
  }
});

test("reconciliation rejects stale, backwards, unconfirmed or non-renewal version changes", async () => {
  for (const mutate of [
    data => { data.child.leaseHeartbeatAt = "2026-10-01T00:00:00.000Z"; },
    data => { data.child.leaseExpiresAt = "2026-10-01T00:02:00.000Z"; },
    data => { data.child.leaseExpiresAt = "2026-10-01T00:02:06.000Z"; },
    data => { data.child.updatedAt = "2026-10-01T00:00:06.000Z"; },
    data => { data.child.version = 5; },
    data => { data.child.version = 5.5; },
    data => { data.rail.generatedAt = "2026-09-30T23:59:00.000Z"; },
  ]) {
    const frames = [heartbeatReadSnapshot(0, true), heartbeatReadSnapshot(1)];
    mutate(frames[1]); let reads = 0;
    await assert.rejects(readConsistentBackgroundIdentity(async () => frames[reads++]));
    assert.equal(reads, 2);
  }
  const unconfirmed = [heartbeatReadSnapshot(0, true), heartbeatReadSnapshot(1)];
  unconfirmed[0].rail.tasks[0].childVersion = 7;
  let reads = 0;
  await assert.rejects(readConsistentBackgroundIdentity(async () => unconfirmed[reads++]));
  assert.equal(reads, 2);
  const backwards = heartbeatReadSnapshot(0); backwards.rail.tasks[0].childVersion--;
  await assert.rejects(readConsistentBackgroundIdentity(async () => backwards));
});

test("read-only reconciliation ends after four authentic heartbeat snapshots without weakening equality", async () => {
  let reads = 0;
  await assert.rejects(readConsistentBackgroundIdentity(async () => heartbeatReadSnapshot(reads++, true)), /four bounded/);
  assert.equal(reads, 4);
  const terminal = heartbeatReadSnapshot(0, true); terminal.terminal = true;
  await assert.rejects(readConsistentBackgroundIdentity(async () => terminal), /Terminal owner reads/);
});
