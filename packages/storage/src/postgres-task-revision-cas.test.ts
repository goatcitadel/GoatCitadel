import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ConflictError } from "@goatcitadel/contracts";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { TaskRepository } from "./task-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test(
  "real Postgres fences stale task mutations across two clients",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_task_cas_${suffix}`;
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
        applicationName: `gc-task-cas-a-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      clientB = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: `gc-task-cas-b-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      clientA.prepare("SELECT 1 AS ready").get();
      clientB.prepare("SELECT 1 AS ready").get();

      const tasksA = new TaskRepository(clientA);
      const tasksB = new TaskRepository(clientB);
      const created = tasksA.create({ title: "Original" });
      const stale = tasksB.get(created.taskId);
      const winner = tasksA.updateWithRevision(created.taskId, { title: "Postgres winner" }, 1);
      assert.equal(winner.revision, 2);
      assert.equal(tasksB.updateWithRevision(created.taskId, { title: "Postgres winner" }, 2).revision, 2);
      assert.throws(
        () => tasksB.updateWithRevision(created.taskId, { title: "Stale" }, stale.revision),
        (error: unknown) =>
          error instanceof ConflictError && error.code === "WRITE_CONFLICT" && error.details?.currentRevision === 2,
      );
      assert.equal(tasksA.get(created.taskId).title, "Postgres winner");
    } finally {
      clientB?.close();
      clientA?.close();
      await migrationPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);
