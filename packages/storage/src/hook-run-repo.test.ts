import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createDatabase } from "./sqlite.js";
import { HookRunRepository } from "./hook-run-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Ignore best-effort temp database cleanup failures.
    }
  }
});

function createRepoWithDb(): { repo: HookRunRepository; db: ReturnType<typeof createDatabase> } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-hook-run-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    repo: new HookRunRepository(db),
    db,
  };
}

describe("HookRunRepository", () => {
  it("creates, updates, links, and lists hook delivery runs", () => {
    const { repo, db } = createRepoWithDb();

    assert.throws(() => repo.get("missing-run"), /Unknown hook run/);
    assert.equal(repo.findByIdempotency("hook-1", "missing-key"), undefined);
    assert.deepEqual(repo.listByWorkspace("workspace-1"), []);

    const created = repo.create(
      {
        hookId: "hook-1",
        workspaceId: "workspace-1",
        trigger: "llm.request.before",
        entityType: "chat_turn",
        entityId: "turn-1",
        mode: "mutate",
        status: "queued",
        idempotencyKey: "key-1",
        attemptCount: 0,
        decision: { type: "continue", reason: "initial" },
        patchSummary: { keys: ["providerId"], changed: true },
        requestPayload: { turnId: "turn-1" },
      },
      "2026-03-24T10:00:00.000Z",
    );
    assert.match(created.runId, /^hookrun_[0-9a-f]{24}$/);
    assert.equal(created.completedAt, undefined);
    assert.deepEqual(repo.get(created.runId), created);
    assert.equal(repo.findByIdempotency("hook-1", "key-1")?.runId, created.runId);
    assert.equal(
      db.transaction("immediate", () => repo.findByIdempotencyForUpdate("hook-1", "key-1"))?.runId,
      created.runId,
    );

    const attempted = repo.markAttempt(
      created.runId,
      {
        status: "running",
        attemptCount: 1,
        errorText: "retrying after timeout",
        requestPayload: { retry: true },
      },
      "2026-03-24T10:01:00.000Z",
    );
    assert.equal(attempted.status, "running");
    assert.equal(attempted.attemptCount, 1);
    assert.equal(attempted.errorText, "retrying after timeout");
    assert.deepEqual(attempted.requestPayload, { retry: true });

    const attached = repo.attachDurableRun(created.runId, "durable-1", "2026-03-24T10:02:00.000Z");
    assert.equal(attached.durableRunId, "durable-1");
    assert.equal(attached.updatedAt, "2026-03-24T10:02:00.000Z");
    assert.equal(repo.attachDurableRun(created.runId, "durable-1").durableRunId, "durable-1");
    assert.throws(
      () => repo.attachDurableRun(created.runId, "durable-foreign"),
      /already linked to durable run durable-1/,
    );

    const completed = repo.markOutcome(
      created.runId,
      {
        status: "completed",
        decision: { type: "block", reason: "policy denied", code: "POLICY_DENIED" },
        patchSummary: { keys: [], changed: false },
        latencyMs: 42,
        responsePayload: { status: "blocked" },
        completedAt: "2026-03-24T10:04:00.000Z",
      },
      "2026-03-24T10:03:00.000Z",
    );
    assert.equal(completed.status, "completed");
    assert.equal(completed.errorText, undefined);
    assert.equal(completed.latencyMs, 42);
    assert.equal(completed.completedAt, "2026-03-24T10:04:00.000Z");
    assert.deepEqual(completed.decision, { type: "block", reason: "policy denied", code: "POLICY_DENIED" });
    assert.deepEqual(completed.responsePayload, { status: "blocked" });

    const failed = repo.create(
      {
        hookId: "hook-2",
        workspaceId: "workspace-1",
        trigger: "tool.call.error",
        entityType: "tool_call",
        entityId: "call-1",
        mode: "observe",
        status: "failed",
        idempotencyKey: "key-2",
        attemptCount: 2,
        errorText: "webhook failed",
        responsePayload: { status: 500 },
        completedAt: "2026-03-24T10:06:00.000Z",
      },
      "2026-03-24T10:05:00.000Z",
    );

    assert.deepEqual(
      repo.listByWorkspace("workspace-1", 0).map((run) => run.runId),
      [failed.runId],
    );
    assert.deepEqual(
      repo.listByWorkspace("workspace-1", Number.NaN).map((run) => run.runId),
      [failed.runId, created.runId],
    );
    assert.deepEqual(
      repo.listByWorkspace("workspace-1", 20).map((run) => run.runId),
      [failed.runId, created.runId],
    );
  });

  it("filters malformed persisted rows and tolerates malformed JSON payloads", () => {
    const { repo, db } = createRepoWithDb();
    const malformedJson = repo.create(
      {
        hookId: "hook-1",
        workspaceId: "workspace-1",
        trigger: "agent_end",
        entityType: "agent",
        entityId: "agent-1",
        mode: "observe",
        status: "completed",
        idempotencyKey: "key-json",
        attemptCount: 1,
      },
      "2026-03-24T10:00:00.000Z",
    );
    db.prepare(
      `
      UPDATE hook_runs
      SET decision_json = 'not json',
          patch_summary_json = 'not json',
          request_payload_json = 'not json',
          response_payload_json = 'not json'
      WHERE run_id = ?
    `,
    ).run(malformedJson.runId);

    const mapped = repo.get(malformedJson.runId);
    assert.equal(mapped.decision, undefined);
    assert.equal(mapped.patchSummary, undefined);
    assert.equal(mapped.requestPayload, undefined);
    assert.equal(mapped.responsePayload, undefined);

    db.prepare(
      `
      INSERT INTO hook_runs (
        run_id,
        hook_id,
        workspace_id,
        trigger,
        entity_type,
        entity_id,
        mode,
        status,
        idempotency_key,
        attempt_count,
        created_at,
        updated_at
      ) VALUES (
        'hookrun_invalid',
        'hook-1',
        'workspace-1',
        'agent_end',
        'agent',
        'agent-2',
        'observe',
        'completed',
        'key-invalid',
        'bad',
        '2026-03-24T10:01:00.000Z',
        '2026-03-24T10:01:00.000Z'
      )
    `,
    ).run();

    assert.deepEqual(
      repo.listByWorkspace("workspace-1", 20).map((run) => run.runId),
      [malformedJson.runId],
    );
    assert.equal(repo.findByIdempotency("hook-1", "key-invalid"), undefined);
    assert.throws(() => repo.get("hookrun_invalid"), /Unknown hook run/);
  });
});
