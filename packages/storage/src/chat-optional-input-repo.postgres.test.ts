import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { readDurableChatOptionalInputMailbox } from "./session-mutation-admission-repo.js";
import { createOptionalInputFixture } from "./chat-optional-input-test-fixture.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
(connectionString ? it : it.skip)(
  "PostgreSQL optional input retains lease and exact replay with CAS",
  { timeout: 120_000 },
  async () => {
    assert.ok(connectionString);
    const schemaName = `optional_input_${randomUUID().replaceAll("-", "")}`;
    const adminPool = new Pool({ connectionString, max: 1 });
    const url = new URL(connectionString);
    url.searchParams.set("options", `-csearch_path=${schemaName}`);
    const database = decodeURIComponent(url.pathname.replace(/^\//u, "")) || "postgres";
    const migrationPool = new Pool({ connectionString: url.toString(), max: 2 });
    const migrations = new PostgresDatabaseClient(
      { connectionString: url.toString(), database },
      { pool: migrationPool },
    );
    let db: PostgresSyncDatabaseClient | undefined;
    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
      db = new PostgresSyncDatabaseClient({
        connectionString: url.toString(),
        database,
        applicationName: "optional-input-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      db.exec(`SET search_path TO ${schemaName}`);
      const fixture = createOptionalInputFixture(db);
      db.prepare(
        `UPDATE durable_runs SET status = 'running', lease_owner_id = 'optional-worker', lease_expires_at = @expiresAt WHERE run_id = @runId`,
      ).run({ runId: fixture.runId, expiresAt: new Date(Date.now() + 300_000).toISOString() });
      db.prepare(
        `UPDATE chat_turn_traces SET status = 'waiting_for_tool', pending_user_input_json = NULL, durable_json = 'null' WHERE turn_id = @turnId`,
      ).run({ turnId: fixture.turnId });
      const prompt = {
        promptId: fixture.resolution.promptId,
        turnId: fixture.turnId,
        kind: "text" as const,
        title: "Style",
        question: "Which style?",
        required: false,
        delivery: "background" as const,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      fixture.repo.registerDurableChatOptionalInput({
        admissionIdentity: fixture.resolution.admissionIdentity,
        durableRunId: fixture.runId,
        expectedRunVersion: 2,
        prompt,
      });
      const trace = db
        .prepare("SELECT durable_json FROM chat_turn_traces WHERE turn_id = @turnId")
        .get<{ durable_json: string }>({ turnId: fixture.turnId })!;
      assert.deepEqual(JSON.parse(trace.durable_json), { runId: fixture.runId, status: "running" });
      assert.throws(() => fixture.repo.answerDurableChatOptionalInput(fixture.resolution));
      const answer = { ...fixture.resolution, expectedWaitingRunVersion: 3 };
      const result = fixture.repo.answerDurableChatOptionalInput(answer);
      assert.equal(result.run.status, "running");
      assert.equal(fixture.repo.answerDurableChatOptionalInput(answer).disposition, "replayed");
      const run = new DurableRunRepository(db).getRun(fixture.runId)!;
      assert.equal(run.leaseOwnerId, "optional-worker");
      assert.equal(run.version, 4);
      assert.equal(readDurableChatOptionalInputMailbox(run.payload, run.runId).replies.length, 1);
      assert.throws(() =>
        fixture.repo.answerDurableChatOptionalInput({
          ...answer,
          responder: { actorId: "foreign", authActorSource: "token" },
        }),
      );
    } finally {
      db?.close();
      await migrations.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);
