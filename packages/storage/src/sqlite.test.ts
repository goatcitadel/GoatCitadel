import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { __sqliteInternals, createDatabase, createSqliteSchemaBlueprint } from "./sqlite.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";

test("SQLite Citadel parent-scope migration uses runtime-style slug normalization for legacy charters", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE workspaces (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL DEFAULT 'active',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE citadel_charters (
        citadel_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO workspaces (workspace_id, name, lifecycle_status, updated_at)
      VALUES
        ('team_alpha', 'Team Alpha', 'active', '2026-05-01T00:00:00.000Z'),
        ('ws-legacy', 'Dash Legacy', 'active', '2026-05-01T00:00:00.000Z'),
        ('ws_legacy', 'Underscore Legacy', 'active', '2026-05-01T00:00:00.000Z');
      INSERT INTO citadel_charters (citadel_id, kind, created_at, updated_at)
      VALUES
        ('team_alpha', 'custom', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
        ('ws-legacy', 'custom', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
        ('ws_legacy', 'custom', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z');
    `);

    __sqliteInternals.applySchemaMigrationForTest(121, db);

    const rows = (
      db
        .prepare(
          `
          SELECT citadel_id, slug
          FROM citadel_records
          WHERE citadel_id IN ('team_alpha', 'ws-legacy', 'ws_legacy')
          ORDER BY citadel_id ASC
        `,
        )
        .all() as Array<{ citadel_id: string; slug: string }>
    ).map((row) => ({ citadel_id: row.citadel_id, slug: row.slug }));

    assert.deepEqual(rows, [
      { citadel_id: "team_alpha", slug: "team-alpha" },
      { citadel_id: "ws-legacy", slug: "ws-legacy" },
      { citadel_id: "ws_legacy", slug: "ws-legacy-2" },
    ]);
  } finally {
    db.close();
  }
});

test("SQLite Citadel parent-scope migration tolerates legacy charters before workspaces exist", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE citadel_charters (
        citadel_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO citadel_charters (citadel_id, kind, created_at, updated_at)
      VALUES
        ('legacy_team', 'custom', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z');
    `);

    __sqliteInternals.applySchemaMigrationForTest(121, db);

    const row = db
      .prepare("SELECT citadel_id, name, slug, default_workspace_id FROM citadel_records WHERE citadel_id = ?")
      .get("legacy_team") as {
      citadel_id: string;
      default_workspace_id: string | null;
      name: string;
      slug: string;
    };

    assert.deepEqual(
      { ...row },
      {
        citadel_id: "legacy_team",
        name: "legacy_team",
        slug: "legacy-team",
        default_workspace_id: null,
      },
    );
  } finally {
    db.close();
  }
});

function makeBenchmarkRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rowid: 1,
    item_id: "item-1",
    benchmark_run_id: "bench-1",
    pack_id: "pack-1",
    test_id: "test-1",
    test_code: "TEST-1",
    provider_id: "openai",
    model: "gpt-5.4",
    run_id: null,
    score_id: null,
    auto_score_id: null,
    run_status: "queued",
    total_score: null,
    weighted_score: null,
    verdict: null,
    score_state: null,
    failure_signal: null,
    created_at: null,
    original_rowid: null,
    source_created_at: null,
    archived_at: null,
    ...overrides,
  };
}

