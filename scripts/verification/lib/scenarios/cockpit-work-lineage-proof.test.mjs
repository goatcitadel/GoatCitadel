import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../../../../packages/storage/dist/index.js";
import { projectDurableBackgroundTaskRail } from "../../../../apps/gateway/dist/services/durable-background-task-projection.js";
import { RuntimeLifecycleReadService } from "../../../../apps/gateway/dist/services/runtime-lifecycle-read-service.js";
import { assertLineageNativeNavigation, seedWorkLineageRecords, visibleLinks } from "./cockpit-work-lineage-proof.mjs";

test("lineage proof binds supported link labels and encoded identities to the native shell", () => {
  assert.deepEqual(visibleLinks([
    { kind: "durable_run", id: "child /?&#", label: "Child run" },
    { kind: "chat_session", id: "session /?&#", label: "Child conversation" },
    { kind: "unsupported", id: "foreign", label: "Must not gain a route" },
  ]), [
    { text: "Child run", href: "/work/runs/child%20%2F%3F%26%23?shell=cockpit" },
    { text: "Child conversation", href: "/chat?sessionId=session%20%2F%3F%26%23&shell=cockpit" },
  ]);
});

test("lineage navigation proof rejects reloaded documents, changed scope and mismatched child owners", () => {
  const proof = {
    uiUrl: "http://127.0.0.1:1234", url: "http://127.0.0.1:1234/work/runs/child?shell=cockpit",
    child: { childRunId: "child", scope: { sessionId: "child-session" } },
    trace: { lifecycle: { state: "available", response: { canonical: { runId: "child", sessionId: "child-session" } } },
      run: { payload: { workspaceId: "workspace" } } },
    workspaceId: "workspace", citadelId: "citadel", selection: { workspaceId: "workspace", citadelId: "citadel" },
    documentRequestsBefore: 1, documentRequestsAfter: 1, marker: "same-document", expectedMarker: "same-document",
    chatHref: "/chat?sessionId=child-session&shell=cockpit",
  };
  assert.doesNotThrow(() => assertLineageNativeNavigation(proof));
  const changes = [
    (value) => { value.url = "http://127.0.0.1:1234/work/runs/other?shell=cockpit"; },
    (value) => { value.url = "http://127.0.0.1:1234/work/runs/child?shell=classic"; },
    (value) => { value.url += "&workspaceId=foreign"; },
    (value) => { value.documentRequestsAfter += 1; },
    (value) => { value.marker = undefined; },
    (value) => { value.selection.workspaceId = "foreign"; },
    (value) => { value.selection.citadelId = "foreign"; },
    (value) => { value.trace.lifecycle.state = "unavailable"; },
    (value) => { value.trace.lifecycle.response.canonical.runId = "other"; },
    (value) => { value.trace.lifecycle.response.canonical.sessionId = "parent-session"; },
    (value) => { value.trace.run.payload.workspaceId = "foreign"; },
    (value) => { value.chatHref = "/chat?sessionId=parent-session&shell=cockpit"; },
  ];
  for (const change of changes) {
    const invalid = structuredClone(proof);
    change(invalid);
    assert.throws(() => assertLineageNativeNavigation(invalid), assert.AssertionError);
  }
});

