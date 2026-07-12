import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { GatewaySqlRepository } from "./gateway-sql-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

function createRepo(): GatewaySqlRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-gateway-sql-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return new GatewaySqlRepository(createDatabase({ dbPath }));
}

describe("GatewaySqlRepository", () => {
  it("delegates prepare, exec, and immediate transactions to the database client", () => {
    const repo = createRepo();

    repo.exec(`
      CREATE TABLE gateway_sql_repo_test (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    repo.prepare("INSERT INTO gateway_sql_repo_test (id, value) VALUES (?, ?)").run("row-1", "before");

    const committed = repo.runImmediateTransaction(() => {
      repo.prepare("UPDATE gateway_sql_repo_test SET value = ? WHERE id = ?").run("after", "row-1");
      return repo.prepare("SELECT value FROM gateway_sql_repo_test WHERE id = ?").get<{ value: string }>("row-1");
    });

    assert.equal(committed?.value, "after");
    assert.throws(
      () =>
        repo.runImmediateTransaction(() => {
          repo.prepare("INSERT INTO gateway_sql_repo_test (id, value) VALUES (?, ?)").run("row-2", "rolled-back");
          throw new Error("rollback");
        }),
      /rollback/,
    );

    assert.equal(
      repo.prepare("SELECT COUNT(1) AS count FROM gateway_sql_repo_test").get<{ count: number }>()?.count,
      1,
    );
  });

  it("owns database-clock TTL windows and fails closed for malformed instants", () => {
    const repo = createRepo();
    const realNow = Date.now();
    const originalDateNow = Date.now;

    try {
      Date.now = () => Date.parse("2099-01-01T00:00:00.000Z");
      const databaseNow = repo.readDatabaseNow();
      const window = repo.createDatabaseTtlWindow(60_000);

      assert.ok(Math.abs(Date.parse(databaseNow) - realNow) < 5_000);
      assert.ok(Math.abs(Date.parse(window.createdAt) - realNow) < 5_000);
      assert.equal(Date.parse(window.expiresAt) - Date.parse(window.createdAt), 60_000);
      assert.equal(repo.isDatabaseInstantFuture(window.expiresAt), true);
      assert.equal(repo.isDatabaseInstantExpired(window.expiresAt), false);
      assert.equal(repo.isDatabaseInstantFuture("not-a-timestamp"), false);
      assert.equal(repo.isDatabaseInstantExpired("not-a-timestamp"), true);
      assert.equal(repo.isDatabaseInstantWithinSkew(databaseNow, 1_000), true);
      assert.equal(repo.isDatabaseInstantWithinSkew("not-a-timestamp", 1_000), false);
      assert.equal(repo.isDatabaseInstantFuture(window.expiresAt.replace("Z", "+00:00")), true);
      for (const malformed of [
        "",
        "infinity",
        "-infinity",
        "tomorrow",
        "now",
        "epoch",
        "2026-07-11T12:00:00.1234567890Z",
      ]) {
        assert.equal(repo.isDatabaseInstantFuture(malformed), false, malformed);
        assert.equal(repo.isDatabaseInstantExpired(malformed), true, malformed);
        assert.equal(repo.isDatabaseInstantWithinSkew(malformed, 1_000), false, malformed);
      }
    } finally {
      Date.now = originalDateNow;
    }
  });

  it("rejects invalid database-clock durations", () => {
    const repo = createRepo();
    assert.throws(() => repo.createDatabaseTtlWindow(0), /positive duration/i);
    assert.throws(() => repo.createDatabaseTtlWindow(Number.NaN), /positive duration/i);
  });
});