test("SQLite benchmark dedup migration preserves the newest complete duplicate before enforcing uniqueness", () => {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-sqlite-migration-${randomUUID()}.db`);
  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  try {
    createDatabase({ dbPath }).close();

    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      DELETE FROM schema_migrations WHERE version >= 53;
      DROP INDEX IF EXISTS idx_prompt_pack_benchmark_items_unique;
      DELETE FROM prompt_pack_benchmark_items;
      DELETE FROM prompt_pack_benchmark_runs;
    `);
    seed
      .prepare(
        `
        INSERT INTO prompt_pack_benchmark_runs (
          benchmark_run_id,
          pack_id,
          status,
          test_codes_json,
          providers_json,
          total_items,
          completed_items,
          claimed_by_worker_id,
          claim_heartbeat_at,
          claim_expires_at,
          error,
          started_at,
          finished_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run("bench-1", "pack-1", "queued", "[]", "[]", 2, 0, null, null, null, null, "2026-04-16T00:00:00.000Z", null);
    const insertItem = seed.prepare(
      `
        INSERT INTO prompt_pack_benchmark_items (
          item_id,
          benchmark_run_id,
          pack_id,
          test_id,
          test_code,
          provider_id,
          model,
          run_id,
          score_id,
          auto_score_id,
          run_status,
          total_score,
          weighted_score,
          verdict,
          score_state,
          failure_signal,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    insertItem.run(
      "item-1",
      "bench-1",
      "pack-1",
      "test-1",
      "TEST-1",
      "openai",
      "gpt-5.4",
      "run-1",
      null,
      null,
      "completed",
      4,
      1,
      "pass",
      "scored",
      null,
      "2026-04-16T00:01:00.000Z",
    );
    insertItem.run(
      "item-2",
      "bench-1",
      "pack-1",
      "test-1",
      "TEST-1",
      "openai",
      "gpt-5.4",
      "run-2",
      null,
      null,
      "completed",
      3,
      0.75,
      "review",
      "scored",
      null,
      "2026-04-16T00:02:00.000Z",
    );
    seed.close();

    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };

    const migrated = createDatabase({ dbPath });
    const dedupedItems = migrated
      .prepare("SELECT item_id FROM prompt_pack_benchmark_items ORDER BY item_id ASC")
      .all<{ item_id: string }>()
      .map((row) => row.item_id);
    const archivedItems = migrated
      .prepare("SELECT item_id FROM prompt_pack_benchmark_item_dedup_audit ORDER BY item_id ASC")
      .all<{ item_id: string }>()
      .map((row) => row.item_id);

    assert.deepEqual(dedupedItems, ["item-2"]);
    assert.deepEqual(archivedItems, ["item-1"]);
    assert.equal(warnCalls.length, 1);
    assert.equal(String(warnCalls[0]?.[0]).includes("archiving duplicate prompt-pack benchmark items"), true);
    migrated.close();

    const rerun = createDatabase({ dbPath });
    const rerunArchivedItems = rerun
      .prepare("SELECT item_id FROM prompt_pack_benchmark_item_dedup_audit ORDER BY item_id ASC")
      .all<{ item_id: string }>()
      .map((row) => row.item_id);
    assert.deepEqual(rerunArchivedItems, ["item-1"]);
    rerun.close();
  } finally {
    console.warn = originalWarn;
    try {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      // ignore cleanup failures in tests
    }
  }
});

