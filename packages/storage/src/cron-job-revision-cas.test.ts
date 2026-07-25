import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ConflictError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { CronJobRepository } from "./cron-job-repo.js";
import { CronRunRepository } from "./cron-run-repo.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      fs.rmSync(candidate, { force: true });
    }
  }
});

function assertWriteConflict(
  action: () => unknown,
  expected: { resourceId: string; expectedRevision: number; currentRevision: number },
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ConflictError);
    assert.equal(error.code, "WRITE_CONFLICT");
    assert.deepEqual(error.details, {
      resourceKind: "cron_job",
      resourceId: expected.resourceId,
      expectedRevision: expected.expectedRevision,
      currentRevision: expected.currentRevision,
    });
    return true;
  });
}

describe("Cron job spec revision CAS", () => {
  it("keeps stale scheduler telemetry merge-only while fencing operator spec writes", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-cron-cas-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    let clientA: DatabaseClient | undefined;
    let clientB: DatabaseClient | undefined;
    try {
      clientA = createDatabase({ dbPath });
      clientB = createDatabase({ dbPath });
      const cronA = new CronJobRepository(clientA);
      const cronB = new CronJobRepository(clientB);
      const jobId = `cron-${randomUUID()}`;

      const widerCreateInput = {
        jobId,
        name: "Original spec",
        action: "task" as const,
        description: "Original description",
        schedule: "0 8 * * * UTC",
        enabled: true,
        workdir: "F:/old",
        contextFrom: "upstream-old",
        lastRunId: "must-not-cross-the-spec-boundary",
        lastRunOutput: "must-not-cross-the-spec-boundary",
      };
      const created = cronA.createSpec(widerCreateInput, "2026-07-12T00:00:00.000Z");
      assert.equal(created.revision, 1);
      assert.equal(created.lastRunId, undefined);
      assert.equal(created.lastRunOutput, undefined);
      const operatorDraftRevision = cronB.get(jobId)?.revision;
      assert.equal(operatorDraftRevision, 1);

      const telemetryBeforeDraftCommit = cronA.mergeRuntimeTelemetry(
        jobId,
        {
          lastRunAt: "2026-07-12T00:01:00.000Z",
          lastRunId: "run-before-draft",
          lastRunStatus: "ok",
          failureCount: 0,
        },
        "2026-07-12T00:01:00.000Z",
      );
      assert.equal(telemetryBeforeDraftCommit.revision, 1, "telemetry must not make an operator draft stale");
      const draftCommit = cronB.updateSpecWithRevision(
        jobId,
        { description: "Draft committed after telemetry" },
        operatorDraftRevision as number,
        "2026-07-12T00:02:00.000Z",
      );
      assert.equal(draftCommit.revision, 2);
      assert.equal(draftCommit.lastRunId, "run-before-draft");

      const staleSchedulerSnapshot = cronA.get(jobId);
      assert.ok(staleSchedulerSnapshot);
      const operatorWinner = cronA.updateSpecWithRevision(
        jobId,
        {
          name: "Operator winner",
          schedule: "30 9 * * * UTC",
          enabled: false,
          workdir: "F:/new",
          contextFrom: "upstream-new",
        },
        staleSchedulerSnapshot.revision,
        "2026-07-12T00:03:00.000Z",
      );
      assert.equal(operatorWinner.revision, 3);

      const staleCompletion = cronB.mergeRuntimeTelemetry(
        staleSchedulerSnapshot.jobId,
        {
          lastRunAt: "2026-07-12T00:04:00.000Z",
          nextRunAt: "2026-07-13T08:00:00.000Z",
          lastRunOutput: "completed from stale scheduler snapshot",
          lastRunId: "run-stale-completion",
          lastRunStatus: "ok",
          lastFailureAt: null,
          lastFailure: null,
          failureCount: 0,
          backoffUntil: null,
        },
        "2026-07-12T00:04:00.000Z",
      );
      assert.equal(staleCompletion.revision, 3);
      assert.deepEqual(
        {
          name: staleCompletion.name,
          schedule: staleCompletion.schedule,
          enabled: staleCompletion.enabled,
          workdir: staleCompletion.workdir,
          contextFrom: staleCompletion.contextFrom,
        },
        {
          name: "Operator winner",
          schedule: "30 9 * * * UTC",
          enabled: false,
          workdir: "F:/new",
          contextFrom: "upstream-new",
        },
      );
      assert.equal(staleCompletion.lastRunId, "run-stale-completion");

      assert.equal(
        cronA.updateSpecWithRevision(jobId, { name: "Operator winner", schedule: "30 9 * * * UTC" }, 3).revision,
        3,
        "semantic no-op must validate without bumping",
      );
      assertWriteConflict(() => cronB.updateSpecWithRevision(jobId, { name: "Stale overwrite" }, 2), {
        resourceId: jobId,
        expectedRevision: 2,
        currentRevision: 3,
      });
      assertWriteConflict(() => cronB.deleteWithRevision(jobId, 2), {
        resourceId: jobId,
        expectedRevision: 2,
        currentRevision: 3,
      });
      assert.equal(cronA.get(jobId)?.name, "Operator winner");

      const reconciledNoop = cronB.reconcileSpec({
        ...staleCompletion,
        lastRunId: "stale-config-runtime",
        lastRunOutput: "must not replace live telemetry",
      });
      assert.equal(reconciledNoop.revision, 3);
      assert.equal(reconciledNoop.lastRunId, "run-stale-completion");
      const reconciledChange = cronA.reconcileSpec({ ...reconciledNoop, description: "Built-in spec repaired" });
      assert.equal(reconciledChange.revision, 4);
      assert.equal(reconciledChange.lastRunId, "run-stale-completion");

      assert.equal(cronB.deleteWithRevision(jobId, 4), true);
      assert.equal(cronA.get(jobId), undefined);
    } finally {
      clientB?.close();
      clientA?.close();
    }
  });

  it("rejects late telemetry from a superseded execution generation", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-cron-generation-cas-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const client = createDatabase({ dbPath });
    try {
      const cronJobs = new CronJobRepository(client);
      const cronRuns = new CronRunRepository(client);
      const jobId = `cron-${randomUUID()}`;
      cronJobs.createSpec({
        jobId,
        name: "Generation-fenced telemetry",
        action: "agent_turn",
        actionConfig: { agentTurn: { prompt: "Inspect runtime state" } },
        schedule: "0 8 * * * UTC",
        enabled: true,
      });

      const first = cronRuns.beginAdmission({
        runId: "run-generation-1",
        jobId,
        admissionKey: "scheduled:2026-07-12T08:00:00.000Z",
        scheduledFor: "2026-07-12T08:00:00.000Z",
        trigger: "scheduled_due",
      });
      assert.equal(first.outcome, "begun");
      if (first.outcome !== "begun") {
        return;
      }
      const firstToken = {
        runId: first.run.runId,
        jobId,
        executionGeneration: first.run.executionGeneration,
      };
      assert.ok(cronRuns.terminalize(firstToken, { status: "completed" }));

      const second = cronRuns.beginAdmission({
        runId: "run-generation-2",
        jobId,
        admissionKey: "scheduled:2026-07-13T08:00:00.000Z",
        scheduledFor: "2026-07-13T08:00:00.000Z",
        trigger: "scheduled_due",
      });
      assert.equal(second.outcome, "begun");
      if (second.outcome !== "begun") {
        return;
      }
      assert.ok(
        cronJobs.mergeRuntimeTelemetryForExecutionGeneration(
          jobId,
          second.run.executionGeneration,
          {
            lastRunId: second.run.runId,
            lastRunStatus: null,
            lastRunOutput: JSON.stringify({ status: "admitting" }),
          },
          "2026-07-13T08:00:01.000Z",
        ),
      );

      const staleWrite = cronJobs.mergeRuntimeTelemetryForExecutionGeneration(
        jobId,
        first.run.executionGeneration,
        {
          lastRunAt: "2026-07-13T08:00:02.000Z",
          lastRunId: first.run.runId,
          lastRunStatus: "ok",
          lastRunOutput: JSON.stringify({ status: "completed" }),
        },
        "2026-07-13T08:00:02.000Z",
      );
      assert.equal(staleWrite, undefined);
      assert.deepEqual(
        {
          executionGeneration: cronJobs.get(jobId)?.executionGeneration,
          activeRunId: cronJobs.get(jobId)?.activeRunId,
          lastRunId: cronJobs.get(jobId)?.lastRunId,
          lastRunStatus: cronJobs.get(jobId)?.lastRunStatus,
          lastRunOutput: cronJobs.get(jobId)?.lastRunOutput,
        },
        {
          executionGeneration: second.run.executionGeneration,
          activeRunId: second.run.runId,
          lastRunId: second.run.runId,
          lastRunStatus: undefined,
          lastRunOutput: JSON.stringify({ status: "admitting" }),
        },
      );
    } finally {
      client.close();
    }
  });
});
