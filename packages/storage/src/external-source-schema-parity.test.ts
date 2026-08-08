import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { __sqliteInternals, createDatabase } from "./sqlite.js";

const TABLES = [
  "external_source_configs",
  "external_source_scans",
  "external_source_catalog_items",
  "external_source_import_plans",
  "external_source_import_intents",
  "external_source_import_items",
  "external_source_import_settlements",
  "chat_external_source_attachments",
  "external_source_knowledge_links",
] as const;

const databases: DatabaseClient[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/**
 * The coverage lane runs these tests compiled from dist/, where the TypeScript
 * sources do not exist, while the fast lane runs them from src/ via tsx. Resolve
 * the checked-in migration source for either layout.
 */
function sqliteSourceUrl(): URL {
  const candidates = [new URL("./sqlite.ts", import.meta.url), new URL("../src/sqlite.ts", import.meta.url)];
  const found = candidates.find((candidate) => existsSync(candidate));
  assert.ok(found, "SQLite migration source must be readable from either the src or dist layout");
  return found;
}

function sqlite166Source(): string {
  const source = readFileSync(sqliteSourceUrl(), "utf8");
  const start = source.indexOf("version: 166");
  assert.notEqual(start, -1, "SQLite migration 166 must exist");
  const end = source.indexOf("          `);", start);
  assert.notEqual(end, -1, "SQLite migration 166 SQL must terminate");
  return source.slice(start, end);
}

function postgres108Source(): string {
  const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 108);
  assert.equal(migration?.name, "governed_external_sources_foundation");
  assert.equal(migration?.batchedStatements, undefined);
  assert.ok(migration?.sql);
  return migration.sql;
}

