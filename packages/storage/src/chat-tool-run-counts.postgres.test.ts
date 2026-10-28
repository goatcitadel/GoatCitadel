import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatToolRunRepository } from "./chat-tool-run-repo.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test("PostgreSQL counts executed and failed calls per tool as plain numbers", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "tool_call_counts");
  try {
    const repo = new ChatToolRunRepository(scope.db);
    const add = (id: string, toolName: string, status: "executed" | "failed" | "blocked", startedAt: string) =>
      repo.create({ toolRunId: id, turnId: "turn-a", sessionId: "session-a", toolName, status, startedAt });
    add("run-1", "fs.read", "executed", "2026-10-01T00:00:00.000Z");
    add("run-2", "fs.read", "executed", "2026-10-03T00:00:00.000Z");
    add("run-3", "fs.read", "failed", "2026-10-02T00:00:00.000Z");
    add("run-4", "shell.exec", "executed", "2026-10-05T00:00:00.000Z");
    add("run-5", "shell.exec", "blocked", "2026-10-06T00:00:00.000Z");
    repo.create({
      toolRunId: "run-6",
      turnId: "turn-a",
      sessionId: "session-a",
      toolName: "fs.read",
      status: "executed",
      reused: true,
      reusedFromToolRunId: "run-1",
      startedAt: "2026-10-07T00:00:00.000Z",
    });
    add("run-7", "fs.read", "executed", "2026-08-01T00:00:00.000Z");

    // COUNT(*) comes back from PostgreSQL as a bigint string; the repository hands out numbers.
    assert.deepEqual(repo.countCallsByToolSince("2026-09-01T00:00:00.000Z"), [
      { toolName: "fs.read", calls: 3, lastCalledAt: "2026-10-03T00:00:00.000Z" },
      { toolName: "shell.exec", calls: 1, lastCalledAt: "2026-10-05T00:00:00.000Z" },
    ]);
  } finally {
    await scope.teardown();
  }
});
