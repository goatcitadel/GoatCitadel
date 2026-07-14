import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { __sqliteInternals, createDatabase, createSqliteSchemaBlueprint } from "./sqlite.js";

const EXPECTED_COLUMNS = [
  "workspace_id",
  "board_id",
  "schema_version",
  "name",
  "description",
  "layout_json",
  "status",
  "revision",
  "created_by_actor_id",
  "created_at",
  "updated_by_actor_id",
  "updated_at",
  "archived_by_actor_id",
  "archived_at",
  "idempotency_key",
  "request_sha256",
] as const;

describe("HX-410 trusted ops saved board schema parity", () => {
  it("keeps paired SQLite 167 and PostgreSQL 109 present after later migrations", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const migration = db.prepare("SELECT version, name FROM schema_migrations WHERE version = 167").get() as {
        version: number;
        name: string;
      };
      assert.deepEqual(
        { version: Number(migration.version), name: migration.name },
        { version: 167, name: "trusted_ops_saved_boards" },
      );
      const head = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
      assert.ok(Number(head.version) >= 167);
    } finally {
      db.close();
    }
    assert.equal(POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 109)?.name, "trusted_ops_saved_boards");
    assert.ok((POSTGRES_MIGRATIONS.at(-1)?.version ?? 0) >= 109);
  });

  it("declares the same composite identity, columns, bounded layout, and immutable create metadata", () => {
    const sqlite = createSqliteSchemaBlueprint();
    const table = sqlite.tables.find((candidate) => candidate.name === "ops_saved_boards");
    assert.ok(table);
    assert.deepEqual(
      table.columns.map((column) => column.name),
      EXPECTED_COLUMNS,
    );
    assert.deepEqual(
      table.columns
        .filter((column) => column.primaryKeyPosition > 0)
        .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
        .map((column) => column.name),
      ["workspace_id", "board_id"],
    );

    const postgres = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 109)?.sql ?? "";
    assert.deepEqual(extractColumnNames(postgres, "ops_saved_boards"), EXPECTED_COLUMNS);
    for (const sql of [sqlite167Source(), postgres]) {
      assert.match(sql, /PRIMARY KEY\s*\(workspace_id, board_id\)/u);
      assert.match(sql, /UNIQUE\s*\(workspace_id, idempotency_key\)/u);
      assert.match(sql, /layout_json[\s\S]*?(?:json_array_length|jsonb_array_length)[\s\S]*?BETWEEN 1 AND 12/iu);
      assert.match(sql, /(?:length\(CAST\(layout_json AS BLOB\)\)|octet_length\(layout_json\))\s*<=\s*16384/iu);
      assert.match(sql, /request_sha256[\s\S]*?64/iu);
      assert.match(sql, /status IN \('active', 'archived'\)/u);
      assert.doesNotMatch(sql, /\b(?:INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/iu);
    }
  });

  it("keeps cap, exact-revision transition, and no-delete enforcement in both dialects", () => {
    const sqlite = sqlite167Source();
    const postgres = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 109)?.sql ?? "";
    for (const sql of [sqlite, postgres]) {
      for (const trigger of [
        "trg_ops_saved_boards_insert_invariant",
        "trg_ops_saved_boards_cap_insert",
        "trg_ops_saved_boards_cas_update",
        "trg_ops_saved_boards_no_delete",
      ]) {
        assert.match(sql, new RegExp(`CREATE TRIGGER(?: IF NOT EXISTS)? ${trigger}`, "u"));
      }
      assert.match(sql, /revision[^\n]*OLD\.revision \+ 1/iu);
      assert.match(sql, /created_by_actor_id[\s\S]*created_at[\s\S]*idempotency_key[\s\S]*request_sha256/iu);
      assert.match(sql, />= 64/u);
      assert.match(sql, /NEW\.updated_at < OLD\.updated_at/u);
    }
    assert.match(postgres, /pg_advisory_xact_lock\(hashtextextended\(NEW\.workspace_id, 410\)\)/u);
    assert.match(
      sqlite,
      /NOT EXISTS\s*\([\s\S]*workspace_id = NEW\.workspace_id AND idempotency_key = NEW\.idempotency_key/iu,
    );
    assert.match(
      postgres,
      /IF EXISTS\s*\([\s\S]*workspace_id = NEW\.workspace_id AND idempotency_key = NEW\.idempotency_key/iu,
    );
  });

  it("keeps foreign keys valid and records a sparse repair without inventing a workspace owner", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }

    const dbPath = path.join(os.tmpdir(), `goatcitadel-hx410-sparse-${randomUUID()}.db`);
    try {
      const sparse = new DatabaseSync(dbPath);
      sparse.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      const mark = sparse.prepare(`
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (?, ?, '2026-07-14T12:00:00.000Z')
      `);
      for (let version = 1; version <= 166; version += 1) mark.run(version, `legacy-${version}`);
      __sqliteInternals.applySchemaMigrationForTest(167, sparse);
      assert.equal(
        sparse.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ops_saved_boards'").get(),
        undefined,
      );
      sparse.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });
});

function sqlite167Source(): string {
  const source = fs.readFileSync(new URL("./sqlite.ts", import.meta.url), "utf8");
  const start = source.indexOf("version: 167");
  assert.notEqual(start, -1);
  const end = source.indexOf("          `);", start);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

function extractColumnNames(source: string, table: string): string[] {
  const marker = `CREATE TABLE IF NOT EXISTS ${table}`;
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1);
  const open = source.indexOf("(", markerIndex + marker.length);
  const close = findBalancedClose(source, open);
  return splitTopLevel(source.slice(open + 1, close))
    .map((segment) => segment.trim())
    .filter((segment) => !/^(?:PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/iu.test(segment))
    .map((segment) => segment.match(/^(\w+)\s+/u)?.[1])
    .filter((value): value is string => Boolean(value));
}

function findBalancedClose(source: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'" && source[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth += 1;
    if (character === ")" && --depth === 0) return index;
  }
  throw new Error("Unbalanced migration table DDL");
}

function splitTopLevel(body: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "'" && body[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      segments.push(body.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(body.slice(start));
  return segments;
}
