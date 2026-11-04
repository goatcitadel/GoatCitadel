import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import type { ModelComparisonRun } from "@goatcitadel/contracts";
import { ModelComparisonRunRepository } from "./model-comparison-run-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createPostgresRemoteStorage } from "./postgres/remote-storage.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const skip = connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.";
const firstTime = "2026-11-02T00:00:00.000Z";
const nextTime = "2026-11-02T00:06:00.000Z";

function sampleRun(): ModelComparisonRun {
  return {
    comparisonId: "comparison", packId: "pack", status: "queued", title: "Claim fence",
    candidates: [], testIds: ["test"], judgments: [], createdAt: firstTime, updatedAt: firstTime,
    results: ["one", "two"].map((id) => ({ resultId: id, candidateId: id, testId: "test" })),
  };
}

for (const lineage of ["fresh", "upgraded"] as const) {
  test(`real PostgreSQL ${lineage} comparison claims converge and fence independent workers`, { skip, timeout: 240_000 }, async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
    const schema = `comparison_claim_${suffix}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "goat-comparison-claim-pg-"));
    const admin = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 });
    const scoped = new URL(connectionString);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    const migrations = new PostgresDatabaseClient({ connectionString: scoped.toString(), database: scoped.pathname.slice(1) });
    const workers: ReturnType<typeof createPostgresRemoteStorage>[] = [];
    const workerBName = `comparison-${suffix}-b`;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      let legacyRows: unknown[] | undefined;
      if (lineage === "upgraded") {
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 225));
        // v2 renders today's SQLite blueprint. Remove the new additive table
        // to reproduce a real v225 installation before this migration existed.
        await admin.query(`DROP TABLE IF EXISTS ${schema}.model_comparison_execution_claims`);
        await admin.query(`CREATE TABLE ${schema}.model_comparison_runs (
          comparison_id TEXT PRIMARY KEY, pack_id TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
          candidates_json TEXT NOT NULL, test_ids_json TEXT NOT NULL, results_json TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, error TEXT
        )`);
        await admin.query(`INSERT INTO ${schema}.model_comparison_runs VALUES
          ('legacy', 'retained-pack', 'running', 'Retained comparison', '[]', '[]', '[{"responseText":"retained"}]', $1, $1, NULL, NULL)`, [firstTime]);
        legacyRows = (await admin.query(`SELECT * FROM ${schema}.model_comparison_runs ORDER BY comparison_id`)).rows;
      }
      await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
      assert.equal((await admin.query(`SELECT name FROM ${schema}.schema_migrations WHERE version = 226`)).rows[0]?.name, "model_comparison_execution_claims");
      const columns = await admin.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'model_comparison_execution_claims' ORDER BY ordinal_position`, [schema]);
      assert.deepEqual(columns.rows, [
        { column_name: "comparison_id", data_type: "text", is_nullable: "NO" },
        { column_name: "claim_id", data_type: "text", is_nullable: "YES" },
      ]);
      const constraints = await admin.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = $1::regclass ORDER BY conname`, [`${schema}.model_comparison_execution_claims`]);
      assert.deepEqual(constraints.rows, [{ definition: "PRIMARY KEY (comparison_id)" }]);
      if (legacyRows) assert.deepEqual((await admin.query(`SELECT * FROM ${schema}.model_comparison_runs ORDER BY comparison_id`)).rows, legacyRows);
      // The forward migration is idempotent under normal startup/restart.
      assert.deepEqual((await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS)).appliedVersions, []);

      for (const applicationName of [`comparison-${suffix}-a`, workerBName]) {
        const worker = createPostgresRemoteStorage({
          connection: { connectionString: scoped.toString(), database: scoped.pathname.slice(1), applicationName, pool: { max: 2 } },
          migrationsTable: "schema_migrations", transcriptsDir: path.join(root, applicationName), auditDir: path.join(root, applicationName),
          startupWaitTimeoutMs: 120_000,
        });
        workers.push(worker);
        await worker.waitUntilReady();
      }
      const [a, b] = workers;
      const repoA = new ModelComparisonRunRepository(a!.gatewaySql);
      const repoB = new ModelComparisonRunRepository(b!.gatewaySql);
      await repoA.create(sampleRun());
      assert.ok(await repoA.claimRun("comparison", { expectedStatus: "queued", expectedUpdatedAt: firstTime, updatedAt: firstTime, claimId: "owner-a" }));

      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const takeover = a!.gatewaySql.runImmediateTransaction(async () => {
        assert.ok(await repoA.claimRun("comparison", { expectedStatus: "running", expectedUpdatedAt: firstTime, updatedAt: nextTime, claimId: "owner-b" }));
        entered();
        await gate;
      });
      await ready;
      const staleRenewal = repoB.renewRunLease("comparison", nextTime, "owner-a");
      try {
        const deadline = Date.now() + 10_000;
        while (true) {
          const waiting = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [workerBName]);
          if (waiting.rowCount) break;
          assert.ok(Date.now() < deadline, "stale renewal must wait on the actual claim row lock");
          await delay(20);
        }
      } finally {
        release();
        await takeover;
      }
      assert.equal(await staleRenewal, false, "the token CAS must recheck ownership after waiting");
      const before = await repoB.get("comparison");
      assert.equal(await repoB.upsertResult("comparison", { ...before.results[0]!, responseText: "stale" }, nextTime, "owner-a"), undefined);
      assert.equal(await repoB.finishRun("comparison", { status: "completed", updatedAt: nextTime, completedAt: nextTime, error: null }, { kind: "execution", claimId: "owner-a" }), undefined);
      assert.deepEqual(await repoA.get("comparison"), before);
      await Promise.all(before.results.map((result, index) => (index ? repoB : repoA)
        .upsertResult("comparison", { ...result, responseText: result.resultId }, nextTime, "owner-b")));
      assert.deepEqual((await repoA.get("comparison")).results.map((result) => result.responseText), ["one", "two"]);
      assert.equal((await repoA.finishRun("comparison", { status: "cancelled", updatedAt: nextTime, completedAt: nextTime, error: null }, { kind: "operator_cancel" }))?.status, "cancelled");
      assert.equal(await repoB.renewRunLease("comparison", nextTime, "owner-b"), false);
      assert.ok(await repoB.claimRun("comparison", { expectedStatus: "cancelled", expectedUpdatedAt: nextTime, updatedAt: nextTime, claimId: "owner-c" }));
      assert.equal(await repoA.renewRunLease("comparison", nextTime, "owner-b"), false);
      assert.equal((await repoB.finishRun("comparison", { status: "completed", updatedAt: nextTime, completedAt: nextTime, error: null }, { kind: "execution", claimId: "owner-c" }))?.status, "completed");
      assert.deepEqual((await admin.query(`SELECT * FROM ${schema}.model_comparison_execution_claims WHERE comparison_id = 'comparison'`)).rows, [{ comparison_id: "comparison", claim_id: null }]);
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
      await migrations.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  });
}
