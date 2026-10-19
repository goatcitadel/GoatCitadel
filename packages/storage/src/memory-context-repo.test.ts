import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryContextRepository } from "./memory-context-repo.js";
import type { DatabaseClient, DbStatement } from "./db.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createRepo(): MemoryContextRepository {
  const dbPath = tempDbs.path("goatcitadel-memory-context");
  const db = tempDbs.open({ dbPath });
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

    const fetched = repo.findFreshByCacheKey(
      {
        cacheKey: "cache-1",
        scope: "chat",
        sessionId: "session-1",
      },
      "2026-01-01T00:00:00.000Z",
    );
    assert.ok(fetched);
    assert.equal(fetched.contextId, inserted.contextId);
    assert.equal(fetched.citations.length, 1);
    assert.equal(repo.get(inserted.contextId).contextText, "distilled context");
    assert.equal(repo.listByRun("missing-run").length, 0);
  });

  it("round-trips the access receipt through upsert and cache reads", () => {
    const repo = createRepo();
    const accessReceipt = {
      policyVersion: "v1",
      mode: "session_only" as const,
      sessionKind: "dm" as const,
      failClosed: true,
      fingerprint: "fp-1",
    };
    const inserted = repo.upsert({
      cacheKey: "cache-receipt",
      scope: "chat",
      sessionId: "session-1",
      queryHash: "q",
      sourcesHash: "s",
      contextText: "context",
      citations: [],
      quality: { status: "generated", accessReceipt },
      originalTokenEstimate: 10,
      distilledTokenEstimate: 5,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.deepEqual(inserted.quality.accessReceipt, accessReceipt);

    const fetched = repo.findFreshByCacheKey(
      { cacheKey: "cache-receipt", scope: "chat", sessionId: "session-1" },
      "2026-01-01T00:00:00.000Z",
    );
    assert.deepEqual(fetched?.quality.accessReceipt, accessReceipt);
  });

  it("drops a malformed stored access receipt on read", () => {
    const repo = createRepo();
    const inserted = repo.upsert({
      cacheKey: "cache-bad-receipt",
      scope: "chat",
      sessionId: "session-1",
      queryHash: "q",
      sourcesHash: "s",
      contextText: "context",
      citations: [],
      quality: {
        status: "generated",
        accessReceipt: { mode: 3 } as unknown as never,
      },
      originalTokenEstimate: 10,
      distilledTokenEstimate: 5,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(inserted.quality.accessReceipt, undefined);
    assert.equal(repo.get(inserted.contextId).quality.accessReceipt, undefined);
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

    const sessionOne = repo.findFreshByCacheKey(
      {
        cacheKey: "cache-shared",
        scope: "chat",
        sessionId: "session-1",
      },
      "2026-01-01T00:00:00.000Z",
    );
    const sessionTwo = repo.findFreshByCacheKey(
      {
        cacheKey: "cache-shared",
        scope: "chat",
        sessionId: "session-2",
      },
      "2026-01-01T00:00:00.000Z",
    );

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

  it("reports missing reads and filters malformed adapter rows", () => {
    const repo = createRepo();

    assert.throws(() => repo.get("missing-context"), /Memory context missing-context not found/);
    assert.equal(repo.findFreshByCacheKey({ cacheKey: "missing", scope: "chat", sessionId: "session-1" }), undefined);

    const internal = repo as unknown as {
      getByCacheKeyStmt: { get: (...args: unknown[]) => unknown };
      listRecentStmt: { all: (...args: unknown[]) => unknown };
      listByRunStmt: { all: (...args: unknown[]) => unknown };
    };
    internal.getByCacheKeyStmt = { get: () => null };
    assert.throws(
      () =>
        repo.upsert({
          cacheKey: "unreadable",
          scope: "chat",
          sessionId: "session-1",
          queryHash: "q",
          sourcesHash: "s",
          contextText: "context",
          citations: [],
          quality: { status: "generated" },
          originalTokenEstimate: 100,
          distilledTokenEstimate: 50,
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      /Failed to read memory context pack after upsert/,
    );

    internal.listRecentStmt = { all: () => [null] };
    internal.listByRunStmt = { all: () => ({ not: "an array" }) };
    assert.deepEqual(repo.listRecent(), []);
    assert.deepEqual(repo.listByRun("run-1"), []);
  });
});
