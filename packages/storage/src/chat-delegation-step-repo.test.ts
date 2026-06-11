import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { ChatCitationRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatDelegationStepRepository } from "./chat-delegation-step-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function createStore(): { db: DatabaseClient; repo: ChatDelegationStepRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-delegation-step-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatDelegationStepRepository(db) };
}

function citation(): ChatCitationRecord {
  return {
    citationId: "citation-a",
    title: "Trace",
    url: "https://example.test/trace",
    sourceType: "tool",
  };
}

function setStepField(db: DatabaseClient, stepId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE chat_delegation_steps SET ${field} = ? WHERE step_id = ?`).run(value, stepId);
}

function createSessionMeta(db: DatabaseClient, sessionId: string, workspaceId: string): void {
  db.prepare(
    `
      INSERT INTO chat_session_meta (
        session_id, workspace_id, title, origin, include_in_history, pinned, lifecycle_status, tags_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'operator', 1, 0, 'active', '[]', ?, ?)
    `,
  ).run(sessionId, workspaceId, sessionId, "2026-03-26T00:00:00.000Z", "2026-03-26T00:00:00.000Z");
}

function createDelegationRun(db: DatabaseClient, runId: string, sessionId: string, startedAt: string): void {
  db.prepare(
    `
      INSERT INTO chat_delegation_runs (
        run_id, session_id, task_id, objective, roles_json, mode, provider_id, model, status,
        citations_json, started_at, finished_at
      ) VALUES (?, ?, ?, 'Cover storage', '["QA"]', 'parallel', 'openai', 'gpt-test', 'running', '[]', ?, NULL)
    `,
  ).run(runId, sessionId, `task-${runId}`, startedAt);
}

describe("ChatDelegationStepRepository", () => {
  it("creates, patches, gets, and lists delegation steps", () => {
    const { repo } = createStore();

    const full = repo.create({
      stepId: "step-b",
      runId: "run-a",
      role: "QA",
      label: "Review",
      index: 1,
      status: "running",
      providerId: "openai",
      model: "gpt-test",
      summary: "Working",
      output: "Partial output",
      error: "none",
      failureGuidance: "Retry narrower",
      durableRunId: "durable-a",
      childSessionId: "child-a",
      childTurnId: "child-turn-a",
      citations: [citation()],
      degradedHandoffStepIds: ["step-researcher"],
      startedAt: "2026-03-26T00:00:02.000Z",
      finishedAt: "2026-03-26T00:00:03.000Z",
      durationMs: 1000,
    });
    const minimal = repo.create({
      stepId: "step-a",
      runId: "run-a",
      role: "Researcher",
      index: 0,
      startedAt: "2026-03-26T00:00:01.000Z",
    });

    assert.equal(full.status, "running");
    assert.equal(full.providerId, "openai");
    assert.equal(full.model, "gpt-test");
    assert.equal(full.label, "Review");
    assert.equal(full.summary, "Working");
    assert.equal(full.output, "Partial output");
    assert.equal(full.error, "none");
    assert.equal(full.failureGuidance, "Retry narrower");
    assert.equal(full.durableRunId, "durable-a");
    assert.equal(full.childSessionId, "child-a");
    assert.equal(full.childTurnId, "child-turn-a");
    assert.deepEqual(full.citations, [citation()]);
    assert.deepEqual(full.degradedHandoffStepIds, ["step-researcher"]);
    assert.equal(full.durationMs, 1000);
    assert.equal(minimal.status, "pending");
    assert.equal(minimal.citations, undefined);
    assert.equal(minimal.degradedHandoffStepIds, undefined);

    const patched = repo.patch("step-b", {
      status: "completed",
      providerId: "anthropic",
      model: "claude-test",
      label: "Reviewed",
      summary: "Done",
      output: "Final output",
      error: "",
      failureGuidance: "",
      durableRunId: "durable-b",
      childSessionId: "child-b",
      childTurnId: "child-turn-b",
      citations: [],
      degradedHandoffStepIds: ["step-researcher", "step-reviewer"],
      finishedAt: "2026-03-26T00:00:04.000Z",
      durationMs: 2000,
    });
    assert.equal(patched.status, "completed");
    assert.equal(patched.providerId, "anthropic");
    assert.equal(patched.model, "claude-test");
    assert.equal(patched.label, "Reviewed");
    assert.equal(patched.summary, "Done");
    assert.equal(patched.output, "Final output");
    assert.equal(patched.error, "");
    assert.equal(patched.failureGuidance, "");
    assert.equal(patched.durableRunId, "durable-b");
    assert.equal(patched.childSessionId, "child-b");
    assert.equal(patched.childTurnId, "child-turn-b");
    assert.deepEqual(patched.citations, []);
    assert.deepEqual(patched.degradedHandoffStepIds, ["step-researcher", "step-reviewer"]);
    assert.equal(patched.durationMs, 2000);

    const preserved = repo.patch("step-b", {});
    assert.equal(preserved.status, "completed");
    assert.equal(preserved.model, "claude-test");
    assert.deepEqual(preserved.citations, []);
    assert.deepEqual(preserved.degradedHandoffStepIds, ["step-researcher", "step-reviewer"]);

    assert.deepEqual(
      repo.listByRun("run-a").map((step) => step.stepId),
      ["step-a", "step-b"],
    );
    assert.throws(() => repo.get("missing-step"), /Delegation step missing-step not found/);
    assert.throws(() => repo.patch("missing-step", { status: "failed" }), /Delegation step missing-step not found/);
  });

  it("maps latest parent delegation runs for child sessions with workspace filtering", () => {
    const { db, repo } = createStore();
    createSessionMeta(db, "parent-a", "workspace-a");
    createSessionMeta(db, "parent-b", "workspace-a");
    createSessionMeta(db, "parent-c", "workspace-b");
    createSessionMeta(db, "child-a", "workspace-a");
    createSessionMeta(db, "child-b", "workspace-a");
    createSessionMeta(db, "child-c", "workspace-b");
    createDelegationRun(db, "run-a", "parent-a", "2026-03-26T00:00:01.000Z");
    createDelegationRun(db, "run-b", "parent-b", "2026-03-26T00:00:02.000Z");
    createDelegationRun(db, "run-c", "parent-c", "2026-03-26T00:00:03.000Z");

    repo.create({
      stepId: "step-old",
      runId: "run-a",
      role: "Researcher",
      label: "Older",
      index: 0,
      childSessionId: "child-a",
      startedAt: "2026-03-26T00:00:01.000Z",
    });
    repo.create({
      stepId: "step-new",
      runId: "run-b",
      role: "QA",
      label: "Newer",
      index: 1,
      childSessionId: "child-a",
      startedAt: "2026-03-26T00:00:04.000Z",
    });
    repo.create({
      stepId: "step-b",
      runId: "run-b",
      role: "Coder",
      index: 2,
      childSessionId: "child-b",
      startedAt: "2026-03-26T00:00:02.000Z",
    });
    repo.create({
      stepId: "step-c",
      runId: "run-c",
      role: "Ops",
      index: 0,
      childSessionId: "child-c",
      startedAt: "2026-03-26T00:00:03.000Z",
    });
    repo.create({
      stepId: "step-without-child",
      runId: "run-c",
      role: "Ops",
      index: 1,
      startedAt: "2026-03-26T00:00:05.000Z",
    });

    assert.equal(repo.listParentsByChildSessionIds([]).size, 0);
    const unrestricted = repo.listParentsByChildSessionIds([" child-a ", "", "child-a", "child-c"]);
    assert.deepEqual(unrestricted.get("child-a"), {
      parentSessionId: "parent-b",
      runId: "run-b",
      stepId: "step-new",
      role: "QA",
      label: "Newer",
      index: 1,
    });
    assert.equal(unrestricted.get("child-c")?.parentSessionId, "parent-c");

    const workspaceScoped = repo.listParentsByChildSessionIds(["child-a", "child-c"], " workspace-a ");
    assert.equal(workspaceScoped.get("child-a")?.parentSessionId, "parent-b");
    assert.equal(workspaceScoped.has("child-c"), false);
    assert.equal(repo.listParentsByChildSessionIds(["child-a"], "workspace-missing").size, 0);
  });

  it("filters malformed rows and coerces malformed citation payloads", () => {
    const { db, repo } = createStore();
    repo.create({
      stepId: "step-a",
      runId: "run-a",
      role: "QA",
      index: 0,
      citations: [citation()],
      startedAt: "2026-03-26T00:00:01.000Z",
    });

    setStepField(db, "step-a", "citations_json", "{}");
    assert.deepEqual(repo.get("step-a").citations, []);
    setStepField(db, "step-a", "citations_json", "{bad json");
    assert.deepEqual(repo.get("step-a").citations, []);
    setStepField(db, "step-a", "degraded_handoff_step_ids_json", JSON.stringify(["step-failed", 123, "step-other"]));
    assert.deepEqual(repo.get("step-a").degradedHandoffStepIds, ["step-failed", "step-other"]);
    setStepField(db, "step-a", "degraded_handoff_step_ids_json", "{}");
    assert.deepEqual(repo.get("step-a").degradedHandoffStepIds, []);

    setStepField(db, "step-a", "started_at", new Uint8Array([1]));
    assert.throws(() => repo.get("step-a"), /Delegation step step-a not found/);
    assert.deepEqual(repo.listByRun("run-a"), []);

    createDelegationRun(db, "run-a", "parent-a", "2026-03-26T00:00:01.000Z");
    setStepField(db, "step-a", "started_at", "2026-03-26T00:00:01.000Z");
    setStepField(db, "step-a", "child_session_id", "child-a");
    db.prepare("UPDATE chat_delegation_runs SET session_id = zeroblob(1) WHERE run_id = ?").run("run-a");
    assert.equal(repo.listParentsByChildSessionIds(["child-a"]).size, 0);
  });
});
