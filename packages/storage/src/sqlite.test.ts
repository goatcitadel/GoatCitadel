import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createDatabase } from "./sqlite.js";

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
    seed.prepare(
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
    ).run(
      "bench-1",
      "pack-1",
      "queued",
      "[]",
      "[]",
      2,
      0,
      null,
      null,
      null,
      null,
      "2026-04-16T00:00:00.000Z",
      null,
    );
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
    seed.prepare(
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
    ).run(
      "bench-1",
      "pack-1",
      "queued",
      "[]",
      "[]",
      1,
      0,
      null,
      null,
      null,
      null,
      "2026-04-16T00:00:00.000Z",
      null,
    );
    seed.prepare(
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
    ).run(
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
    seed.prepare(
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
    ).run(
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
