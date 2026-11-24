import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictError } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import { CronJobRepository } from "./cron-job-repo.js";
import { CronRunRepository } from "./cron-run-repo.js";

function createRepos() {
  const db = createDatabase({ dbPath: ":memory:" });
  const jobs = new CronJobRepository(db);
  const runs = new CronRunRepository(db);
  jobs.upsert({
    jobId: "job-1",
    name: "Agent turn",
    action: "task",
    schedule: "0 * * * *",
    enabled: true,
  });
  return { db, jobs, runs };
}

describe("CronRunRepository", () => {
  it("rejects a second reviewed execution after a fast first completion while exact retries stay read-only", () => {
    const { db, runs, jobs } = createRepos();
    try {
      const job = jobs.get("job-1")!;
      const input = {
        jobId: job.jobId,
        admissionKey: "operator-first",
        scheduledFor: "2026-11-19T12:00:00.000Z",
        trigger: "manual" as const,
        expectedJobRevision: job.revision,
        expectedExecutionGeneration: 0,
      };
      const first = runs.beginAdmission(input as never);
      assert.equal(first.outcome, "begun");
      if (first.outcome !== "begun") assert.fail();
      const token = { runId: first.run.runId, jobId: job.jobId, executionGeneration: first.run.executionGeneration };
      runs.admitInlineExecution(token);
      runs.markSucceeded(token, { output: "done" });
      assert.equal(runs.beginAdmission(input as never).outcome, "duplicate");
      assert.throws(() => runs.beginAdmission({ ...input, admissionKey: "operator-second" } as never), ConflictError);
      const operatorAction = {
        actorId: "operator",
        operationId: "operator-stale-review",
        expectedExecutionGeneration: 0,
      };
      assert.throws(() => runs.beginAdmission({ ...input, admissionKey: "stale-generation", operatorAction }), {
        code: "FOLLOW_THROUGH_RUN_NOT_ADMITTED",
      });
      assert.throws(
        () =>
          runs.beginAdmission({
            ...input,
            admissionKey: "stale-revision",
            expectedJobRevision: job.revision + 1,
            expectedExecutionGeneration: 1,
            operatorAction: { ...operatorAction, expectedExecutionGeneration: 1 },
          }),
        { code: "FOLLOW_THROUGH_RUN_NOT_ADMITTED" },
      );
      assert.equal(runs.listByJob(job.jobId).length, 1);
      assert.equal(
        runs.beginAdmission({ ...input, admissionKey: "operator-new-review", expectedExecutionGeneration: 1 } as never)
          .outcome,
        "begun",
      );
    } finally {
      db.close();
    }
  });
  it("freezes one exact event reference and refuses changed bytes or revision for the same event identity", () => {
    const { db, jobs, runs } = createRepos();
    try {
      const eventSource = {
        eventId: "event",
        eventType: "subagent.end" as const,
        workspaceId: "default",
        sourceConnectionId: "hook",
        payloadHash: "a".repeat(64),
      };
      const job = jobs.upsert({
        jobId: "job-1",
        name: "Event review",
        action: "agent_turn",
        schedule: "* * * * * UTC",
        enabled: true,
        actionConfig: {
          agentTurn: {
            prompt: "Check the approved result",
            sessionId: "s",
            eventWake: {
              version: 1,
              eventType: "subagent.end",
              hookId: "hook",
              workspaceId: "default",
              sourceSessionId: "s",
              notBefore: "2026-11-19T00:00:00.000Z",
              timezone: "UTC",
            },
          },
        },
      });
      const input = {
        jobId: job.jobId,
        admissionKey: "event:event",
        trigger: "manual" as const,
        scheduledFor: "2026-11-19T10:00:00.000Z",
        expectedJobRevision: job.revision,
        eventSource,
      };
      const first = runs.beginAdmission(input);
      assert.deepEqual(first.outcome === "begun" && first.run.actionSnapshot.eventSource, eventSource);
      assert.equal(runs.beginAdmission(input).outcome, "duplicate");
      assert.throws(
        () => runs.beginAdmission({ ...input, eventSource: { ...eventSource, payloadHash: "b".repeat(64) } }),
        ConflictError,
      );
      assert.throws(() => runs.beginAdmission({ ...input, expectedJobRevision: job.revision + 1 }), ConflictError);
      assert.equal(runs.listByJob(job.jobId).length, 1);
    } finally {
      db.close();
    }
  });
  it("rejects an outdated reviewed job revision before reserving an occurrence", () => {
    const { db, runs } = createRepos();
    try {
      assert.throws(
        () =>
          runs.beginAdmission({
            jobId: "job-1",
            admissionKey: "reviewed",
            scheduledFor: new Date().toISOString(),
            expectedJobRevision: 999,
          }),
        ConflictError,
      );
      assert.equal(runs.listByJob("job-1").length, 0);
    } finally {
      db.close();
    }
  });
  it("deduplicates admission, blocks overlap, and increments the job execution generation", () => {
    const { db, runs } = createRepos();
    try {
      const first = runs.begin(
        { runId: "run-1", jobId: "job-1", admissionKey: "2026-07-13T10", scheduledFor: "2026-07-13T10:00:00Z" },
        "2026-07-13T10:00:00Z",
      );
      assert.equal(first.outcome, "begun");
      if (first.outcome !== "begun") assert.fail("expected begun run");
      assert.equal(first.run.executionGeneration, 1);

      const duplicate = runs.begin({
        jobId: "job-1",
        admissionKey: "2026-07-13T10",
        scheduledFor: "2026-07-13T10:00:00.000Z",
      });
      assert.equal(duplicate.outcome, "duplicate");
      if (duplicate.outcome !== "duplicate") assert.fail("expected duplicate run");
      assert.equal(duplicate.run.runId, "run-1");

      assert.throws(
        () =>
          runs.begin({
            jobId: "job-1",
            admissionKey: "2026-07-13T10",
            scheduledFor: "2026-07-13T10:01:00.000Z",
          }),
        ConflictError,
      );
      const blocked = runs.begin({
        runId: "run-2",
        jobId: "job-1",
        admissionKey: "2026-07-13T11",
        scheduledFor: "2026-07-13T11:00:00.000Z",
      });
      assert.equal(blocked.outcome, "blocked");
      if (blocked.outcome !== "blocked") assert.fail("expected blocked run");
      assert.equal(blocked.activeRun.runId, "run-1");
    } finally {
      db.close();
    }
  });

  it("attaches deterministic child linkage and fences stale generations after terminal settlement", () => {
    const { db, runs } = createRepos();
    try {
      const begun = runs.begin({
        runId: "run-1",
        jobId: "job-1",
        admissionKey: "slot-1",
        scheduledFor: "2026-07-13T10:00:00.000Z",
      });
      if (begun.outcome !== "begun") assert.fail("expected begun run");
      const token = {
        runId: begun.run.runId,
        jobId: begun.run.jobId,
        executionGeneration: begun.run.executionGeneration,
      };
      const attached = runs.attachChild(token, {
        childSessionId: "session-1",
        childTurnId: "turn-1",
        childDurableRunId: "durable-1",
      });
      assert.equal(attached?.status, "admitted");
      assert.equal(attached?.phase, "chat_execution");
      assert.equal(attached?.childTurnId, "turn-1");
      assert.deepEqual(
        runs.attachChild(token, {
          childSessionId: "session-1",
          childTurnId: "turn-1",
          childDurableRunId: "durable-1",
        }),
        attached,
      );
      assert.throws(
        () => runs.attachChild(token, { childTurnId: "turn-2", childDurableRunId: "durable-1" }),
        ConflictError,
      );
      assert.equal(runs.advance(token, "running")?.status, "running");
      assert.equal(runs.markSucceeded(token, { output: "done" })?.status, "completed");

      const second = runs.begin({
        runId: "run-2",
        jobId: "job-1",
        admissionKey: "slot-2",
        scheduledFor: "2026-07-13T11:00:00.000Z",
      });
      if (second.outcome !== "begun") assert.fail("expected second begun run");
      assert.equal(second.run.executionGeneration, 2);
      assert.deepEqual(runs.getByGeneration("job-1", 1), runs.get("run-1"));
      assert.deepEqual(runs.getByGeneration("job-1", 2), second.run);
      assert.equal(runs.getByGeneration("job-1", 3), undefined);
      assert.equal(runs.advance(token, "running"), undefined);
      assert.equal(runs.markFailed(token, { error: "stale writer" }), undefined);
      assert.equal(runs.get("run-2")?.status, "admitting");
    } finally {
      db.close();
    }
  });

  it("records new linkage in the existing phase and leaves an exact replay unchanged", () => {
    const { db, runs } = createRepos();
    try {
      const admitted = runs.begin({
        runId: "run-delivery",
        jobId: "job-1",
        admissionKey: "delivery-slot",
        scheduledFor: "2026-07-13T10:00:00.000Z",
      });
      assert.equal(admitted.outcome, "begun");
      if (admitted.outcome !== "begun") assert.fail();
      const token = { runId: admitted.run.runId, jobId: admitted.run.jobId, executionGeneration: 1 };
      const admission = { status: "admitting" as const, phase: "child_admission" as const };
      assert.deepEqual(runs.advancePhase(token, admission), admitted.run);
      assert.throws(
        () => runs.advancePhase(token, { ...admission, linkage: { deliveryRunId: "delivery-1" } }),
        ConflictError,
      );
      assert.deepEqual(runs.get(token.runId), admitted.run);

      const delivery = { status: "waiting" as const, phase: "delivery" as const };
      runs.admitInlineExecution(token);
      runs.advancePhase(token, delivery);

      const linked = { ...delivery, linkage: { deliveryRunId: "delivery-1" } };
      const recorded = runs.advancePhase(token, { ...linked, now: "2026-07-13T10:00:01.000Z" });
      assert.equal(recorded?.deliveryRunId, "delivery-1");
      assert.deepEqual(runs.get(token.runId), recorded);
      assert.deepEqual(runs.advancePhase(token, { ...linked, now: "2026-07-13T10:00:02.000Z" }), recorded);
      assert.throws(
        () => runs.advancePhase(token, { ...delivery, linkage: { deliveryRunId: "delivery-2" } }),
        ConflictError,
      );
    } finally {
      db.close();
    }
  });

  it("reserves inline cron execution before side effects and fences stale inline admission", () => {
    const { db, runs } = createRepos();
    try {
      const begun = runs.begin({
        runId: "run-inline",
        jobId: "job-1",
        admissionKey: "inline-slot",
        scheduledFor: "2026-07-13T10:00:00.000Z",
      });
      if (begun.outcome !== "begun") assert.fail("expected begun run");
      const token = {
        runId: begun.run.runId,
        jobId: begun.run.jobId,
        executionGeneration: begun.run.executionGeneration,
      };

      const admitted = runs.admitInlineExecution(token, "2026-07-13T10:00:01.000Z");
      assert.equal(admitted?.status, "running");
      assert.equal(admitted?.phase, "chat_execution");
      assert.equal(admitted?.admittedAt, "2026-07-13T10:00:01.000Z");
      assert.deepEqual(runs.admitInlineExecution(token, "2026-07-13T10:00:02.000Z"), admitted);
      assert.equal(runs.markSucceeded(token, { output: "done" })?.status, "completed");
      assert.equal(runs.admitInlineExecution(token), undefined);
    } finally {
      db.close();
    }
  });

  it("records ambiguous outcomes for manual reconciliation and resolves them once", () => {
    const { db, runs } = createRepos();
    try {
      const begun = runs.begin({
        runId: "run-ambiguous",
        jobId: "job-1",
        admissionKey: "ambiguous-slot",
        scheduledFor: "2026-07-13T10:00:00.000Z",
      });
      if (begun.outcome !== "begun") assert.fail("expected begun run");
      const token = {
        runId: begun.run.runId,
        jobId: begun.run.jobId,
        executionGeneration: begun.run.executionGeneration,
      };
      const uncertain = runs.requireReconciliation(token, {
        reason: "provider accepted the request but no durable acknowledgement arrived",
        error: "unknown_after_send",
      });
      assert.equal(uncertain?.status, "manual_reconciliation_required");

      const held = runs.begin({
        runId: "run-next",
        jobId: "job-1",
        admissionKey: "next-slot",
        scheduledFor: "2026-07-13T11:00:00.000Z",
      });
      assert.equal(held.outcome, "blocked", "manual reconciliation must hold later cron admissions");

      const resolved = runs.reconcile(token, {
        status: "succeeded",
        resolution: "operator confirmed provider-side delivery",
        reconciledBy: "operator-1",
        output: "confirmed",
      });
      assert.equal(resolved?.status, "completed");
      assert.equal(resolved?.reconciliationResolution, "operator confirmed provider-side delivery");
      assert.equal(
        runs.reconcile(token, {
          status: "failed",
          resolution: "second answer",
          reconciledBy: "operator-2",
        }),
        undefined,
      );

      const next = runs.begin({
        runId: "run-next",
        jobId: "job-1",
        admissionKey: "next-slot",
        scheduledFor: "2026-07-13T11:00:00.000Z",
      });
      assert.equal(next.outcome, "begun");
    } finally {
      db.close();
    }
  });

  it("records reconciliation evidence and supports an explicit dead-letter resolution", () => {
    const { db, runs } = createRepos();
    try {
      const begun = runs.begin({
        runId: "run-dead-letter",
        jobId: "job-1",
        admissionKey: "dead-letter-slot",
        scheduledFor: "2026-07-13T10:00:00.000Z",
      });
      if (begun.outcome !== "begun") assert.fail("expected begun run");
      const token = {
        runId: begun.run.runId,
        jobId: begun.run.jobId,
        executionGeneration: begun.run.executionGeneration,
      };
      assert.equal(
        runs.requireReconciliation(token, { reason: "effect outcome could not be proven" })?.status,
        "manual_reconciliation_required",
      );

      const resolved = runs.recordReconciliation(token, {
        status: "dead_lettered",
        resolution: "operator quarantined the occurrence",
        reconciledBy: "operator-1",
        failure: { message: "delivery remains ambiguous" },
        evidenceEnvelopeId: "evidence-1",
      });
      assert.equal(resolved?.status, "dead_lettered");
      assert.equal(resolved?.evidenceEnvelopeId, "evidence-1");
      assert.equal(resolved?.reconciliationResolution, "operator quarantined the occurrence");
    } finally {
      db.close();
    }
  });

  it("preserves history across job recreation and never lets an old generation clear a newer owner", () => {
    const { db, jobs, runs } = createRepos();
    try {
      const first = runs.begin({
        runId: "run-old",
        jobId: "job-1",
        admissionKey: "old-slot",
        scheduledFor: "2026-07-13T10:00:00.000Z",
      });
      if (first.outcome !== "begun") assert.fail("expected first begun run");
      const oldToken = {
        runId: first.run.runId,
        jobId: first.run.jobId,
        executionGeneration: first.run.executionGeneration,
      };

      db.prepare("UPDATE cron_jobs SET active_run_id = NULL WHERE job_id = 'job-1'").run();
      const second = runs.begin({
        runId: "run-new",
        jobId: "job-1",
        admissionKey: "new-slot",
        scheduledFor: "2026-07-13T11:00:00.000Z",
      });
      if (second.outcome !== "begun") assert.fail("expected second begun run");
      assert.equal(second.run.executionGeneration, 2);
      assert.equal(
        runs.terminalize(oldToken, { status: "failed", failure: { message: "late settlement" } }),
        undefined,
        "stale terminal settlement must be fenced in the same transaction as active-owner release",
      );
      assert.equal(jobs.get("job-1")?.activeRunId, "run-new");

      const newToken = {
        runId: second.run.runId,
        jobId: second.run.jobId,
        executionGeneration: second.run.executionGeneration,
      };
      assert.equal(runs.terminalize(newToken, { status: "completed", outcome: { result: "ok" } })?.status, "completed");
      assert.throws(
        () => runs.terminalize(newToken, { status: "completed", outcome: { result: "different" } }),
        ConflictError,
      );

      assert.equal(jobs.delete("job-1"), true);
      assert.equal(runs.get("run-old")?.status, "admitting");
      assert.equal(runs.get("run-new")?.status, "completed");
      jobs.upsert({
        jobId: "job-1",
        name: "Recreated job",
        action: "task",
        schedule: "0 * * * *",
        enabled: true,
      });
      const recreated = runs.begin({
        runId: "run-recreated",
        jobId: "job-1",
        admissionKey: "recreated-slot",
        scheduledFor: "2026-07-13T12:00:00.000Z",
      });
      if (recreated.outcome !== "begun") assert.fail("expected recreated begun run");
      assert.equal(recreated.run.executionGeneration, 3);
      assert.deepEqual(
        runs.listPendingSettlement().map((run) => run.runId),
        ["run-recreated"],
      );
    } finally {
      db.close();
    }
  });
});
