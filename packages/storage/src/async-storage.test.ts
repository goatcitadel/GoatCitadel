import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { NotFoundError } from "@goatcitadel/contracts";
import { createLocalAsyncStorage, createSqliteAsyncStorage, type AsyncStorage } from "./async-storage.js";
import type { DatabaseClient } from "./db.js";
import { Storage } from "./index.js";

function createStorage(): AsyncStorage {
  return createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: "unused-transcripts",
      auditDir: "unused-audit",
      modelUsageRecoverySweepIntervalMs: 60_000,
    }),
  );
}

function session(sessionId: string) {
  return {
    sessionId,
    sessionKey: `key:${sessionId}`,
    kind: "dm" as const,
    channel: "test",
    account: "operator",
    timestamp: "2026-08-05T00:00:00.000Z",
  };
}

test("SQLite async storage exposes awaited repository and root Storage methods", async () => {
  const storage = createStorage();
  try {
    const created = await storage.sessions.upsert(session("session-1"));
    assert.equal(created.sessionId, "session-1");

    const listed = await storage.sessions.list(10);
    assert.equal(listed[0]?.sessionId, "session-1");

    await assert.rejects(storage.deleteChatSessionData(""), /sessionId/i);
  } finally {
    await storage.close();
  }
});

test("SQLite async storage serializes unrelated work behind an owned async transaction", async () => {
  const storage = createStorage();
  let releaseTransaction!: () => void;
  let signalTransactionStarted!: () => void;
  const transactionStarted = new Promise<void>((resolve) => {
    signalTransactionStarted = resolve;
  });
  const transactionGate = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });

  try {
    const transaction = storage.runImmediateTransaction(async () => {
      await storage.sessions.upsert(session("rolled-back"));
      signalTransactionStarted();
      await transactionGate;
      throw new Error("rollback fixture");
    });
    await transactionStarted;

    let outsideSettled = false;
    const outside = storage.sessions.upsert(session("outside")).then((value) => {
      outsideSettled = true;
      return value;
    });
    await waitForImmediate();
    assert.equal(outsideSettled, false, "unrelated work must wait for the transaction owner");

    releaseTransaction();
    await assert.rejects(transaction, /rollback fixture/);
    assert.equal((await outside).sessionId, "outside");
    await assert.rejects(storage.sessions.getBySessionId("rolled-back"), NotFoundError);
  } finally {
    releaseTransaction();
    await storage.close();
  }
});

test("SQLite async storage uses savepoints for nested transaction rollback", async () => {
  const storage = createStorage();
  try {
    await storage.runImmediateTransaction(async () => {
      await storage.sessions.upsert(session("outer-before"));
      await assert.rejects(
        storage.runImmediateTransaction(async () => {
          await storage.sessions.upsert(session("nested-rollback"));
          throw new Error("nested rollback fixture");
        }),
        /nested rollback fixture/,
      );
      await storage.sessions.upsert(session("outer-after"));
    });

    assert.equal((await storage.sessions.getBySessionId("outer-before")).sessionId, "outer-before");
    assert.equal((await storage.sessions.getBySessionId("outer-after")).sessionId, "outer-after");
    await assert.rejects(storage.sessions.getBySessionId("nested-rollback"), NotFoundError);
  } finally {
    await storage.close();
  }
});

test("SQLite async storage composes repository-owned transactions inside an async transaction", async () => {
  const storage = createStorage();
  try {
    await storage.runImmediateTransaction(async () => {
      await storage.costLedger.insert({
        sessionId: "session-cost",
        providerId: "fixture",
        modelId: "fixture-model",
        tokenInput: 1,
        tokenOutput: 2,
        tokenCachedInput: 0,
        costUsd: 0.001,
        createdAt: "2026-08-05T00:00:00.000Z",
      });
    });
    const rows = await storage.costLedger.summary("session", "2026-08-04T00:00:00.000Z", "2026-08-06T00:00:00.000Z");
    assert.equal(rows[0]?.key, "session-cost");
  } finally {
    await storage.close();
  }
});

test("SQLite async storage exposes an awaited database transaction client", async () => {
  const storage = createStorage();
  try {
    await storage.db.exec("CREATE TABLE async_storage_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const value = await storage.db.transaction("immediate", async (db) => {
      await db.prepare("INSERT INTO async_storage_fixture (id, value) VALUES (?, ?)").run(1, "owned");
      return await db.prepare("SELECT value FROM async_storage_fixture WHERE id = ?").get<{ value: string }>(1);
    });
    assert.equal(value?.value, "owned");
  } finally {
    await storage.close();
  }
});

test("SQLite async gatewaySql preserves dialect and exposes awaited statement operations", async () => {
  const storage = createStorage();
  try {
    assert.equal(storage.gatewaySql.dialect, "sqlite");
    await storage.gatewaySql.exec(
      "CREATE TABLE async_gateway_sql_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
    await storage.gatewaySql.prepare("INSERT INTO async_gateway_sql_fixture (id, value) VALUES (?, ?)").run(1, "owned");
    const row = await storage.gatewaySql
      .prepare("SELECT value FROM async_gateway_sql_fixture WHERE id = ?")
      .get<{ value: string }>(1);
    assert.equal(row?.value, "owned");

    await assert.rejects(
      storage.gatewaySql.runImmediateTransaction(async () => {
        await storage.gatewaySql
          .prepare("INSERT INTO async_gateway_sql_fixture (id, value) VALUES (?, ?)")
          .run(2, "rolled-back");
        throw new Error("gateway sql rollback fixture");
      }),
      /gateway sql rollback fixture/,
    );
    assert.equal(
      await storage.gatewaySql
        .prepare("SELECT value FROM async_gateway_sql_fixture WHERE id = ?")
        .get<{ value: string }>(2),
      undefined,
    );
  } finally {
    await storage.close();
  }
});

test("local PostgreSQL rollback adapter uses plain BEGIN and awaits owned callback work", async () => {
  const events: string[] = [];
  let activeTransactionId: string | undefined;
  const db: DatabaseClient & {
    beginCompatibilityTransaction(transactionId: string): void;
    commitCompatibilityTransaction(transactionId: string): void;
    rollbackCompatibilityTransaction(transactionId: string): void;
  } = {
    dialect: "postgres",
    prepare: () => ({
      run: () => ({ changes: 0 }),
      get: () => undefined,
      all: () => [],
    }),
    exec: (sql) => {
      events.push(sql);
    },
    close: () => {
      events.push("CLOSE");
    },
    transaction: (_mode, callback) => callback(),
    beginCompatibilityTransaction: (transactionId) => {
      activeTransactionId = transactionId;
      events.push("BEGIN");
    },
    commitCompatibilityTransaction: (transactionId) => {
      assert.equal(activeTransactionId, transactionId);
      activeTransactionId = undefined;
      events.push("COMMIT");
    },
    rollbackCompatibilityTransaction: (transactionId) => {
      assert.equal(activeTransactionId, transactionId);
      activeTransactionId = undefined;
      events.push("ROLLBACK");
    },
  };
  const syncStorage = {
    db,
    close: () => db.close(),
  } as unknown as Storage;
  const storage = createLocalAsyncStorage(syncStorage);

  await storage.runImmediateTransaction(async () => {
    await Promise.resolve();
    await storage.db.exec("SELECT compatibility_fixture");
  });
  await storage.close();

  assert.deepEqual(events, ["BEGIN", "SELECT compatibility_fixture", "COMMIT", "CLOSE"]);
});