test("SQLite benchmark dedup repair restores the archived winner for databases that already kept the wrong survivor", () => {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-sqlite-repair-${randomUUID()}.db`);
  try {
    createDatabase({ dbPath }).close();

    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      DELETE FROM schema_migrations WHERE version >= 61;
      DELETE FROM prompt_pack_benchmark_items;
      DELETE FROM prompt_pack_benchmark_runs;
      DELETE FROM prompt_pack_benchmark_item_dedup_audit;
    `);
    seed
      .prepare(
        `
        INSERT INTO prompt_pack_benchmark_runs (
          benchmark_run_id,
          pack_id,
          status,
          test_codes_json,
          providers_json,
          total_items,
          completed_items,
          claimed_by_worker_id,
          claim_heartbeat_at,
          claim_expires_at,
          error,
          started_at,
          finished_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run("bench-1", "pack-1", "queued", "[]", "[]", 1, 0, null, null, null, null, "2026-04-16T00:00:00.000Z", null);
    seed
      .prepare(
        `
        INSERT INTO prompt_pack_benchmark_items (
          item_id,
          benchmark_run_id,
          pack_id,
          test_id,
          test_code,
          provider_id,
          model,
          run_id,
          score_id,
          auto_score_id,
          run_status,
          total_score,
          weighted_score,
          verdict,
          score_state,
          failure_signal,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "item-live-old",
        "bench-1",
        "pack-1",
        "test-1",
        "TEST-1",
        "openai",
        "gpt-5.4",
        "run-old",
        null,
        null,
        "completed",
        2,
        null,
        null,
        null,
        null,
        "2026-04-16T00:01:00.000Z",
      );
    seed
      .prepare(
        `
        INSERT INTO prompt_pack_benchmark_item_dedup_audit (
          item_id,
          benchmark_run_id,
          pack_id,
          test_id,
          test_code,
          provider_id,
          model,
          run_id,
          score_id,
          auto_score_id,
          run_status,
          total_score,
          weighted_score,
          verdict,
          score_state,
          failure_signal,
          original_rowid,
          source_created_at,
          archived_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "item-archived-better",
        "bench-1",
        "pack-1",
        "test-1",
        "TEST-1",
        "openai",
        "gpt-5.4",
        "run-better",
        null,
        "auto-better",
        "completed",
        4,
        1,
        "pass",
        "auto_valid",
        null,
        2,
        "2026-04-16T00:03:00.000Z",
        "2026-04-16T00:03:00.000Z",
      );
    seed.close();

    const repaired = createDatabase({ dbPath });
    const liveItems = repaired
      .prepare("SELECT item_id FROM prompt_pack_benchmark_items ORDER BY item_id ASC")
      .all<{ item_id: string }>()
      .map((row) => row.item_id);
    const archivedItems = repaired
      .prepare("SELECT item_id FROM prompt_pack_benchmark_item_dedup_audit ORDER BY item_id ASC")
      .all<{ item_id: string }>()
      .map((row) => row.item_id);

    assert.deepEqual(liveItems, ["item-archived-better"]);
    assert.deepEqual(archivedItems, ["item-live-old"]);
    repaired.close();
  } finally {
    try {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      // ignore cleanup failures in tests
    }
  }
});

test("SQLite migration runner rolls back the active migration when migration SQL fails", () => {
  const execCalls: string[] = [];
  const fakeDb = {
    exec(sql: string) {
      const normalized = sql.trim();
      execCalls.push(normalized);
      if (
        normalized.includes("CREATE TABLE IF NOT EXISTS schema_migrations") ||
        normalized === "BEGIN IMMEDIATE" ||
        normalized === "ROLLBACK"
      ) {
        return;
      }
      throw new Error("migration failed");
    },
    prepare(sql: string) {
      if (sql.includes("SELECT version FROM schema_migrations")) {
        return { all: () => [] };
      }
      if (sql.includes("INSERT INTO schema_migrations")) {
        return {
          run: () => {
            throw new Error("failed migration should not be marked applied");
          },
        };
      }
      throw new Error(`unexpected prepare: ${sql}`);
    },
  } as unknown as DatabaseSync;

  assert.throws(() => __sqliteInternals.migrate(fakeDb), /migration failed/);
  assert.equal(execCalls.includes("ROLLBACK"), true);
});

test("SQLite schema blueprint handles unavailable sqlite reflection APIs", () => {
  const blueprint = __sqliteInternals.createSqliteSchemaBlueprintFromDatabase({
    close() {
      throw new Error("fallback should return before closing an unavailable sqlite database");
    },
  } as unknown as DatabaseSync);

  assert.deepEqual(blueprint, { tables: [] });
});

test("SQLite approval effects pipeline migration creates its base table when migration 58 was skipped", () => {
  const db = new DatabaseSync(":memory:");
  try {
    __sqliteInternals.applySchemaMigrationForTest(59, db);

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("approval_effects") as { name: string } | undefined;
    assert.equal(table?.name, "approval_effects");

    const columns = new Set(
      (db.prepare("PRAGMA table_info(approval_effects)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    assert.equal(columns.has("target_kind"), true);
    assert.equal(columns.has("idempotency_key"), true);
    assert.equal(columns.has("payload_json"), true);
    assert.equal(columns.has("version"), true);
  } finally {
    db.close();
  }
});

test("SQLite subagent column migration no-ops without the legacy openclaw column", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE task_subagent_sessions (subagent_session_id TEXT PRIMARY KEY);");

    __sqliteInternals.migrateTaskSubagentSessionColumns(db);

    const columns = new Set(
      (db.prepare("PRAGMA table_info(task_subagent_sessions)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    assert.equal(columns.has("agent_session_id"), false);
  } finally {
    db.close();
  }
});

test("SQLite subagent column migration rebuilds the table when rename column is unavailable", () => {
  const execCalls: string[] = [];
  const fakeDb = {
    prepare(sql: string) {
      assert.match(sql, /PRAGMA table_info\(task_subagent_sessions\)/);
      return {
        all: () => [
          { name: "subagent_session_id" },
          { name: "task_id" },
          { name: "openclaw_session_id" },
          { name: "agent_name" },
          { name: "status" },
          { name: "created_at" },
          { name: "updated_at" },
          { name: "ended_at" },
        ],
      };
    },
    exec(sql: string) {
      execCalls.push(sql);
      if (sql.includes("RENAME COLUMN openclaw_session_id TO agent_session_id")) {
        throw new Error("rename column unavailable");
      }
    },
  } as unknown as DatabaseSync;

  __sqliteInternals.migrateTaskSubagentSessionColumns(fakeDb);

  assert.equal(
    execCalls.some((sql) => sql.includes("CREATE TABLE task_subagent_sessions_new")),
    true,
  );
  assert.equal(
    execCalls.some((sql) => sql.includes("openclaw_session_id, agent_name")),
    true,
  );
});

test("SQLite benchmark dedup pass releases cleanly when a reported group has no duplicate live rows", () => {
  const execCalls: string[] = [];
  const fakeDb = {
    exec(sql: string) {
      execCalls.push(sql.trim());
    },
    prepare(sql: string) {
      if (sql.includes("GROUP BY benchmark_run_id, provider_id, model, test_id")) {
        return {
          all: () => [
            {
              benchmark_run_id: "bench-1",
              provider_id: "openai",
              model: "gpt-5.4",
              test_id: "test-1",
            },
          ],
        };
      }
      if (sql.includes("SELECT rowid, *")) {
        return { all: () => [makeBenchmarkRow()] };
      }
      return {
        run: () => {
          throw new Error(`unexpected write for non-duplicate group: ${sql}`);
        },
      };
    },
  } as unknown as DatabaseSync;

  __sqliteInternals.runPromptPackBenchmarkDedupPass(fakeDb);

  assert.deepEqual(execCalls, [
    "SAVEPOINT prompt_pack_benchmark_dedup_pass",
    "RELEASE SAVEPOINT prompt_pack_benchmark_dedup_pass",
  ]);
});

test("SQLite benchmark dedup pass rolls back when archiving a duplicate fails", () => {
  const execCalls: string[] = [];
  const fakeDb = {
    exec(sql: string) {
      execCalls.push(sql.trim());
    },
    prepare(sql: string) {
      if (sql.includes("GROUP BY benchmark_run_id, provider_id, model, test_id")) {
        return {
          all: () => [
            {
              benchmark_run_id: "bench-1",
              provider_id: "openai",
              model: "gpt-5.4",
              test_id: "test-1",
            },
          ],
        };
      }
      if (sql.includes("SELECT rowid, *")) {
        return {
          all: () => [
            makeBenchmarkRow({ item_id: "item-old", rowid: 1, created_at: "2026-04-16T00:01:00.000Z" }),
            makeBenchmarkRow({
              item_id: "item-winner",
              rowid: 2,
              run_status: "completed",
              total_score: 4,
              created_at: "2026-04-16T00:02:00.000Z",
            }),
          ],
        };
      }
      if (sql.includes("INSERT OR IGNORE INTO prompt_pack_benchmark_item_dedup_audit")) {
        return {
          run: () => {
            throw new Error("dedup insert failed");
          },
        };
      }
      return {
        run: () => {
          throw new Error(`unexpected write after failed archive: ${sql}`);
        },
      };
    },
  } as unknown as DatabaseSync;

  assert.throws(() => __sqliteInternals.runPromptPackBenchmarkDedupPass(fakeDb), /dedup insert failed/);
  assert.equal(execCalls.includes("ROLLBACK TO SAVEPOINT prompt_pack_benchmark_dedup_pass"), true);
  assert.equal(execCalls.includes("RELEASE SAVEPOINT prompt_pack_benchmark_dedup_pass"), true);
});

test("SQLite benchmark dedup repair returns before work when the audit table is absent", () => {
  const db = new DatabaseSync(":memory:");
  try {
    __sqliteInternals.repairPromptPackBenchmarkDedupWinners(db);
  } finally {
    db.close();
  }
});

test("SQLite benchmark dedup repair skips live rows with no archived partner", () => {
  const execCalls: string[] = [];
  const fakeDb = {
    exec(sql: string) {
      execCalls.push(sql.trim());
    },
    prepare(sql: string) {
      if (sql.includes("sqlite_master")) {
        return { get: () => ({ name: "prompt_pack_benchmark_item_dedup_audit" }) };
      }
      if (sql.includes("SELECT rowid, * FROM prompt_pack_benchmark_items")) {
        return { all: () => [makeBenchmarkRow({ item_id: "item-live" })] };
      }
      if (sql.includes("FROM prompt_pack_benchmark_item_dedup_audit") && sql.includes("WHERE")) {
        return { all: () => [] };
      }
      return {
        run: () => {
          throw new Error(`unexpected repair write without archived rows: ${sql}`);
        },
      };
    },
  } as unknown as DatabaseSync;

  __sqliteInternals.repairPromptPackBenchmarkDedupWinners(fakeDb);

  assert.deepEqual(execCalls, [
    "SAVEPOINT prompt_pack_benchmark_dedup_repair",
    "RELEASE SAVEPOINT prompt_pack_benchmark_dedup_repair",
  ]);
});

test("SQLite benchmark dedup repair rolls back when replacing the live winner fails", () => {
  const execCalls: string[] = [];
  const fakeDb = {
    exec(sql: string) {
      execCalls.push(sql.trim());
    },
    prepare(sql: string) {
      if (sql.includes("sqlite_master")) {
        return { get: () => ({ name: "prompt_pack_benchmark_item_dedup_audit" }) };
      }
      if (sql.includes("SELECT rowid, * FROM prompt_pack_benchmark_items")) {
        return { all: () => [makeBenchmarkRow({ item_id: "item-live", rowid: 1 })] };
      }
      if (sql.includes("FROM prompt_pack_benchmark_item_dedup_audit") && sql.includes("WHERE")) {
        return {
          all: () => [
            makeBenchmarkRow({
              item_id: "item-archived-better",
              original_rowid: 2,
              source_created_at: "2026-04-16T00:03:00.000Z",
              run_status: "completed",
              auto_score_id: "auto-1",
            }),
          ],
        };
      }
      if (sql.includes("INSERT OR IGNORE INTO prompt_pack_benchmark_item_dedup_audit")) {
        return {
          run: () => {
            throw new Error("repair insert failed");
          },
        };
      }
      return { run: () => undefined };
    },
  } as unknown as DatabaseSync;

  assert.throws(() => __sqliteInternals.repairPromptPackBenchmarkDedupWinners(fakeDb), /repair insert failed/);
  assert.equal(execCalls.includes("ROLLBACK TO SAVEPOINT prompt_pack_benchmark_dedup_repair"), true);
  assert.equal(execCalls.includes("RELEASE SAVEPOINT prompt_pack_benchmark_dedup_repair"), true);
});

test("SQLite benchmark dedup ranking orders completeness, timestamp, and row ordinal", () => {
  const {
    comparePromptPackBenchmarkDedupRowsForTest,
    getPromptPackBenchmarkDedupCompletenessRankForTest,
    getPromptPackBenchmarkDedupTimestampForTest,
    getPromptPackBenchmarkDedupOrdinalForTest,
  } = __sqliteInternals;

  assert.equal(
    getPromptPackBenchmarkDedupCompletenessRankForTest(
      makeBenchmarkRow({ run_status: "completed", auto_score_id: "auto-1" }),
    ),
    3,
  );
  assert.equal(getPromptPackBenchmarkDedupCompletenessRankForTest(makeBenchmarkRow({ run_status: "completed" })), 2);
  assert.equal(getPromptPackBenchmarkDedupCompletenessRankForTest(makeBenchmarkRow({ run_status: "failed" })), 1);
  assert.equal(getPromptPackBenchmarkDedupCompletenessRankForTest(makeBenchmarkRow({ run_status: "queued" })), 0);

  assert.equal(
    getPromptPackBenchmarkDedupTimestampForTest(
      makeBenchmarkRow({ created_at: null, source_created_at: "2026-04-16T00:03:00.000Z" }),
    ),
    Date.parse("2026-04-16T00:03:00.000Z"),
  );
  assert.equal(getPromptPackBenchmarkDedupTimestampForTest(makeBenchmarkRow({ created_at: "not-a-date" })), -Infinity);
  assert.equal(
    getPromptPackBenchmarkDedupTimestampForTest(makeBenchmarkRow({ created_at: undefined, source_created_at: null })),
    -Infinity,
  );

  assert.equal(getPromptPackBenchmarkDedupOrdinalForTest(makeBenchmarkRow({ original_rowid: 7, rowid: 1 })), 7);
  assert.equal(getPromptPackBenchmarkDedupOrdinalForTest(makeBenchmarkRow({ original_rowid: Infinity, rowid: 3 })), 3);
  assert.equal(getPromptPackBenchmarkDedupOrdinalForTest(makeBenchmarkRow({ original_rowid: null, rowid: null })), 0);
  assert.throws(
    () => __sqliteInternals.applySchemaMigrationForTest(9999, {} as unknown as DatabaseSync),
    /Unknown SQLite schema migration version/,
  );

  assert.ok(
    comparePromptPackBenchmarkDedupRowsForTest(
      makeBenchmarkRow({ item_id: "failed", run_status: "failed" }),
      makeBenchmarkRow({ item_id: "completed", run_status: "completed" }),
    ) < 0,
  );
  assert.ok(
    comparePromptPackBenchmarkDedupRowsForTest(
      makeBenchmarkRow({ item_id: "old", run_status: "completed", created_at: "2026-04-16T00:01:00.000Z" }),
      makeBenchmarkRow({ item_id: "new", run_status: "completed", created_at: "2026-04-16T00:02:00.000Z" }),
    ) < 0,
  );
  assert.ok(
    comparePromptPackBenchmarkDedupRowsForTest(
      makeBenchmarkRow({ item_id: "row-1", run_status: "completed", rowid: 1 }),
      makeBenchmarkRow({ item_id: "row-2", run_status: "completed", rowid: 2 }),
    ) < 0,
  );
});

test("P2-S4a chat_messages FTS migration creates the index, triggers, and backfills existing rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    // Build a database up to (but not including) the FTS migration, then seed rows
    // that pre-date the index — exactly the existing-DB upgrade path.
    __sqliteInternals.migrate(db);
    db.exec(`
      DROP TRIGGER IF EXISTS chat_messages_fts_ai;
      DROP TRIGGER IF EXISTS chat_messages_fts_ad;
      DROP TRIGGER IF EXISTS chat_messages_fts_au;
      DROP TABLE IF EXISTS chat_messages_fts;
      DELETE FROM schema_migrations WHERE version = 125;
    `);
    db.prepare(
      `INSERT INTO chat_messages (message_id, session_id, role, actor_type, actor_id, content, timestamp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "msg-pre-1",
      "sess-pre",
      "user",
      "user",
      "operator",
      "pre-existing backfilltoken history",
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
    );

    // Re-run the migrator: only migration 125 is outstanding.
    __sqliteInternals.migrate(db);

    const ftsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_messages_fts'")
      .get() as { name: string } | undefined;
    assert.equal(ftsTable?.name, "chat_messages_fts");

    const triggers = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'chat_messages'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    assert.ok(triggers.has("chat_messages_fts_ai"));
    assert.ok(triggers.has("chat_messages_fts_ad"));
    assert.ok(triggers.has("chat_messages_fts_au"));

    // Backfill indexed the pre-existing row.
    const matches = db
      .prepare(
        `SELECT m.message_id AS message_id
         FROM chat_messages_fts JOIN chat_messages AS m ON m.seq = chat_messages_fts.rowid
         WHERE chat_messages_fts MATCH ?`,
      )
      .all('"backfilltoken"') as Array<{ message_id: string }>;
    assert.deepEqual(
      matches.map((row) => row.message_id),
      ["msg-pre-1"],
    );

    // The migration is idempotent on re-run (IF NOT EXISTS + rebuild).
    assert.doesNotThrow(() => __sqliteInternals.applySchemaMigrationForTest(125, db));
  } finally {
    db.close();
  }
});

