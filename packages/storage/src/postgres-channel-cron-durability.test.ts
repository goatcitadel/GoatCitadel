import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Worker } from "node:worker_threads";
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
    const failures: unknown[] = [];
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
      const otherCronRuns = new CronRunRepository(workerB);
      jobs.upsert({
        jobId: `job-${suffix}`,
        name: "Postgres durability proof",
        action: "agent_turn",
        actionConfig: { agentTurn: { prompt: "hello" } },
        schedule: "0 * * * *",
        enabled: true,
      });
      const occurrence = {
        jobId: `job-${suffix}`,
        admissionKey: `slot-${suffix}`,
        scheduledFor: "2026-07-13T10:00:00.000Z",
      };
      const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const admissions = await Promise.allSettled(
        ["a", "b"].map((contender) =>
          beginInWorker(scopedUrl.toString(), { ...occurrence, runId: `run-${contender}-${suffix}` }, gate),
        ),
      );
      const results = admissions.map((admission) => {
        if (admission.status === "rejected") throw admission.reason;
        return admission.value;
      });
      assert.deepEqual(results.map(({ outcome }) => outcome).sort(), ["begun", "duplicate"]);
      const begun = results.find((result) => result.outcome === "begun");
      assert.ok(begun && begun.outcome === "begun");
      assert.ok(results.every((result) => result.outcome !== "blocked" && result.run.runId === begun.run.runId));
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
      assert.equal(
        otherCronRuns.attachDeterministicChild(token, {
          childTurnId: `turn-${suffix}`,
          childDurableRunId: `durable-${suffix}`,
          childMessageId: `message-${suffix}`,
        })?.childMessageId,
        `message-${suffix}`,
      );
      assert.equal(cronRuns.terminalize(token, { status: "completed" })?.status, "completed");
      const next = otherCronRuns.begin({
        ...occurrence,
        admissionKey: `next-slot-${suffix}`,
        scheduledFor: "2026-07-13T11:00:00.000Z",
      });
      assert.ok(next.outcome === "begun");
      assert.equal(next.run.executionGeneration, token.executionGeneration + 1);
      assert.equal(cronRuns.advance(token, "running"), undefined);
      assert.equal(cronRuns.terminalize(token, { status: "completed" })?.runId, token.runId);
      assert.equal(jobs.get(occurrence.jobId)?.activeRunId, next.run.runId);

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
    } catch (error) {
      failures.push(error);
    } finally {
      for (const cleanup of [
        () => workerA?.close(),
        () => workerB?.close(),
        () => scopedPool.end(),
        () => adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`),
        () => adminPool.end(),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "PostgreSQL test and cleanup failures");
  },
);

function beginInWorker(
  connectionString: string,
  input: Parameters<CronRunRepository["begin"]>[0],
  gate: SharedArrayBuffer,
): Promise<ReturnType<CronRunRepository["begin"]>> {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    void (async () => {
      const { tsImport } = await import(workerData.tsxApi);
      const { CronRunRepository } = await tsImport(workerData.cron, workerData.cron);
      const { PostgresSyncDatabaseClient } = await tsImport(workerData.postgres, workerData.postgres);
      const db = new PostgresSyncDatabaseClient({ connectionString: workerData.connectionString, database: "goatcitadel_test" });
      try {
        const gate = new Int32Array(workerData.gate);
        if (Atomics.add(gate, 0, 1) === 0) {
          if (Atomics.wait(gate, 0, 1, 15000) === "timed-out") throw new Error("Cron admission peer did not reach the gate");
        } else {
          Atomics.notify(gate, 0);
        }
        parentPort.postMessage(new CronRunRepository(db).begin(workerData.input));
      } finally {
        db.close();
      }
    })().catch((error) => { throw error; });
    `,
    {
      eval: true,
      workerData: {
        connectionString,
        input,
        gate,
        tsxApi: import.meta.resolve("tsx/esm/api"),
        cron: new URL(`./cron-run-repo${extension}`, import.meta.url).href,
        postgres: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      },
    },
  );
  return new Promise((resolve, reject) => {
    let result: ReturnType<CronRunRepository["begin"]> | undefined;
    let failure: Error | undefined;
    worker.once("message", (value) => {
      result = value;
    });
    worker.once("error", (error) => {
      failure = error;
    });
    worker.once("exit", (code) => {
      if (code === 0 && result) resolve(result);
      else reject(failure ?? new Error(`Cron admission worker exited with status ${code}`));
    });
  });
}
