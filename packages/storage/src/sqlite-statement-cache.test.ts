import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLITE_STATEMENT_CACHE_LIMIT, createDatabase } from "./sqlite.js";

/**
 * The SQLite client reuses compiled statements by SQL text. Reuse must stay
 * invisible: results follow schema changes, wrapped adapters never leak into later
 * `prepare` calls, and eviction keeps evicted SQL working.
 */
describe("SQLite compiled statement reuse", () => {
  it("re-prepares a reused statement after the schema changes", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      db.exec("CREATE TABLE cache_probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
      db.prepare("INSERT INTO cache_probe (id, label) VALUES (1, 'one')").run();
      // node:sqlite rows have a null prototype; spread them into plain objects.
      const rows = () =>
        db
          .prepare("SELECT * FROM cache_probe")
          .all<object>()
          .map((row) => ({ ...row }));
      assert.deepEqual(rows(), [{ id: 1, label: "one" }]);

      db.exec("ALTER TABLE cache_probe ADD COLUMN extra TEXT NOT NULL DEFAULT 'x'");
      assert.deepEqual(rows(), [{ id: 1, label: "one", extra: "x" }]);

      db.exec("DROP TABLE cache_probe");
      assert.throws(() => db.prepare("SELECT * FROM cache_probe").all(), /no such table/u);
    } finally {
      db.close();
    }
  });

  it("drops reused statements when another connection changes the schema", () => {
    const root = mkdtempSync(join(tmpdir(), "gc-statement-cache-"));
    const dbPath = join(root, "probe.db");
    const reader = createDatabase({ dbPath });
    const writer = createDatabase({ dbPath });
    try {
      writer.exec("CREATE TABLE cache_probe (id INTEGER PRIMARY KEY)");
      writer.prepare("INSERT INTO cache_probe (id) VALUES (1)").run();
      const columns = () => Object.keys({ ...reader.prepare("SELECT * FROM cache_probe").get<object>() });
      assert.deepEqual(columns(), ["id"]);
      writer.exec("ALTER TABLE cache_probe ADD COLUMN extra TEXT NOT NULL DEFAULT 'x'");
      assert.deepEqual(columns(), ["id", "extra"]);
    } finally {
      reader.close();
      writer.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("returns a fresh adapter so wrapping one call's statement cannot affect the next", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      db.exec("CREATE TABLE cache_probe (id INTEGER PRIMARY KEY)");
      const sql = "INSERT INTO cache_probe (id) VALUES (@id)";
      const wrapped = db.prepare(sql);
      let intercepted = 0;
      const run = wrapped.run.bind(wrapped);
      wrapped.run = (...params: unknown[]) => {
        intercepted += 1;
        return run(...params);
      };
      wrapped.run({ id: 1 });
      assert.notEqual(db.prepare(sql), wrapped);
      db.prepare(sql).run({ id: 2 });
      assert.equal(intercepted, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cache_probe").get<{ count: number }>()?.count, 2);
    } finally {
      db.close();
    }
  });

  it("keeps working past the cache bound and after evicting the oldest statements", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const distinct = SQLITE_STATEMENT_CACHE_LIMIT + 25;
      for (let index = 0; index < distinct; index++) {
        assert.equal(db.prepare(`SELECT ${index} AS value`).get<{ value: number }>()?.value, index);
      }
      assert.equal(db.prepare("SELECT 0 AS value").get<{ value: number }>()?.value, 0);
    } finally {
      db.close();
    }
  });

  it("does not reuse statements across a close", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    db.prepare("SELECT 1 AS value").get();
    db.close();
    assert.throws(() => db.prepare("SELECT 1 AS value").get());
  });
});
