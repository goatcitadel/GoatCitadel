import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { CronJobRepository } from "./cron-job-repo.js";
import { CronRunRepository } from "./cron-run-repo.js";
import { InboundChannelEventRepository } from "./inbound-channel-event-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test(
  "real Postgres preserves inbound claim and cron generation fencing",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `channel_cron_durability_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString() });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let workerA: PostgresSyncDatabaseClient | undefined;
    let workerB: PostgresSyncDatabaseClient | undefined;
    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      workerA = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: `gc-channel-cron-a-${suffix}`,
      });
      workerB = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: `gc-channel-cron-b-${suffix}`,
      });

      const inboundA = new InboundChannelEventRepository(workerA);
      const inboundB = new InboundChannelEventRepository(workerB);
      inboundA.accept({
        eventId: `event-${suffix}`,
        channelKey: "telegram",
        connectionId: `connection-${suffix}`,
        transport: "telegram_webhook",
        dispatchKind: "agent_turn",
        idempotencyKey: `update-${suffix}`,
        laneKey: `chat-${suffix}`,
        payload: { text: "hello" },
      });
      const [claimA] = inboundA.claimDue({
        ownerId: "worker-a",
        leaseDurationMs: 1_000,
        now: "2026-07-13T10:00:00.000Z",
      });
      assert.ok(claimA);
      assert.deepEqual(
        inboundB.claimDue({ ownerId: "worker-b", leaseDurationMs: 1_000, now: "2026-07-13T10:00:00.500Z" }),
        [],
      );
      const [claimB] = inboundB.claimDue({
        ownerId: "worker-b",
        leaseDurationMs: 1_000,
        now: "2026-07-13T10:00:02.000Z",
      });
      assert.equal(claimB?.generation, 2);
      assert.equal(inboundA.transitionClaimed(claimA, { status: "completed" }, "2026-07-13T10:00:02.100Z"), undefined);
      assert.equal(
        inboundB.transitionClaimed(claimB!, { status: "completed" }, "2026-07-13T10:00:02.100Z")?.status,
        "completed",
      );

      const jobs = new CronJobRepository(workerA);
      const cronRuns = new CronRunRepository(workerA);
      jobs.upsert({
        jobId: `job-${suffix}`,
        name: "Postgres durability proof",
        action: "agent_turn",
        actionConfig: { agentTurn: { prompt: "hello" } },
        schedule: "0 * * * *",
        enabled: true,
      });
      const begun = cronRuns.begin({
        runId: `run-${suffix}`,
        jobId: `job-${suffix}`,
        admissionKey: `slot-${suffix}`,
        scheduledFor: "2026-07-13T10:00:00.000Z",
      });
      assert.equal(begun.outcome, "begun");
      if (begun.outcome !== "begun") assert.fail("expected begun Postgres cron run");
      const token = {
        runId: begun.run.runId,
        jobId: begun.run.jobId,
        executionGeneration: begun.run.executionGeneration,
      };
      assert.equal(
        cronRuns.attachDeterministicChild(token, {
          childTurnId: `turn-${suffix}`,
          childDurableRunId: `durable-${suffix}`,
        })?.status,
        "admitted",
      );
      assert.equal(cronRuns.terminalize(token, { status: "completed" })?.status, "completed");

      jobs.upsert({
        jobId: `inline-${suffix}`,
        name: "Postgres inline admission proof",
        action: "task",
        schedule: "30 * * * *",
        enabled: true,
      });
      const inline = cronRuns.begin({
        runId: `inline-run-${suffix}`,
        jobId: `inline-${suffix}`,
        admissionKey: `inline-slot-${suffix}`,
        scheduledFor: "2026-07-13T10:30:00.000Z",
      });
      assert.equal(inline.outcome, "begun");
      if (inline.outcome !== "begun") assert.fail("expected begun inline Postgres cron run");
      const inlineToken = {
        runId: inline.run.runId,
        jobId: inline.run.jobId,
        executionGeneration: inline.run.executionGeneration,
      };
      assert.equal(cronRuns.admitInlineExecution(inlineToken)?.status, "running");
      assert.equal(cronRuns.terminalize(inlineToken, { status: "completed" })?.status, "completed");
    } finally {
      workerA?.close();
      workerB?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);
