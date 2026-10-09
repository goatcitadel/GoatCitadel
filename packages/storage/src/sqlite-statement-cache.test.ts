import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLITE_STATEMENT_CACHE_LIMIT, createDatabase } from "./sqlite.js";
import { BoundedStatementCache } from "./sqlite-statement-cache.js";

/**
 * The SQLite client reuses compiled statements by SQL text. Reuse must stay
 * invisible: results follow schema changes, wrapped adapters never leak into later
 * `prepare` calls, and eviction keeps evicted SQL working.
 */
/** A cache whose compile step records every SQL text it compiles. */
function countingCache(limit: number) {
  const compiled: string[] = [];
  const cache = new BoundedStatementCache(limit, (sql) => {
    compiled.push(sql);
    return { sql, generation: compiled.length };
  });
  return { cache, compiled };
}

describe("bounded statement cache", () => {
  it("compiles repeated SQL once and returns the same compiled statement", () => {
    const { cache, compiled } = countingCache(4);
    const first = cache.get("SELECT 1");
    assert.equal(cache.get("SELECT 1"), first);
    assert.equal(cache.get("SELECT 1"), first);
    assert.deepEqual(compiled, ["SELECT 1"]);
  });

  it("a hit refreshes recency, so overflow evicts the least recently used SQL", () => {
    const { cache, compiled } = countingCache(2);
    cache.get("a");
    cache.get("b");
    cache.get("a"); // hit: "b" is now the least recently used
    cache.get("c"); // overflow evicts "b", not "a"
    assert.equal(cache.size, 2);
    cache.get("a");
    assert.deepEqual(compiled, ["a", "b", "c"], "a stayed cached through the overflow");
    cache.get("b");
    assert.deepEqual(compiled, ["a", "b", "c", "b"], "the evicted SQL recompiles on its next use");
  });

  it("clear forces every SQL text to recompile", () => {
    const { cache, compiled } = countingCache(4);
    cache.get("a");
    cache.clear();
    assert.equal(cache.size, 0);
    cache.get("a");
    assert.deepEqual(compiled, ["a", "a"]);
  });
});

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

  it("rejects a cache bound that is not a positive integer", () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => new BoundedStatementCache(limit, (sql) => sql), RangeError);
    }
  });

  it("does not reuse statements across a close", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    db.prepare("SELECT 1 AS value").get();
    db.close();
    assert.throws(() => db.prepare("SELECT 1 AS value").get());
  });
});
