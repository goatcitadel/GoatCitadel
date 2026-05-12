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
});
