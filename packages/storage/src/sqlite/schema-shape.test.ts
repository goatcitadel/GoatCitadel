import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createDatabase } from "../sqlite.js";
import { runSqliteMigrations, type SqliteMigration } from "./migration-registry.js";
import { assertSqliteSchemaShape, readSqliteSchemaShape } from "./schema-shape.js";

describe("SQLite canonical schema shape", () => {
  it("rejects corrupt columns, constraints, and partial-index predicates", () => {
    const canonical = new DatabaseSync(":memory:");
    const corrupt = new DatabaseSync(":memory:");
    try {
      canonical.exec(`
        CREATE TABLE shape_probe (
          id INTEGER PRIMARY KEY,
          state TEXT NOT NULL CHECK(state IN ('active', 'closed'))
        );
        CREATE UNIQUE INDEX idx_shape_probe_active ON shape_probe(state) WHERE state = 'active';
      `);
      corrupt.exec(`
        CREATE TABLE shape_probe (
          id TEXT PRIMARY KEY,
          state TEXT CHECK(state <> '')
        );
        CREATE INDEX idx_shape_probe_active ON shape_probe(id) WHERE state = 'closed';
      `);

      assert.throws(
        () => assertSqliteSchemaShape(readSqliteSchemaShape(corrupt), readSqliteSchemaShape(canonical)),
        /non-canonical index idx_shape_probe_active.*non-canonical table shape_probe/,
      );
    } finally {
      canonical.close();
      corrupt.close();
    }
  });

  it("detects a skipped IF NOT EXISTS object after migration", () => {
    const canonical = new DatabaseSync(":memory:");
    const target = new DatabaseSync(":memory:");
    const migrations: SqliteMigration[] = [
      {
        version: 1,
        name: "shape_probe",
        up(db) {
          db.exec("CREATE TABLE IF NOT EXISTS shape_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
        },
      },
    ];
    try {
      runSqliteMigrations(canonical, migrations);
      const expected = readSqliteSchemaShape(canonical);
      target.exec("CREATE TABLE shape_probe (id TEXT PRIMARY KEY, wrong_value BLOB)");

      runSqliteMigrations(target, migrations);
      assert.throws(
        () => assertSqliteSchemaShape(readSqliteSchemaShape(target), expected),
        /canonical schema-shape validation failed/u,
      );
      assert.equal(target.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 1);
    } finally {
      canonical.close();
      target.close();
    }
  });

  it("rejects canonical database drift on an already-complete startup", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-schema-shape-${randomUUID()}.db`);
    try {
      const created = createDatabase({ dbPath });
      created.close();
      const corrupt = new DatabaseSync(dbPath);
      try {
        corrupt.exec("ALTER TABLE operator_profiles RENAME COLUMN summary TO wrong_summary");
      } finally {
        corrupt.close();
      }

      assert.throws(() => createDatabase({ dbPath }), /non-canonical table operator_profiles/);
    } finally {
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(file, { force: true });
    }
  });
});
