import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ConflictError } from "@goatcitadel/contracts";
import { Pool } from "pg";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { ChatSessionPrefsRepository } from "./chat-session-prefs-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { SessionAutonomyPrefsRepository } from "./session-autonomy-prefs-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test(
  "real Postgres fences Chat session aggregate revisions across repositories",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_chat_session_cas_${suffix}`;
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
        applicationName: `gc-chat-session-cas-a-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      clientB = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: `gc-chat-session-cas-b-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      clientA.prepare("SELECT 1 AS ready").get();
      clientB.prepare("SELECT 1 AS ready").get();

      const sessionId = `pg-session-${suffix}`;
      const metaA = new ChatSessionMetaRepository(clientA);
      const metaB = new ChatSessionMetaRepository(clientB);
      const prefsA = new ChatSessionPrefsRepository(clientA);
      const prefsB = new ChatSessionPrefsRepository(clientB);
      const autonomyA = new SessionAutonomyPrefsRepository(clientA);
      const autonomyB = new SessionAutonomyPrefsRepository(clientB);

      new ChatSessionLifecycleRepository(clientA).initialize({
        workspaceId: "default",
        sessionId,
        actorId: "test-fixture",
        idempotencyKey: `test:lifecycle:init:${sessionId}`,
        correlationId: `test:correlation:lifecycle:init:${sessionId}`,
      });
      assert.equal(metaA.get(sessionId)?.revision, 1);
      assert.equal(metaB.get(sessionId)?.revision, 1);
      assert.equal(metaA.patchWithRevision(sessionId, { title: "Winner" }, 1).revision, 2);
      assert.throws(
        () => prefsB.patchWithRevision(sessionId, { planningMode: "advisory" }, 1),
        (error: unknown) => {
          assert.ok(error instanceof ConflictError);
          assert.equal(error.code, "WRITE_CONFLICT");
          assert.deepEqual(error.details, {
            resourceKind: "chat_session",
            resourceId: sessionId,
            expectedRevision: 1,
            currentRevision: 2,
          });
          return true;
        },
      );
      assert.equal(prefsA.get(sessionId), undefined);
      assert.equal(prefsA.patchWithRevision(sessionId, { planningMode: "advisory" }, 2).revision, 3);
      assert.equal(prefsB.get(sessionId)?.revision, 3);

      const goal = metaA.patchWithRevision(sessionId, { pinnedGoal: "Keep telemetry", goalTurnBudget: 4 }, 3);
      assert.equal(goal.revision, 4);
      assert.equal(metaB.incrementGoalTurnsUsed(sessionId), 1);
      const afterRuntime = metaA.patchWithRevision(sessionId, { pinned: true }, 4);
      assert.equal(afterRuntime.revision, 5);
      assert.equal(afterRuntime.goalTurnsUsed, 1);

      assert.equal(autonomyA.patchWithRevision(sessionId, { reflectionMode: "on" }, 5).revision, 6);
      assert.equal(autonomyB.touch(sessionId, "pg-runtime-touch").revision, 6);
      assert.equal(metaA.get(sessionId)?.revision, 6);
    } finally {
      clientB?.close();
      clientA?.close();
      await migrationPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);
