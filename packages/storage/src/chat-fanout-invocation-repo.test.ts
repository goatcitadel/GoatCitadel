import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatFanoutInvocationRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatFanoutInvocationRepository } from "./chat-fanout-invocation-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Best-effort temp cleanup only.
    }
  }
});

function createStore(): { db: DatabaseClient; repo: ChatFanoutInvocationRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-fanout-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatFanoutInvocationRepository(db) };
}

function invocation(overrides: Partial<ChatFanoutInvocationRecord> = {}): ChatFanoutInvocationRecord {
  const now = "2026-08-13T12:00:00.000Z";
  return {
    invocationId: "fanout-1",
    parentRunId: "parent-run-1",
    toolRunId: "tool-run-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    status: "reserving",
    childCount: 2,
    subtasks: [{ objective: "Research A" }, { objective: "Research B" }],
    grantId: "grant-1",
    reservedActivations: 2,
    reservedBudgetUsd: 0.5,
    objective: "Compare the two bounded research tasks.",
    capabilityProfileHash: "a".repeat(64),
    policyProfileHash: "b".repeat(64),
    projectBindingHash: "c".repeat(64),
    grantBindingHash: "d".repeat(64),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("ChatFanoutInvocationRepository", () => {
  it("converges duplicate parent/tool admission and preserves terminal aggregate truth", () => {
    const { db, repo } = createStore();
    try {
      const first = repo.createOrGetWithOutcome(invocation());
      const duplicate = repo.createOrGetWithOutcome(
        invocation({ invocationId: "fanout-conflict", objective: "Unsafe replacement plan" }),
      );

      assert.equal(first.created, true);
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.invocation.invocationId, "fanout-1");
      assert.equal(duplicate.invocation.objective, "Compare the two bounded research tasks.");
      assert.deepEqual(
        repo.listActive().map((record) => record.invocationId),
        ["fanout-1"],
      );

      const waiting = repo.patch("fanout-1", {
        delegationRunId: "delegation-run-1",
        status: "waiting",
      });
      assert.equal(waiting.status, "waiting");
      assert.equal(waiting.delegationRunId, "delegation-run-1");

      const completed = repo.patch("fanout-1", { status: "completed" });
      assert.equal(completed.status, "completed");
      assert.ok(completed.finishedAt);
      assert.deepEqual(repo.listActive(), []);
      assert.throws(() => repo.patch("fanout-1", { status: "dispatching" }), /cannot transition/);
    } finally {
      db.close();
    }
  });

  it("enforces the hard three-child bound in canonical storage", () => {
    const { db, repo } = createStore();
    try {
      assert.throws(
        () =>
          repo.createOrGetWithOutcome(
            invocation({
              invocationId: "fanout-over-cap",
              parentRunId: "parent-run-over-cap",
              toolRunId: "tool-run-over-cap",
              childCount: 4,
              reservedActivations: 4,
              subtasks: [{ objective: "A" }, { objective: "B" }, { objective: "C" }, { objective: "D" }],
            }),
          ),
        /CHECK constraint failed/i,
      );
    } finally {
      db.close();
    }
  });
});