test("P2-S4a excludeFtsVirtualTables drops fts5 virtual + shadow tables but keeps ordinary tables", () => {
  const rows = [
    { name: "chat_messages", sql: "CREATE TABLE chat_messages (seq INTEGER)" },
    { name: "chat_messages_fts", sql: "CREATE VIRTUAL TABLE chat_messages_fts USING fts5(content)" },
    { name: "chat_messages_fts_data", sql: "CREATE TABLE 'chat_messages_fts_data'(id INTEGER)" },
    { name: "chat_messages_fts_idx", sql: "CREATE TABLE 'chat_messages_fts_idx'(segid)" },
    { name: "chat_messages_fts_content", sql: "CREATE TABLE 'chat_messages_fts_content'(id INTEGER)" },
    { name: "chat_messages_fts_config", sql: "CREATE TABLE 'chat_messages_fts_config'(k)" },
    { name: "chat_messages_fts_docsize", sql: "CREATE TABLE 'chat_messages_fts_docsize'(id INTEGER)" },
    // An ordinary table that merely ends in _config must be retained.
    { name: "a2a_task_push_configs", sql: "CREATE TABLE a2a_task_push_configs (id TEXT)" },
  ];
  const kept = __sqliteInternals.excludeFtsVirtualTables(rows).map((row) => row.name);
  assert.deepEqual(kept, ["chat_messages", "a2a_task_push_configs"]);

  // No-op when there are no virtual tables.
  const noVirtual = [{ name: "plain", sql: "CREATE TABLE plain (id TEXT)" }];
  assert.deepEqual(__sqliteInternals.excludeFtsVirtualTables(noVirtual), noVirtual);
});

