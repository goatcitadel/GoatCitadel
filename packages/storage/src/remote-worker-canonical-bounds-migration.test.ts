import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { DatabaseClient, DbStatement } from "./db.js";
import { __sqliteInternals, createDatabase } from "./sqlite.js";
import { runSqliteMigrations } from "./sqlite/migration-registry.js";
import { upgradeRemoteWorkerCanonicalBounds } from "./remote-worker-canonical-bounds-migration.js";
import { seedRemoteWorkerInferenceAuthority } from "./remote-worker-inference-fixture.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerChatTaskRepository } from "./remote-worker-chat-task-repo.js";

function bridge(raw: DatabaseSync): DatabaseClient {
  let savepoint = 0;
  return {
    dialect: "sqlite",
    prepare: (sql) => {
      // Seed v213 with only the statements used by that history. Current owners
      // also prepare queries for later features which do not exist yet. Any
      // attempted use still prepares and validates the SQL against the old DB.
      let statement: DbStatement | undefined;
      const prepare = () => (statement ??= raw.prepare(sql) as unknown as DbStatement);
      return {
        run: (...params: unknown[]) => prepare().run(...params),
        get: <T>(...params: unknown[]) => prepare().get<T>(...params),
        all: <T>(...params: unknown[]) => prepare().all<T>(...params),
      };
    },
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
    transaction: (mode, callback) => {
      const nested = raw.isTransaction;
      const name = `fixture_${++savepoint}`;
      raw.exec(nested ? `SAVEPOINT ${name}` : `BEGIN ${mode.toUpperCase()}`);
      try {
        const result = callback();
        raw.exec(nested ? `RELEASE ${name}` : "COMMIT");
        return result;
      } catch (error) {
        raw.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
        throw error;
      }
    },
  };
}

function oldHistory(raw: DatabaseSync): void {
  raw.exec("PRAGMA foreign_keys = ON");
  runSqliteMigrations(
    raw,
    Array.from({ length: 213 }, (_, index) => ({
      version: index + 1,
      name: __sqliteInternals.getSchemaMigrationNameForTest(index + 1),
      up: (db: DatabaseSync) => __sqliteInternals.applySchemaMigrationForTest(index + 1, db),
    })),
  );
}

function retainedObjects(db: DatabaseClient) {
  return db
    .prepare(
      `SELECT type, name, sql FROM sqlite_schema WHERE type IN ('trigger', 'index')
    AND tbl_name IN ('remote_worker_assignment_generations', 'remote_worker_mesh_join_authorities')
    AND sql IS NOT NULL ORDER BY type, name`,
    )
    .all();
}

