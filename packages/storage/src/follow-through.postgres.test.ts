import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { createPostgresRemoteStorage } from "./postgres/remote-storage.js";
import { CronJobRepository } from "./cron-job-repo.js";
import { HookRunRepository } from "./hook-run-repo.js";
import { seedImprovementWatch, seedWatchSignal } from "./improvement-watch-evidence.test-support.js";
const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test(
  "PostgreSQL event pages, duplicate admission and watch recovery hold across two independent workers",
  { skip: !connectionString, timeout: 240_000 },
  async (t) => {
    const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "follow_through"),
      root = await mkdtemp(path.join(os.tmpdir(), "gc-follow-through-pg-")),
      scoped = new URL(connectionString!);
    scoped.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
    const workers = [0, 1].map((index) =>
      createPostgresRemoteStorage({
        connection: { connectionString: scoped.toString(), database: scoped.pathname.slice(1) },
        migrationsTable: "schema_migrations",
        transcriptsDir: path.join(root, `transcripts-${index}`),
        auditDir: path.join(root, `audit-${index}`),
        startupWaitTimeoutMs: 120_000,
      }),
    );
    t.after(async () => {
      await Promise.allSettled(workers.map((worker) => worker.close()));
      await scope.teardown();
      if (
        path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
        !path.basename(root).startsWith("gc-follow-through-pg-")
      )
        throw new Error("Unexpected PostgreSQL fixture cleanup target");
      await rm(root, { recursive: true, force: true });
    });
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));
    const [a, b] = workers;
    const at = "2026-11-19T10:00:00.000Z",
      job = new CronJobRepository(scope.db).upsert({
        jobId: "event-job",
        name: "Event fixture",
        action: "agent_turn",
        enabled: true,
        schedule: "* * * * * UTC",
        actionConfig: {
          agentTurn: {
            sessionId: "s",
            prompt: "Check only the reviewed result",
            eventWake: {
              version: 1,
              eventType: "subagent.end",
              hookId: "h",
              workspaceId: "default",
              sourceSessionId: "s",
              notBefore: at,
              timezone: "UTC",
            },
          },
        },
      });
    const hooks = new HookRunRepository(scope.db),
      event = hooks.create(
        {
          hookId: "h",
          workspaceId: "default",
          trigger: "subagent.end",
          entityType: "chat_subagent",
          entityId: "child",
          mode: "observe",
          status: "completed",
          idempotencyKey: "event",
          attemptCount: 1,
          completedAt: at,
          requestPayload: { parentSessionId: "s" },
        },
        at,
      );
    assert.deepEqual(
      (await a!.cronJobs.listEventJobs({ limit: 21 })).map((item) => item.jobId),
      [job.jobId],
    );
    assert.deepEqual(
      (
        await b!.hookRuns.listCompletedForFollowThrough({
          workspaceId: "default",
          hookId: "h",
          notBefore: at,
          limit: 1,
        })
      ).map((item) => item.runId),
      [event.runId],
    );
    assert.deepEqual(
      await a!.hookRuns.listCompletedForFollowThrough({
        workspaceId: "default",
        hookId: "h",
        notBefore: at,
        after: { completedAt: at, runId: event.runId },
        limit: 20,
      }),
      [],
    );
    const eventSource = {
        eventId: event.runId,
        eventType: "subagent.end" as const,
        workspaceId: "default",
        sourceConnectionId: "h",
        payloadHash: "a".repeat(64),
      },
      input = {
        jobId: job.jobId,
        admissionKey: `event:${event.runId}`,
        trigger: "manual" as const,
        scheduledFor: at,
        expectedJobRevision: job.revision,
        eventSource,
      };
    const admissions = await Promise.all(workers.map((worker) => worker.cronRuns.beginAdmission(input)));
    assert.deepEqual(admissions.map((result) => result.outcome).sort(), ["begun", "duplicate"]);
    assert.equal((await a!.cronRuns.listByJob(job.jobId)).length, 1);
    await assert.rejects(() =>
      b!.cronRuns.beginAdmission({ ...input, eventSource: { ...eventSource, payloadHash: "b".repeat(64) } }),
    );
    const reviewedJob = new CronJobRepository(scope.db).upsert({
      jobId: "operator-reviewed",
      name: "Reviewed check",
      action: "task",
      enabled: true,
      schedule: "* * * * * UTC",
    });
    const reviewed = {
      jobId: reviewedJob.jobId,
      admissionKey: "operator-review-one",
      trigger: "manual" as const,
      scheduledFor: at,
      expectedJobRevision: reviewedJob.revision,
      expectedExecutionGeneration: 0,
      operatorAction: { actorId: "operator", operationId: "operation-1234567890", expectedExecutionGeneration: 0 },
    };
    const reserved = await a!.cronRuns.beginAdmission(reviewed);
    assert.equal(reserved.outcome, "begun");
    if (reserved.outcome !== "begun") assert.fail();
    const token = {
      runId: reserved.run.runId,
      jobId: reviewedJob.jobId,
      executionGeneration: reserved.run.executionGeneration,
    };
    await a!.cronRuns.admitInlineExecution(token);
    await a!.cronRuns.markSucceeded(token, { output: "done" });
    assert.equal((await b!.cronRuns.beginAdmission(reviewed)).outcome, "duplicate");
    await assert.rejects(() =>
      b!.cronRuns.beginAdmission({
        ...reviewed,
        admissionKey: "operator-review-other",
        operatorAction: { ...reviewed.operatorAction, operationId: "operation-9876543210" },
      }),
    );
    assert.equal((await b!.cronRuns.listByJob(reviewedJob.jobId)).length, 1);
    seedImprovementWatch(scope.db);
    for (let i = 0; i < 5; i++) seedWatchSignal(scope.db, `positive-${i}`, "positive");
    assert.equal((await a!.improvementWatchEvidence.reconcile("watch")).status, "stable");
    seedWatchSignal(scope.db, "negative", "negative");
    const recoveries = await Promise.all(
      workers.map((worker) =>
        worker.runImmediateTransaction(async () => {
          const result = await worker.improvementWatchEvidence.reconcile("watch");
          if (!result.shouldRestore) return false;
          // A fixture callback stands in for the service's existing governed restore.
          // The assertion proves its outer transaction keeps the evidence owner lock;
          // actual snapshot/hash recovery is covered by the Gateway lifecycle lane.
          const current = await worker.db
            .prepare("SELECT status FROM improvement_activations WHERE activation_id='watch'")
            .get<{ status: string }>();
          if (current?.status !== "active") return false;
          await worker.db
            .prepare(
              "UPDATE improvement_activations SET status='paused' WHERE activation_id='watch' AND status='active'",
            )
            .run();
          return true;
        }),
      ),
    );
    assert.deepEqual(recoveries.sort(), [false, true]);
    assert.equal(
      (
        await a!.db
          .prepare("SELECT status FROM improvement_activations WHERE activation_id='watch'")
          .get<{ status: string }>()
      )?.status,
      "paused",
    );
  },
);