test("cost_ledger carries a created_at index for time-range cost summaries on a fresh DB", () => {
  const db = new DatabaseSync(":memory:");
  try {
    __sqliteInternals.migrate(db);
    const indexes = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cost_ledger'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    assert.ok(
      indexes.has("idx_cost_ledger_created_at"),
      `expected idx_cost_ledger_created_at, found: ${[...indexes].join(", ")}`,
    );
  } finally {
    db.close();
  }
});

test("P2-S4a SQLite blueprint and Postgres mirror exclude the chat_messages FTS artifacts", () => {
  const blueprint = createSqliteSchemaBlueprint();
  const tableNames = blueprint.tables.map((table) => table.name);
  assert.ok(tableNames.includes("chat_messages"), "the real chat_messages table is still in the blueprint");
  for (const ftsName of [
    "chat_messages_fts",
    "chat_messages_fts_data",
    "chat_messages_fts_idx",
    "chat_messages_fts_content",
    "chat_messages_fts_config",
    "chat_messages_fts_docsize",
  ]) {
    assert.ok(!tableNames.includes(ftsName), `${ftsName} must be excluded from the blueprint`);
  }

  // The auto-derived Postgres schema must contain no FTS5 artifacts at all.
  const postgresSql = buildPostgresRuntimeSchemaSql();
  assert.match(postgresSql, /CREATE TABLE IF NOT EXISTS chat_messages \(/);
  assert.doesNotMatch(postgresSql, /chat_messages_fts/);
  assert.doesNotMatch(postgresSql, /VIRTUAL TABLE/i);
  assert.doesNotMatch(postgresSql, /fts5/i);
});