describe("remote-worker canonical bounds forward migration", () => {
  it("upgrades populated v213 through normal startup without changing immutable generations or dependent leases", (t) => {
    const root = mkdtempSync(join(tmpdir(), "goat-worker-bounds-"));
    const dbPath = join(root, "upgrade.sqlite");
    let db: DatabaseClient | undefined;
    let raw: DatabaseSync | undefined;
    try {
      raw = new DatabaseSync(dbPath);
      oldHistory(raw);
      db = bridge(raw);
      // v213 predates generated Chat tasks. Model that absent feature only while
      // constructing historical rows; restore the current owner before upgrade.
      const legacyTaskLookup = t.mock.method(RemoteWorkerChatTaskRepository.prototype, "findForRun", () => undefined);
      let fixture: ReturnType<typeof seedRemoteWorkerInferenceAuthority>;
      try {
        fixture = seedRemoteWorkerInferenceAuthority(db, "bounds-legacy");
      } finally {
        legacyTaskLookup.mock.restore();
      }
      assert.equal(
        db.prepare("SELECT name FROM sqlite_schema WHERE name = 'remote_worker_chat_tasks'").get(),
        undefined,
      );
      const aggregate = new RemoteWorkerAssignmentRepository(db).findAssignmentAggregate(
        "default",
        fixture.assignmentId,
      );
      assert.equal(aggregate?.generation?.dispatchAuthority.durableRunAttempt, 1);
      const objects = retainedObjects(db);
      const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      db.close();
      db = undefined;
      raw = undefined;
      db = createDatabase({ dbPath });
      assert.deepEqual(
        new RemoteWorkerAssignmentRepository(db).findAssignmentAggregate("default", fixture.assignmentId),
        aggregate,
      );
      assert.deepEqual(retainedObjects(db), objects);
      assert.deepEqual(
        db.prepare("SELECT * FROM schema_migrations WHERE version <= 213 ORDER BY version").all(),
        ledger,
      );
      // Normal startup must reach the reviewed current SQLite registry, not stop
      // at the historical migration under test.
      assert.equal(
        db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get<{ version: number }>()!.version,
        250,
      );
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(db.prepare("PRAGMA foreign_keys").get<{ foreign_keys: number }>()!.foreign_keys, 1);
    } finally {
      if (db) db.close();
      else raw?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("admits zero attempts and exact millisecond TTL endpoints while preserving references and immutable guards", () => {
    const raw = new DatabaseSync(":memory:");
    const db = bridge(raw);
    try {
      raw.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE remote_worker_assignment_generations (id INTEGER PRIMARY KEY,
          durable_run_attempt INTEGER CHECK(typeof(durable_run_attempt) = 'integer' AND durable_run_attempt > 0), bytes TEXT);
        CREATE TABLE retained_lease (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES remote_worker_assignment_generations(id) ON DELETE RESTRICT);
        CREATE TRIGGER retained_attempt_no_update BEFORE UPDATE ON remote_worker_assignment_generations BEGIN SELECT RAISE(ABORT, 'immutable'); END;
        CREATE TABLE remote_worker_mesh_join_authorities (id INTEGER PRIMARY KEY, issued_at TEXT,
          expires_at TEXT CHECK((julianday(expires_at) - julianday(issued_at)) * 86400 BETWEEN 1 AND 600));
        INSERT INTO remote_worker_assignment_generations VALUES (1, 1, 'exact old authority bytes');
        INSERT INTO retained_lease VALUES (1, 1);`);
      assert.throws(
        () => raw.prepare("INSERT INTO remote_worker_assignment_generations VALUES (2, 0, 'first')").run(),
        /CHECK/u,
      );
      db.transaction("immediate", () => upgradeRemoteWorkerCanonicalBounds(raw));
      raw.prepare("INSERT INTO remote_worker_assignment_generations VALUES (2, 0, 'first')").run();
      for (const invalid of [-1, 0.5])
        assert.throws(
          () => raw.prepare("INSERT INTO remote_worker_assignment_generations VALUES (3, ?, 'bad')").run(invalid),
          /CHECK/u,
        );
      assert.throws(
        () => raw.prepare("UPDATE remote_worker_assignment_generations SET bytes = 'changed' WHERE id = 1").run(),
        /immutable/u,
      );
      assert.equal(
        raw.prepare("SELECT bytes FROM remote_worker_assignment_generations WHERE id = 1").get()?.bytes,
        "exact old authority bytes",
      );
      assert.equal(raw.prepare("SELECT parent_id FROM retained_lease").get()?.parent_id, 1);
      const start = Date.parse("2026-09-10T09:00:00.123Z");
      const insert = raw.prepare("INSERT INTO remote_worker_mesh_join_authorities VALUES (?, ?, ?)");
      for (const [index, milliseconds] of [1000, 1001, 599999, 600000].entries())
        insert.run(index, new Date(start).toISOString(), new Date(start + milliseconds).toISOString());
      for (const milliseconds of [0, 999, 600001])
        assert.throws(
          () => insert.run(10, new Date(start).toISOString(), new Date(start + milliseconds).toISOString()),
          /CHECK/u,
        );
      assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      raw.close();
    }
  });
});
