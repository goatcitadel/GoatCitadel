import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatOrchestrationRouteDecision, ChatTurnTraceRecord } from "@goatcitadel/contracts";
import type { DatabaseClient, DbStatement } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatDelegationRunRepository } from "./chat-delegation-run-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";

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

function createStore(): { db: DatabaseClient; repo: ChatDelegationRunRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-delegation-run-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatDelegationRunRepository(db) };
}

function routeDecision(): ChatOrchestrationRouteDecision {
  return {
    modePolicy: "cowork",
    workflowTemplate: "research_then_summarize",
    hidden: false,
    visibility: "explicit",
    intensity: "standard",
    providerPreference: "balanced",
    reviewDepth: "standard",
    parallelism: "parallel",
    selectedRoles: ["Researcher", "QA"],
    selectedProviders: [],
    triggerReason: "operator requested delegation",
  } as unknown as ChatOrchestrationRouteDecision;
}

function trace(): ChatTurnTraceRecord["routing"] {
  return {
    requestedProviderId: "openai",
    requestedModel: "gpt-5.4",
    effectiveProviderId: "openai",
    effectiveModel: "gpt-5.4",
  } as ChatTurnTraceRecord["routing"];
}

function setRawField(db: DatabaseClient, runId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE chat_delegation_runs SET ${field} = ? WHERE run_id = ?`).run(value, runId);
}

describe("ChatDelegationRunRepository", () => {
  it("creates, patches, lists, and preserves optional run metadata", () => {
    const { repo } = createStore();
    const created = repo.create({
      runId: "run-a",
      sessionId: "session-a",
      taskId: "task-a",
      objective: "Review a plan",
      roles: ["Researcher", "QA"],
      mode: "parallel",
      providerId: "openai",
      model: "gpt-5.4",
      visibility: "expandable",
      workflowTemplate: "review",
      executionPlanId: "plan-a",
      routeDecision: routeDecision(),
      finalSummary: "in progress",
      stitchedOutput: "partial output",
      citations: [{ citationId: "citation-a", url: "https://example.test", title: "Example" }],
      trace: trace(),
      startedAt: "2026-03-26T00:00:01.000Z",
    });
    repo.create({
      runId: "run-b",
      parentRunId: "run-a",
      sessionId: "session-a",
      taskId: "task-b",
      objective: "Summarize",
      roles: ["Writer"],
      mode: "sequential",
      startedAt: "2026-03-26T00:00:02.000Z",
    });

    assert.equal(created.status, "running");
    assert.equal(created.visibility, "expandable");
    assert.deepEqual(created.roles, ["Researcher", "QA"]);
    assert.equal(created.routeDecision?.triggerReason, "operator requested delegation");
    assert.equal(created.citations[0]?.citationId, "citation-a");
    assert.equal(created.trace?.effectiveModel, "gpt-5.4");

    const patched = repo.patch("run-a", {
      status: "completed",
      visibility: "explicit",
      workflowTemplate: "final-review",
      executionPlanId: "plan-b",
      routeDecision: routeDecision(),
      finalSummary: "done",
      stitchedOutput: "final output",
      citations: [],
      trace: trace(),
      finishedAt: "2026-03-26T00:10:00.000Z",
    });
    assert.equal(patched.status, "completed");
    assert.equal(patched.finalSummary, "done");
    assert.equal(patched.finishedAt, "2026-03-26T00:10:00.000Z");

    const preserved = repo.patch("run-a", {});
    assert.equal(preserved.finalSummary, "done");
    assert.equal(preserved.visibility, "explicit");

    assert.deepEqual(
      repo.listBySession("session-a", 0).map((run) => run.runId),
      ["run-b"],
    );
    assert.deepEqual(
      repo.listBySession("session-a", 5000).map((run) => run.runId),
      ["run-b", "run-a"],
    );
    assert.throws(() => repo.get("missing-run"), /Delegation run missing-run not found/);
    assert.throws(() => repo.patch("missing-run", { status: "failed" }), /Delegation run missing-run not found/);
  });

  it("lists recent runs with workspace and session filters", () => {
    const { db, repo } = createStore();
    const sessionMeta = new ChatSessionMetaRepository(db);
    sessionMeta.ensure("session-a", "2026-03-26T00:00:00.000Z", "default");
    sessionMeta.ensure("session-b", "2026-03-26T00:00:00.000Z", "workspace-b");
    repo.create({
      runId: "run-a",
      sessionId: "session-a",
      taskId: "task-a",
      objective: "Find stores near 91303",
      roles: ["Researcher"],
      mode: "sequential",
      startedAt: "2026-03-26T00:00:01.000Z",
    });
    repo.create({
      runId: "run-b",
      parentRunId: "run-a",
      sessionId: "session-a",
      taskId: "task-b",
      objective: "Verify contact pages",
      roles: ["Verifier"],
      mode: "sequential",
      startedAt: "2026-03-26T00:00:02.000Z",
    });
    repo.create({
      runId: "run-c",
      sessionId: "session-b",
      taskId: "task-c",
      objective: "Other workspace",
      roles: ["Researcher"],
      mode: "sequential",
      startedAt: "2026-03-26T00:00:03.000Z",
    });

    assert.deepEqual(
      repo.listRecent({ workspaceId: "default" }).map((run) => run.runId),
      ["run-b", "run-a"],
    );
    assert.deepEqual(
      repo.listRecent({ workspaceId: "workspace-b" }).map((run) => run.runId),
      ["run-c"],
    );
    assert.deepEqual(
      repo.listRecent({ workspaceId: "default", sessionId: "session-a", limit: 1 }).map((run) => run.runId),
      ["run-b"],
    );
    assert.deepEqual(
      repo.listRecent({ parentRunId: "run-a" }).map((run) => run.runId),
      ["run-b"],
    );
  });

  it("filters malformed persisted rows and coerces malformed JSON payloads", () => {
    const { db, repo } = createStore();
    repo.create({
      runId: "run-a",
      sessionId: "session-a",
      taskId: "task-a",
      objective: "Review a plan",
      roles: ["Researcher"],
      mode: "parallel",
      routeDecision: routeDecision(),
      citations: [{ citationId: "citation-a", url: "https://example.test" }],
      trace: trace(),
      startedAt: "2026-03-26T00:00:01.000Z",
    });

    setRawField(db, "run-a", "roles_json", "{}");
    setRawField(db, "run-a", "route_decision_json", "[]");
    setRawField(db, "run-a", "citations_json", "{}");
    setRawField(db, "run-a", "trace_json", "[]");
    const malformedPayloads = repo.get("run-a");
    assert.deepEqual(malformedPayloads.roles, []);
    assert.equal(malformedPayloads.routeDecision, undefined);
    assert.deepEqual(malformedPayloads.citations, []);
    assert.equal(malformedPayloads.trace, undefined);

    setRawField(db, "run-a", "roles_json", "[]");
    setRawField(db, "run-a", "mode", "fanout");
    assert.throws(() => repo.get("run-a"), /corrupt or uses unsupported persisted values/);
    assert.throws(() => repo.listBySession("session-a"), /list row 0.*corrupt/);

    setRawField(db, "run-a", "mode", "parallel");
    setRawField(db, "run-a", "visibility", "visible");
    assert.throws(() => repo.get("run-a"), /corrupt or uses unsupported persisted values/);

    setRawField(db, "run-a", "visibility", null);
    setRawField(db, "run-a", "status", "cancelled");
    assert.throws(() => repo.get("run-a"), /corrupt or uses unsupported persisted values/);

    const internal = repo as unknown as {
      listBySessionStmt: { all: (...args: unknown[]) => unknown };
    };
    internal.listBySessionStmt = { all: () => null };
    assert.throws(() => repo.listBySession("session-a"), /Delegation run list for session session-a is corrupt/);

    internal.listBySessionStmt = { all: () => [null] };
    assert.throws(() => repo.listBySession("session-a"), /Delegation run list row 0 for session session-a is corrupt/);
  });

  it("reconciles stale running runs only when superseded and no active child steps remain", () => {
    const { db, repo } = createStore();
    repo.create({
      runId: "run-stale",
      sessionId: "session-a",
      taskId: "task-stale",
      objective: "Find stores near 91303",
      roles: ["Researcher"],
      mode: "sequential",
      status: "running",
      startedAt: "2026-05-18T00:00:00.000Z",
    });
    repo.create({
      runId: "run-active-wait",
      sessionId: "session-a",
      taskId: "task-active",
      objective: "Find stores near 91303",
      roles: ["Researcher"],
      mode: "sequential",
      status: "running",
      startedAt: "2026-05-18T00:10:00.000Z",
    });
    repo.create({
      runId: "run-new",
      sessionId: "session-a",
      taskId: "task-new",
      objective: "Find stores near 91303",
      roles: ["Researcher"],
      mode: "sequential",
      status: "completed",
      startedAt: "2026-05-20T00:00:00.000Z",
      finishedAt: "2026-05-20T00:10:00.000Z",
    });
    db.prepare(
      `
        INSERT INTO chat_delegation_steps (
          step_id, run_id, role, step_index, status, started_at, citations_json
        ) VALUES (?, ?, 'Researcher', 0, 'running', ?, '[]')
      `,
    ).run("step-active", "run-active-wait", "2026-05-18T00:10:00.000Z");

    const reconciled = repo.reconcileSupersededRunningRunsForSession("session-a", {
      now: "2026-05-20T02:00:00.000Z",
      maxAgeMs: 24 * 60 * 60 * 1000,
    });

    assert.deepEqual(
      reconciled.map((run) => run.runId),
      ["run-stale"],
    );
    assert.equal(repo.get("run-stale").status, "partial");
    assert.match(repo.get("run-stale").stitchedOutput ?? "", /Superseded by later delegation run run-new/);
    assert.equal(repo.get("run-active-wait").status, "running");
  });

  it("casts optional listRecent filters for postgres null parameters", () => {
    const db = new DelegationRunSqlCaptureDatabase("postgres");
    new ChatDelegationRunRepository(db);

    const listSql = db.sql.find(
      (sql) => sql.includes("FROM chat_delegation_runs runs") && sql.includes("LIMIT @limit"),
    );
    assert.ok(listSql);
    // Bare `@param IS NULL` makes Postgres fail with "could not determine data type
    // of parameter $1" when the value is NULL; the ::text casts anchor the type.
    assert.match(listSql, /\(@workspaceId::text IS NULL OR meta\.workspace_id = @workspaceId::text\)/);
    assert.match(listSql, /\(@sessionId::text IS NULL OR runs\.session_id = @sessionId::text\)/);
    assert.match(listSql, /\(@parentRunId::text IS NULL OR runs\.parent_run_id = @parentRunId::text\)/);
  });

  it("leaves optional listRecent filters uncast on the sqlite dialect", () => {
    const db = new DelegationRunSqlCaptureDatabase("sqlite");
    new ChatDelegationRunRepository(db);

    const listSql = db.sql.find(
      (sql) => sql.includes("FROM chat_delegation_runs runs") && sql.includes("LIMIT @limit"),
    );
    assert.ok(listSql);
    assert.doesNotMatch(listSql, /::text/);
    assert.match(listSql, /\(@workspaceId IS NULL OR meta\.workspace_id = @workspaceId\)/);
  });
});

class DelegationRunSqlCaptureDatabase implements DatabaseClient {
  public readonly sql: string[] = [];

  public constructor(public readonly dialect: DatabaseClient["dialect"]) {}

  public prepare(sql: string): DbStatement {
    this.sql.push(sql);
    return new DelegationRunFakeStatement();
  }

  public exec(): void {}

  public close(): void {}

  public transaction<T>(_mode: "deferred" | "immediate" | "exclusive", callback: () => T): T {
    return callback();
  }
}

class DelegationRunFakeStatement implements DbStatement {
  public run(): { changes: number } {
    return { changes: 0 };
  }

  public get<T = unknown>(): T | undefined {
    return undefined;
  }

  public all<T = unknown>(): T[] {
    return [];
  }
}
