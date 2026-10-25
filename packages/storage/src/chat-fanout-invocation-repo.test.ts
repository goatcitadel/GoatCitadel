import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatFanoutInvocationRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ChatFanoutInvocationRepository } from "./chat-fanout-invocation-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createStore(): { db: DatabaseClient; repo: ChatFanoutInvocationRepository } {
  const dbPath = tempDbs.path("goatcitadel-chat-fanout");
  const db = tempDbs.open({ dbPath });
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
  it("discovers terminal lost-wake candidates by waiting parent with bounded fair keyset pages", () => {
    const { db, repo } = createStore();
    try {
      const runs = new DurableRunRepository(db);
      for (let index = 0; index < 103; index++) {
        const id = index.toString().padStart(3, "0");
        runs.createRun({ runId: `parent-${id}`, workflowKey: index === 102 ? "other" : "chat.turn.execute",
          status: index === 101 ? "cancelled" : "waiting" });
        repo.createOrGet(invocation({ invocationId: `fanout-${id}`, parentRunId: `parent-${id}`, toolRunId: `tool-${id}`,
          delegationRunId: `delegation-${id}`, status: "completed", finishedAt: "2026-10-11T00:00:00.000Z" }));
      }
      assert.deepEqual(repo.listActive(), []);
      const first = repo.listWaitingParentCandidateIds(1000);
      assert.equal(first.length, 100);
      const second = repo.listWaitingParentCandidateIds(100, first.at(-1)!);
      assert.deepEqual(second, ["fanout-100"]);
      assert.deepEqual(repo.listWaitingParentCandidateIds(100, second[0]!), []);
    } finally { db.close(); }
  });
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

describe("ChatFanoutInvocationRepository.listActiveBySession", () => {
  it("returns only the session's active invocations regardless of other sessions' volume", () => {
    const { db, repo } = createStore();
    try {
      for (let index = 0; index < 5; index++) {
        repo.createOrGet(invocation({ invocationId: `other-${index}`, parentRunId: `p-${index}`,
          toolRunId: `t-${index}`, sessionId: "session-other", updatedAt: `2026-08-13T12:00:0${index}.000Z` }));
      }
      repo.createOrGet(invocation({ invocationId: "mine", parentRunId: "p-mine", toolRunId: "t-mine",
        sessionId: "session-mine", updatedAt: "2026-08-13T13:00:00.000Z" }));
      repo.createOrGet(invocation({ invocationId: "mine-done", parentRunId: "p-done", toolRunId: "t-done",
        sessionId: "session-mine", status: "completed", finishedAt: "2026-08-13T13:00:00.000Z" }));
      assert.deepEqual(repo.listActive(2).map((r) => r.sessionId), ["session-other", "session-other"]);
      assert.deepEqual(repo.listActiveBySession("session-mine", 2).map((r) => r.invocationId), ["mine"]);
    } finally { db.close(); }
  });
});
