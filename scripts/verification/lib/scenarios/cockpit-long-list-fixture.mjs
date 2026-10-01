import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export const LONG_LIST_COUNT = 105;
export function assertExactRecords(expected, actual, key) {
  assert.equal(new Set(expected.map(item => item[key])).size, expected.length);
  assert.equal(new Set(actual.map(item => item[key])).size, actual.length);
  assert.deepEqual([...actual].sort((a, b) => a[key].localeCompare(b[key])), [...expected].sort((a, b) => a[key].localeCompare(b[key])));
}
export async function seedLongListFixture({ stack, citadelId, api }) {
  assert.match(path.basename(stack.runtimeRoot ?? ""), /^goatcitadel-usability-/u);
  const suffix = randomUUID(), needle = "Windowed " + suffix.slice(0, 8);
  const workspace = await api("/api/v1/workspaces", { method: "POST", body: { name: needle, citadelId } });
  assert.equal(workspace.citadelId, citadelId);
  const fixture = { workspace, needle, sessions: [], tasks: [], approvals: [], packs: [], runs: [], boundary: "Public inert setup includes actual approval-wait lifecycle materialization; no Chat, model, tool, evaluation or worker execution. Terminal recorded display runs are never dispatched." };
  try {
  // Sequential owner setup is deliberate; the browser's bounded read fanout is measured separately.
  for (let index = 0; index < LONG_LIST_COUNT; index++) {
    const title = needle + " " + String(index).padStart(3, "0");
    fixture.sessions.push(await api("/api/v1/chat/sessions", { method: "POST", body: { workspaceId: workspace.workspaceId, citadelId, mode: "chat", title } }));
    fixture.tasks.push(await api("/api/v1/tasks", { method: "POST", body: { workspaceId: workspace.workspaceId, title, priority: "normal", description: "Inert windowing fixture, no task execution." } }));
    fixture.approvals.push(await api("/api/v1/approvals", { method: "POST", body: { kind: "verification.display", riskLevel: "safe", payload: { fixture: suffix }, preview: { summary: title }, linkage: { workspaceId: workspace.workspaceId, sessionId: fixture.sessions[0].sessionId } } }));
    fixture.packs.push((await api("/api/v1/prompt-packs/import", { method: "POST", body: { packId: "cockpit-window-" + suffix + "-" + index, name: title, sourceLabel: "Disposable display definition; never executed", content: "# Windowing fixture\n\n## TEST-01 Display only\nThis is a stored definition. Do not execute tools.\n" } })).pack);
  }
  const runtimeRoot = await realpath(stack.runtimeRoot), dbPath = await realpath(path.join(runtimeRoot, "data", "index.db"));
  const relative = path.relative(runtimeRoot, dbPath);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && (await stat(dbPath)).isFile());
  const { Storage } = await import(new URL("../../../../packages/storage/dist/index.js", import.meta.url));
  const storage = new Storage({ dbPath, transcriptsDir: path.join(runtimeRoot, "data", "transcripts"), auditDir: path.join(runtimeRoot, "data", "audit") });
  try {
    const sessionId = fixture.sessions[0].sessionId, now = new Date().toISOString();
    assert.equal(storage.chatSessionMeta.get(sessionId)?.workspaceId, workspace.workspaceId);
    const userMessageId = randomUUID(), assistantMessageId = randomUUID(), turnId = randomUUID();
    for (const message of [
      { messageId: userMessageId, role: "user", actorType: "user", sourceAuthority: "operator", content: "Recorded UI fixture prompt; no provider request." },
      { messageId: assistantMessageId, role: "assistant", actorType: "agent", sourceAuthority: "agent_proposed", content: "Recorded UI context only. No provider, tool or retrieval ran." },
    ]) storage.chatMessages.upsert({ ...message, sessionId, actorId: "verification-display", timestamp: now });
    storage.chatTurnTraces.create({ turnId, sessionId, userMessageId, assistantMessageId, status: "completed", mode: "chat", webMode: "off", memoryMode: "off", thinkingLevel: "standard", startedAt: now, finishedAt: now });
    storage.chatSessionBranchState.setActiveLeaf(sessionId, turnId);
    fixture.contextTurnId = turnId;
    for (let index = 0; index < LONG_LIST_COUNT; index++) {
      const now = new Date(Date.now() - LONG_LIST_COUNT + index).toISOString();
      fixture.runs.push(storage.durableRuns.createRun({ runId: "cockpit-display-" + suffix + "-" + index,
        workflowKey: "verification.recorded_display", status: "completed", attemptCount: 0, finishedAt: now, now,
        payload: { workspaceId: workspace.workspaceId, title: needle + " terminal display " + index },
        metadata: { workspaceId: workspace.workspaceId, fixture: "terminal display only; no dispatch" } }));
    }
  } finally { storage.close(); }
  fixture.owner = await readLongListOwners(fixture, api);
  assertExactRecords(fixture.tasks, fixture.owner.tasks, "taskId");
  // The list owner adds the exact no-runtime-effect follow-up projection.
  // Keep every creation field and assert that projection rather than stripping it.
  assertExactRecords(fixture.approvals.map(item => ({ ...item, followUp: { status: "none" } })), fixture.owner.approvals, "approvalId");
  assertExactRecords(fixture.packs, fixture.owner.packs, "packId");
  // JSON transport omits undefined storage fields; the canonical durable
  // owner adds released/no-recovery status for these terminal inert records.
  assertExactRecords(fixture.runs.map(item => ({ ...JSON.parse(JSON.stringify(item)), workerHealth: "released", recoveryState: "none" })), fixture.owner.runs, "runId");
  assert.equal(fixture.owner.sessions.length, LONG_LIST_COUNT);
  assert.deepEqual(new Set(fixture.owner.sessions.map(item => item.sessionId)), new Set(fixture.sessions.map(item => item.sessionId)));
  return fixture;
  } catch (error) {
    try { await retireLongListFixture(fixture, api); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Long-list fixture setup failed and owned cleanup is incomplete", { cause: cleanupError }); }
    throw error;
  }
}
export async function readLongListOwners(fixture, api) {
  const workspaceId = fixture.workspace.workspaceId, scope = new URLSearchParams({ workspaceId, limit: "200" });
  const tasks = (await api("/api/v1/tasks?" + scope)).items;
  const sessions = (await api("/api/v1/chat/sessions?" + new URLSearchParams({ workspaceId, limit: "200", scope: "mission", view: "all" }))).items;
  const approvals = (await api("/api/v1/approvals?" + scope)).items;
  const allPacks = (await api("/api/v1/prompt-packs?limit=2000")).items;
  const packIds = new Set(fixture.packs.map(item => item.packId));
  const runs = [];
  for (const recorded of fixture.runs) runs.push(await api("/api/v1/durable/runs/" + encodeURIComponent(recorded.runId)));
  return { tasks, sessions, approvals, packs: allPacks.filter(item => packIds.has(item.packId)), runs };
}
export async function retireLongListFixture(fixture, api) {
  const errors = [];
  for (const approval of fixture.approvals) {
    try { await api("/api/v1/approvals/" + encodeURIComponent(approval.approvalId) + "/resolve", { method: "POST", body: { decision: "reject", resolutionNote: "End owned inert UI fixture; no execution authorized." } }); }
    catch (error) { errors.push("Owned approval " + approval.approvalId + ": " + String(error)); }
  }
  try {
    const current = (await api("/api/v1/workspaces?view=all&limit=500&citadelId=" + encodeURIComponent(fixture.workspace.citadelId))).items.find(item => item.workspaceId === fixture.workspace.workspaceId);
    assert.ok(current); await api("/api/v1/workspaces/" + encodeURIComponent(current.workspaceId) + "/archive", { method: "POST", body: { expectedRevision: current.revision } });
  } catch (error) { errors.push("Owned workspace: " + String(error)); }
  if (errors.length) throw new AggregateError(errors, "Owned long-list fixture cleanup incomplete");
  // Other inert definitions/terminal records remain only in this task-owned disposable runtime.
}