test("seeded lineage preserves exact owner links and hashes while withholding foreign and orphan records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gc-work-lineage-fixture-test-"));
  const storage = new Storage({ dbPath: path.join(root, "index.db"), transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") });
  try {
    const workspaceId = "lineage-workspace";
    const sessionId = "lineage-parent-session";
    const childSessionId = "lineage-child-session";
    const foreignWorkspaceId = "lineage-foreign-workspace";
    const foreignSessionId = "lineage-foreign-session";
    for (const [id, workspace] of [[sessionId, workspaceId], [childSessionId, workspaceId], [foreignSessionId, foreignWorkspaceId]]) {
      storage.sessions.upsert({ sessionId: id, sessionKey: `verification:${id}`, kind: "dm", channel: "mission", account: "verification", timestamp: new Date().toISOString() });
      storage.chatSessionMeta.ensure(id, new Date().toISOString(), workspace);
    }
    const fixture = seedWorkLineageRecords(storage, { workspaceId, sessionId, childSessionId, foreignWorkspaceId, foreignSessionId });
    const owner = await projectDurableBackgroundTaskRail(storage, { parentRunId: fixture.parentRunId, workspaceId, sessionId });
    assert.equal(owner.tasks.length, 47);
    assert.equal(owner.tasks.filter((task) => task.scope.verified).length, 45);
    assert.equal(owner.synthesis.availability, "partial");
    assert.equal(owner.synthesis.lineage.length, 45);
    assert.equal(owner.synthesis.uncoveredChildRunIds.length, 2);
    assert.equal(owner.synthesis.uncoveredStepIds.length, 1);
    assert.ok(owner.synthesis.summary.includes("did not execute a delegated turn"));
    const lifecycle = new RuntimeLifecycleReadService({
      getDurableRun: async (runId) => storage.durableRuns.getRun(runId),
      findDurableRunMaybe: async (runId) => { try { return storage.durableRuns.getRun(runId); } catch { return undefined; } },
      getTurnTrace: async (turnId) => storage.chatTurnTraces.get(turnId),
      listHydratedChatTurnTraces: async (id, limit) => storage.chatTurnTraces.listBySession(id, limit),
      listChatExecutionPlans: async (id, limit) => storage.chatExecutionPlans.listBySession(id, limit),
      listChatDelegationRuns: async (id, limit) => storage.chatDelegationRuns.listBySession(id, limit),
      listChatDelegationSteps: async (id) => storage.chatDelegationSteps.listByRun(id),
      getSession: async (id) => storage.sessions.getBySessionId(id),
      getSessionSummary: async (id) => ({ session: storage.sessions.getBySessionId(id), transcriptEventCount: 0, countsByType: {} }),
      findTask: async (id) => storage.tasks.find(id),
      getApproval: async (id) => storage.approvals.get(id), getApprovalWaitRunId: async () => undefined,
      listChatSessionProactiveRuns: async () => [], listApprovalEffects: async () => [],
      listRuntimeDecisionTraces: async (query) => storage.runtimeDecisionTraces.list(query),
    });
    for (const runId of [fixture.parentRunId, ...owner.tasks.filter((task) => task.scope.verified).map((task) => task.childRunId)]) {
      const run = storage.durableRuns.getRun(runId);
      const trace = storage.chatTurnTraces.get(run.payload.turnId);
      assert.equal(trace.capabilityProfileId, undefined, "Fixture must not invent frozen profile authority");
      assert.equal(trace.capabilitySnapshotId, undefined);
      assert.equal(trace.capabilityProfileHash, undefined);
      const resolved = await lifecycle.getRuntimeLifecycle({ runId });
      assert.equal(resolved.canonical.runId, runId);
      assert.equal(resolved.canonical.sessionId, run.payload.sessionId);
      assert.equal(resolved.canonical.turnId, trace.turnId);
    }
    for (const task of owner.tasks.filter((item) => item.scope.verified)) {
      assert.equal(task.scope.sessionId, childSessionId);
      const step = storage.chatDelegationSteps.get(task.delegationStepId);
      assert.equal(step.instructionSnapshot, undefined, "Fixture must not fabricate frozen profile authority");
      assert.equal(task.output.sha256, createHash("sha256").update(step.output).digest("hex"));
      assert.equal(task.output.byteCount, Buffer.byteLength(step.output));
      assert.ok(task.links.some((link) => link.kind === "durable_run" && link.id === step.durableRunId));
      assert.ok(task.links.some((link) => link.kind === "chat_session" && link.id === childSessionId));
    }
    for (const task of owner.tasks.filter((item) => !item.scope.verified)) {
      assert.equal(task.output.availability, "unknown");
      assert.equal(task.output.summary, undefined);
      assert.equal(task.links.some((link) => link.kind === "chat_session"), false);
    }
    await assert.rejects(projectDurableBackgroundTaskRail(storage, { parentRunId: fixture.parentRunId, workspaceId: foreignWorkspaceId, sessionId }),
      (error) => error.statusCode === 404 || error.code === "ENTITY_NOT_FOUND");
  } finally {
    storage.close();
    const target = await realpath(root);
    const relative = path.relative(await realpath(tmpdir()), target);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    assert.ok(path.basename(target).startsWith("gc-work-lineage-fixture-test-"));
    await rm(target, { recursive: true, force: true });
  }
});