describe("HX-407 paired external-source schema parity", () => {
  it("keeps SQLite 166 and PostgreSQL 108 present with additive schema-only DDL after later migrations", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    databases.push(db);
    const migration = db.prepare("SELECT version, name FROM schema_migrations WHERE version = 166").get() as {
      version: number;
      name: string;
    };
    assert.deepEqual(
      { version: Number(migration.version), name: migration.name },
      {
        version: 166,
        name: "governed_external_sources_foundation",
      },
    );
    const sqliteHead = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
    assert.ok(Number(sqliteHead.version) >= 166);
    assert.equal(
      POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 108)?.name,
      "governed_external_sources_foundation",
    );
    assert.ok((POSTGRES_MIGRATIONS.at(-1)?.version ?? 0) >= 108);
    for (const sql of [sqlite166Source(), postgres108Source()]) {
      assert.doesNotMatch(sql, /\b(?:INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/iu);
      assert.doesNotMatch(sql, /ALTER\s+TABLE[\s\S]*?DROP\s+(?:COLUMN|CONSTRAINT)/iu);
    }
  });

  it("declares the same nine tables, columns, indexes, and trigger identities", () => {
    const sqlite = sqlite166Source();
    const postgres = postgres108Source();
    assert.deepEqual(extractNames(sqlite, /CREATE TABLE IF NOT EXISTS\s+(\w+)/giu), [...TABLES].sort());
    assert.deepEqual(extractNames(postgres, /CREATE TABLE IF NOT EXISTS\s+(\w+)/giu), [...TABLES].sort());

    for (const table of TABLES) {
      assert.deepEqual(extractColumnNames(sqlite, table), extractColumnNames(postgres, table), table);
    }
    assert.deepEqual(
      extractNames(sqlite, /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+(\w+)/giu),
      extractNames(postgres, /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+(\w+)/giu),
    );
    assert.deepEqual(
      extractNames(sqlite, /CREATE TRIGGER(?: IF NOT EXISTS)?\s+(\w+)/giu),
      extractNames(postgres, /CREATE TRIGGER(?: IF NOT EXISTS)?\s+(\w+)/giu),
    );
  });

  it("keeps catalog rows content-free and enforces the frozen caps in both dialects", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    databases.push(db);
    const sqlite = sqlite166Source();
    const postgres = postgres108Source();
    const columns = db.prepare("PRAGMA table_info(external_source_catalog_items)").all() as Array<{
      name: string;
    }>;
    const names = columns.map((column) => column.name);
    assert.deepEqual(names, extractColumnNames(sqlite, "external_source_catalog_items"));
    for (const name of names) {
      assert.doesNotMatch(name, /(?:content|transcript|prompt|response|tool_output|raw_bytes|raw_body)/iu);
    }
    for (const sql of [sqlite, postgres]) {
      assert.match(
        sql,
        /auth_actor_source[^\n]*CHECK\(auth_actor_source IN \('token', 'basic', 'loopback', 'device_grant', 'none'\)\)/u,
      );
      for (const token of ["16777216", "8388608", "26214400", "50000", "10000", "5000", "2048", "65536"]) {
        assert.match(sql, new RegExp(`\\b${token}\\b`, "u"));
      }
      assert.match(sql, /status\s*=\s*'detached'[\s\S]*detached_by_actor_id IS NOT NULL/iu);
      assert.match(sql, /UNIQUE\(workspace_id, idempotency_key\)/u);
      assert.match(sql, /UNIQUE\(workspace_id, import_id\)/u);
      assert.match(sql, /FOREIGN KEY\(workspace_id, import_id, source_id\)/u);
      assert.match(sql, /FOREIGN KEY\(approval_id\) REFERENCES approvals\(approval_id\) ON DELETE RESTRICT/u);
    }
    assert.match(
      sqlite,
      /active_cap_insert[\s\S]*NOT EXISTS\s*\([\s\S]*workspace_id = NEW\.workspace_id AND source_id = NEW\.source_id/iu,
    );
    assert.match(
      postgres,
      /TG_OP = 'INSERT' AND EXISTS\s*\([\s\S]*workspace_id = NEW\.workspace_id AND source_id = NEW\.source_id/iu,
    );
  });

  it("keeps every SQLite foreign key valid after the sparse additive migration", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    databases.push(db);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });

  it("does not invent or backfill missing parent owners in a repair-only sparse database", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-hx407-sparse-${randomUUID()}.db`);
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
        VALUES (?, ?, '2026-07-14T08:00:00.000Z')
      `);
      for (let version = 1; version <= 165; version += 1)
        mark.run(version, __sqliteInternals.getSchemaMigrationNameForTest(version));
      // The session-control migrations (172-174) and secure-configuration reservation migrations
      // (188-189) fail closed unless the database carries their real predecessors, so apply just
      // those creators: chat workspace (10), agentic chat (13), agentic depth (17), durable runs
      // (21), device auth (27), companion sessions (45), and chat turn capability profiles (154).
      // Every external-source parent and child stays absent, which is the sparse premise under test.
      for (const version of [10, 13, 17, 21, 27, 45, 154]) {
        __sqliteInternals.applySchemaMigrationForTest(version, sparse);
      }
      sparse.close();

      const migrated = createDatabase({ dbPath });
      try {
        const recorded = migrated.prepare("SELECT name FROM schema_migrations WHERE version = 166").get() as
          | { name: string }
          | undefined;
        assert.equal(recorded?.name, "governed_external_sources_foundation");
        assert.equal(
          migrated
            .prepare(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'external_source_%'",
            )
            .get<{ count: number }>()?.count,
          0,
        );
        const migrationHead = migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
          version: number;
        };
        assert.ok(Number(migrationHead.version) >= 189);
      } finally {
        migrated.close();
      }
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });
});

function extractNames(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]!).sort();
}

function extractColumnNames(source: string, table: string): string[] {
  const marker = `CREATE TABLE IF NOT EXISTS ${table}`;
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `${table} must exist`);
  const open = source.indexOf("(", markerIndex + marker.length);
  assert.notEqual(open, -1, `${table} must have a column list`);
  const close = findBalancedClose(source, open);
  const segments = splitTopLevel(source.slice(open + 1, close));
  return segments
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
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
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
