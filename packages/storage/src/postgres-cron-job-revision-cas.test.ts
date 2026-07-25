import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ConflictError } from "@goatcitadel/contracts";
import { Pool } from "pg";
import { CronJobRepository } from "./cron-job-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test(
  "real Postgres keeps cron telemetry merge-only across a stale scheduler race",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_cron_cas_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const migrationPool = new Pool({ connectionString: scopedUrl.toString() });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: migrationPool },
    );
    let clientA: PostgresSyncDatabaseClient | undefined;
    let clientB: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      clientA = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: `gc-cron-cas-a-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      clientB = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: `gc-cron-cas-b-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      clientA.prepare("SELECT 1 AS ready").get();
      clientB.prepare("SELECT 1 AS ready").get();

      const cronA = new CronJobRepository(clientA);
      const cronB = new CronJobRepository(clientB);
      const jobId = `pg-cron-${suffix}`;
      assert.equal(
        cronA.createSpec({
          jobId,
          name: "Original",
          action: "task",
          schedule: "0 8 * * * UTC",
          enabled: true,
        }).revision,
        1,
      );
      const staleScheduler = cronB.get(jobId);
      assert.ok(staleScheduler);
      assert.equal(
        cronA.updateSpecWithRevision(jobId, { name: "Operator", schedule: "30 9 * * * UTC" }, 1).revision,
        2,
      );
      const completed = cronB.mergeRuntimeTelemetry(jobId, {
        lastRunAt: "2026-07-12T00:00:00.000Z",
        lastRunId: "pg-stale-run",
        lastRunStatus: "ok",
      });
      assert.equal(completed.revision, 2);
      assert.equal(completed.name, "Operator");
      assert.equal(completed.schedule, "30 9 * * * UTC");
      assert.equal(completed.lastRunId, "pg-stale-run");
      assert.throws(
        () => cronB.updateSpecWithRevision(jobId, { name: "Stale" }, staleScheduler.revision),
        (error: unknown) => error instanceof ConflictError && error.code === "WRITE_CONFLICT",
      );
    } finally {
      clientB?.close();
      clientA?.close();
      await migrationPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);
