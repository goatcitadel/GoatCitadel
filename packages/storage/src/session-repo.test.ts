import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { SessionRepository } from "./session-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepo(): SessionRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-session-repo-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new SessionRepository(db);
}

describe("SessionRepository", () => {
  it("lists sessions without requiring a cursor placeholder", () => {
    const repo = createRepo();
    const now = "2026-02-27T10:00:00.000Z";

    repo.upsert({
      sessionId: "session-a",
      sessionKey: "discord:me:a",
      kind: "dm",
      channel: "discord",
      account: "me",
      timestamp: now,
    });
    repo.upsert({
      sessionId: "session-b",
      sessionKey: "discord:me:b",
      kind: "dm",
      channel: "discord",
      account: "me",
      timestamp: "2026-02-27T09:59:59.000Z",
    });

    const page = repo.list(10);

    assert.equal(page.length, 2);
    assert.deepEqual(
      page.map((item) => item.sessionId),
      ["session-a", "session-b"],
    );
  });

  it("uses composite cursor pagination without dropping identical timestamps", () => {
    const repo = createRepo();
    const now = "2026-02-27T10:00:00.000Z";

    repo.upsert({
      sessionId: "session-a",
      sessionKey: "discord:me:a",
      kind: "dm",
      channel: "discord",
      account: "me",
      timestamp: now,
    });
    repo.upsert({
      sessionId: "session-b",
      sessionKey: "discord:me:b",
      kind: "dm",
      channel: "discord",
      account: "me",
      timestamp: now,
    });
    repo.upsert({
      sessionId: "session-c",
      sessionKey: "discord:me:c",
      kind: "dm",
      channel: "discord",
      account: "me",
      timestamp: "2026-02-27T09:59:59.000Z",
    });

    const page1 = repo.list(1);
    const cursor = `${page1[0]!.updatedAt}|${page1[0]!.sessionId}`;
    const page2 = repo.list(10, cursor);

    assert.equal(page2.length, 2);
    assert.equal(
      page2.some((item) => item.sessionId === page1[0]?.sessionId),
      false,
    );
  });

  it("handles malformed routing_hints_json without throwing", () => {
    const repo = createRepo();
    const now = "2026-02-27T10:00:00.000Z";

    repo.upsert({
      sessionId: "session-malformed",
      sessionKey: "discord:me:malformed",
      kind: "dm",
      channel: "discord",
      account: "me",
      timestamp: now,
    });

    const db = (repo as unknown as { db: ReturnType<typeof createDatabase> }).db;
    db.prepare("UPDATE sessions SET routing_hints_json = @json WHERE session_id = @sessionId").run({
      json: "{invalid-json",
      sessionId: "session-malformed",
    });

    const row = repo.getBySessionId("session-malformed");
    assert.equal(row.routingHints, undefined);
  });

  it("aggregates operator summaries in SQL with active-session counts", () => {
    const repo = createRepo();

    repo.upsert({
      sessionId: "session-a",
      sessionKey: "discord:operator-a:a",
      kind: "dm",
      channel: "discord",
      account: "operator-a",
      timestamp: "2026-03-05T10:00:00.000Z",
    });
    repo.upsert({
      sessionId: "session-b",
      sessionKey: "discord:operator-a:b",
      kind: "dm",
      channel: "discord",
      account: "operator-a",
      timestamp: "2026-03-05T09:50:00.000Z",
    });
    repo.upsert({
      sessionId: "session-c",
      sessionKey: "discord:operator-b:c",
      kind: "dm",
      channel: "discord",
      account: "operator-b",
      timestamp: "2026-03-05T09:40:00.000Z",
    });

    const summaries = repo.listOperatorSummaries("2026-03-05T09:55:00.000Z");

    assert.deepEqual(summaries, [
      {
        operatorId: "operator-a",
        sessionCount: 2,
        activeSessions: 1,
        lastActivityAt: "2026-03-05T10:00:00.000Z",
      },
      {
        operatorId: "operator-b",
        sessionCount: 1,
        activeSessions: 0,
        lastActivityAt: "2026-03-05T09:40:00.000Z",
      },
    ]);
  });
});
