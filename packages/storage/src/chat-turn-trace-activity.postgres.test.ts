import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("PostgreSQL reads only bounded same-session turn lineage", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "turn_lineage");
  try {
    const repo = new ChatTurnTraceRepository(scope.db);
    const create = (turnId: string, sessionId: string, parentTurnId: string) =>
      repo.create({
        turnId,
        sessionId,
        parentTurnId,
        userMessageId: `user-${turnId}`,
        mode: "chat",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        startedAt: "2026-10-05T10:00:00.000Z",
      });
    create("a-1", "session-a", "b-1");
    create("a-2", "session-a", "a-1");
    create("b-1", "session-b", "a-2");
    assert.deepEqual(
      repo.listLineageFrom("session-a", "a-2", 1).map((trace) => trace.turnId),
      ["a-2"],
    );
    assert.deepEqual(
      repo.listLineageFrom("session-a", "a-2", 4).map((trace) => trace.turnId),
      ["a-2", "a-1"],
    );
    assert.deepEqual(repo.listLineageFrom("session-a", "b-1"), []);
  } finally {
    await scope.teardown();
  }
});

test("PostgreSQL summarizes turn activity per session", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "turn_activity");
  try {
    const repo = new ChatTurnTraceRepository(scope.db);
    const create = (turnId: string, sessionId: string, startedAt: string) =>
      repo.create({
        turnId,
        sessionId,
        userMessageId: `user-${turnId}`,
        mode: "chat",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        startedAt,
      });
    create("a-1", "session-a", "2026-10-05T10:00:00.000Z");
    repo.patch("a-1", { status: "running" });
    create("a-2", "session-a", "2026-10-05T10:00:01.000Z");
    repo.patch("a-2", { status: "waiting_for_approval" });
    create("b-1", "session-b", "2026-10-05T09:00:00.000Z");
    repo.patch("b-1", { status: "completed", finishedAt: "2026-10-05T09:00:01.000Z" });

    const summary = repo.summarizeBySessionIds(["session-a", "session-b"]);
    assert.deepEqual(summary.get("session-a"), {
      latest: { turnId: "a-2", status: "waiting_for_approval", startedAt: "2026-10-05T10:00:01.000Z" },
      counts: { running: 1, waiting_for_approval: 1 },
    });
    assert.deepEqual(summary.get("session-b")?.counts, {});
    assert.equal(summary.get("session-b")?.latest.finishedAt, "2026-10-05T09:00:01.000Z");
  } finally {
    await scope.teardown();
  }
});
