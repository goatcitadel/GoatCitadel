import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { MemoryContextRepository } from "./memory-context-repo.js";
import type { DatabaseClient, DbStatement } from "./db.js";

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

function createRepo(): MemoryContextRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-memory-context-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new MemoryContextRepository(db);
}

describe("MemoryContextRepository", () => {
  it("uses postgres-safe null comparisons for fresh cache lookups", () => {
    const preparedSql: string[] = [];
    const statement: DbStatement = {
      run: () => ({ changes: 0 }),
      get: () => undefined,
      all: () => [],
    };
    const db: DatabaseClient = {
      dialect: "postgres",
      prepare(sql: string) {
        preparedSql.push(sql);
        return statement;
      },
      exec() {},
      close() {},
      transaction(_mode, callback) {
        return callback();
      },
    };

    new MemoryContextRepository(db);

    const lookupSql = preparedSql.find((sql) => sql.includes("WHERE cache_key = @cacheKey"));
    assert.ok(lookupSql);
    assert.match(lookupSql, /session_id IS NOT DISTINCT FROM @sessionId/);
    assert.match(lookupSql, /task_id IS NOT DISTINCT FROM @taskId/);
    assert.match(lookupSql, /run_id IS NOT DISTINCT FROM @runId/);
    assert.match(lookupSql, /phase_id IS NOT DISTINCT FROM @phaseId/);
  });

  it("upserts and retrieves fresh cache entries", () => {
    const repo = createRepo();
    const inserted = repo.upsert({
      cacheKey: "cache-1",
      scope: "chat",
      sessionId: "session-1",
      queryHash: "q",
      sourcesHash: "s",
      contextText: "distilled context",
      citations: [
        {
          candidateId: "t:e1",
          sourceType: "transcript",
          sourceRef: "e1",
          score: 0.9,
        },
      ],
      quality: {
        status: "generated",
      },
      originalTokenEstimate: 100,
      distilledTokenEstimate: 40,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const fetched = repo.findFreshByCacheKey({
      cacheKey: "cache-1",
      scope: "chat",
      sessionId: "session-1",
    }, "2026-01-01T00:00:00.000Z");
    assert.ok(fetched);
    assert.equal(fetched.contextId, inserted.contextId);
    assert.equal(fetched.citations.length, 1);
    assert.equal(repo.get(inserted.contextId).contextText, "distilled context");
  });

  it("keeps same raw cache keys isolated across sessions", () => {
    const repo = createRepo();
    repo.upsert({
      cacheKey: "cache-shared",
      scope: "chat",
      sessionId: "session-1",
      queryHash: "q-1",
      sourcesHash: "s-1",
      contextText: "session one context",
      citations: [],
      quality: { status: "generated" },
      originalTokenEstimate: 100,
      distilledTokenEstimate: 40,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    repo.upsert({
      cacheKey: "cache-shared",
      scope: "chat",
      sessionId: "session-2",
      queryHash: "q-2",
      sourcesHash: "s-2",
      contextText: "session two context",
      citations: [],
      quality: { status: "generated" },
      originalTokenEstimate: 120,
      distilledTokenEstimate: 44,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const sessionOne = repo.findFreshByCacheKey({
      cacheKey: "cache-shared",
      scope: "chat",
      sessionId: "session-1",
    }, "2026-01-01T00:00:00.000Z");
    const sessionTwo = repo.findFreshByCacheKey({
      cacheKey: "cache-shared",
      scope: "chat",
      sessionId: "session-2",
    }, "2026-01-01T00:00:00.000Z");

    assert.equal(sessionOne?.contextText, "session one context");
    assert.equal(sessionTwo?.contextText, "session two context");
    assert.notEqual(sessionOne?.contextId, sessionTwo?.contextId);
  });

  it("prunes expired and old context packs", () => {
    const repo = createRepo();
    repo.upsert({
      cacheKey: "cache-expired",
      scope: "chat",
      sessionId: "session-1",
      queryHash: "q-exp",
      sourcesHash: "s-exp",
      contextText: "expired context",
      citations: [],
      quality: { status: "generated" },
      originalTokenEstimate: 200,
      distilledTokenEstimate: 120,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T01:00:00.000Z",
    });
    repo.upsert({
      cacheKey: "cache-fresh",
      scope: "chat",
      sessionId: "session-2",
      queryHash: "q-fresh",
      sourcesHash: "s-fresh",
      contextText: "fresh context",
      citations: [],
      quality: { status: "generated" },
      originalTokenEstimate: 220,
      distilledTokenEstimate: 140,
      createdAt: "2026-03-01T00:00:00.000Z",
      expiresAt: "2026-03-02T00:00:00.000Z",
    });

    const expiredRemoved = repo.pruneExpired("2026-02-01T00:00:00.000Z");
    assert.equal(expiredRemoved, 1);
    assert.equal(repo.listRecent(10).length, 1);

    const oldRemoved = repo.pruneOlderThan("2026-03-02T00:00:00.000Z");
    assert.equal(oldRemoved, 1);
    assert.equal(repo.listRecent(10).length, 0);
  });
});
