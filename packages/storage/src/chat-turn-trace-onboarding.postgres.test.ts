import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("PostgreSQL pages completed onboarding traces with tied timestamps", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "onboarding_pages");
  try {
    const repo = new ChatTurnTraceRepository(scope.db);
    for (const turnId of ["turn-c", "turn-a", "turn-b"]) {
      repo.create({ turnId, sessionId: "session-pages", userMessageId: `user-${turnId}`, mode: "chat",
        webMode: "off", memoryMode: "off", thinkingLevel: "standard", startedAt: "2026-09-15T00:00:01.000Z" });
      repo.patch(turnId, { status: "completed" });
    }
    const since = "2026-09-15T00:00:00.000Z";
    const first = repo.listCompletedSince(since, 2);
    assert.deepEqual(first.map(t => t.turnId), ["turn-a", "turn-b"]);
    const next = repo.listCompletedSince(since, 2, { startedAt: first[1]!.startedAt, turnId: first[1]!.turnId });
    assert.deepEqual(next.map(t => t.turnId), ["turn-c"]);
    assert.deepEqual(repo.listCompletedSince(since, 2, { startedAt: next[0]!.startedAt, turnId: "turn-c" }), []);
    assert.deepEqual(repo.listCompletedSince(next[0]!.startedAt, 2), []);
  } finally { await scope.teardown(); }
});
