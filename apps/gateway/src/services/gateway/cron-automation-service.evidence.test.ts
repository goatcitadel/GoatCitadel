import { describe, expect, it, vi } from "vitest";
import type { CronJobRecord, CronRunRecord } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { CronAutomationService, type CronAutomationServiceDeps } from "./cron-automation-service.js";
import { createTestCronSpecOwner } from "./cron-spec-owner.test-utils.js";

class FakeCronJobs {
  private readonly rows = new Map<string, CronJobRecord>();

  public list(): CronJobRecord[] {
    return Array.from(this.rows.values()).map((job) => ({ ...job }));
  }

  public get(jobId: string): CronJobRecord | undefined {
    const job = this.rows.get(jobId);
    return job ? { ...job } : undefined;
  }

  public upsert(job: CronJobRecord): CronJobRecord {
    this.rows.set(job.jobId, { revision: this.rows.get(job.jobId)?.revision ?? 1, ...job });
    return this.rows.get(job.jobId) as CronJobRecord;
  }

  public createSpec(job: Omit<CronJobRecord, "revision">): CronJobRecord {
    return this.upsert({ ...job, revision: 1 });
  }

  public updateSpecWithRevision(jobId: string, patch: Partial<CronJobRecord>, expectedRevision: number): CronJobRecord {
    const current = this.rows.get(jobId) as CronJobRecord;
    return this.upsert({ ...current, ...patch, revision: expectedRevision + 1 });
  }

  public mergeRuntimeTelemetry(jobId: string, patch: Partial<CronJobRecord>): CronJobRecord {
    const current = this.rows.get(jobId) as CronJobRecord;
    const next = { ...current } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    this.rows.set(jobId, next as unknown as CronJobRecord);
    return this.rows.get(jobId) as CronJobRecord;
  }

  public mergeRuntimeTelemetryForExecutionGeneration(
    jobId: string,
    executionGeneration: number,
    patch: Partial<CronJobRecord>,
  ): CronJobRecord | undefined {
    if (this.rows.get(jobId)?.executionGeneration !== executionGeneration) return undefined;
    return this.mergeRuntimeTelemetry(jobId, patch);
  }

  public deleteWithRevision(jobId: string): boolean {
    return this.rows.delete(jobId);
  }

  public delete(jobId: string): boolean {
    return this.rows.delete(jobId);
  }
}

function createEvidenceHarness(
  options: {
    evidenceEnabled?: boolean;
    recordEvidenceEnvelope?: CronAutomationServiceDeps["recordEvidenceEnvelope"];
    handlers?: Partial<CronAutomationServiceDeps["runHandlers"]>;
  } = {},
) {
  const cronJobs = new FakeCronJobs();
  const cronRunRows = new Map<string, CronRunRecord>();
  const cronRuns = {
    get: (runId: string) => cronRunRows.get(runId),
    listPendingSettlement: () => [],
    beginAdmission: (input: {
      runId: string;
      jobId: string;
      admissionKey: string;
      scheduledFor: string;
      trigger: "scheduled_due" | "manual" | "forced";
    }) => {
      const job = cronJobs.get(input.jobId) as CronJobRecord;
      const executionGeneration = (job.executionGeneration ?? 0) + 1;
      cronJobs.upsert({ ...job, executionGeneration, activeRunId: input.runId });
      const now = new Date().toISOString();
      const run: CronRunRecord = {
        ...input,
        executionGeneration,
        jobRevision: job.revision,
        action: job.action,
        actionSnapshot: { action: job.action, actionConfig: job.actionConfig },
        status: "admitting",
        phase: "child_admission",
        createdAt: now,
        updatedAt: now,
      };
      cronRunRows.set(run.runId, run);
      return { outcome: "begun" as const, run };
    },
    attachDeterministicChild: (token: { runId: string; executionGeneration: number }, linkage: object) => {
      const current = cronRunRows.get(token.runId);
      if (!current || current.executionGeneration !== token.executionGeneration) return undefined;
      const next = { ...current, ...linkage, status: "admitted" as const, phase: "chat_execution" as const };
      cronRunRows.set(token.runId, next);
      return next;
    },
    admitInlineExecution: (token: { runId: string; executionGeneration: number }) => {
      const current = cronRunRows.get(token.runId);
      if (!current || current.executionGeneration !== token.executionGeneration) return undefined;
      if (current.status === "running" && current.phase === "chat_execution") return current;
      const next = { ...current, status: "running" as const, phase: "chat_execution" as const };
      cronRunRows.set(token.runId, next);
      return next;
    },
    advancePhase: (
      token: { runId: string; executionGeneration: number },
      input: { status: CronRunRecord["status"]; phase: CronRunRecord["phase"]; linkage?: object },
    ) => {
      const current = cronRunRows.get(token.runId);
      if (!current || current.executionGeneration !== token.executionGeneration) return undefined;
      const next = { ...current, ...input.linkage, status: input.status, phase: input.phase } as CronRunRecord;
      cronRunRows.set(token.runId, next);
      return next;
    },
    terminalize: (
      token: { runId: string; executionGeneration: number },
      input: {
        status: CronRunRecord["status"];
        outcome?: Record<string, unknown>;
        failure?: Record<string, unknown>;
        reconciliationReason?: string;
        evidenceEnvelopeId?: string;
        now?: string;
      },
    ) => {
      const current = cronRunRows.get(token.runId);
      if (!current || current.executionGeneration !== token.executionGeneration) return undefined;
      const settledAt = input.now ?? new Date().toISOString();
      const next: CronRunRecord = {
        ...current,
        ...input,
        phase: "settlement",
        settledAt,
        updatedAt: settledAt,
      };
      cronRunRows.set(token.runId, next);
      const job = cronJobs.get(current.jobId);
      if (job?.activeRunId === current.runId) {
        cronJobs.mergeRuntimeTelemetry(current.jobId, { activeRunId: null });
      }
      return next;
    },
  };
  const recordEvidenceEnvelope =
    options.recordEvidenceEnvelope ?? vi.fn((input) => ({ envelopeId: `env-${input.eventKind}` }));
  const service = new CronAutomationService({
    storage: {
      cronJobs,
      cronRuns,
      durableRuns: {
        getRun: (runId: string) => {
          const owner = [...cronRunRows.values()].find((run) => run.childDurableRunId === runId);
          if (!owner) return undefined;
          const admission = {
            cronRunId: owner.runId,
            jobId: owner.jobId,
            executionGeneration: owner.executionGeneration,
          };
          return {
            runId,
            workflowKey: "chat.turn.execute",
            status: "queued",
            payload: { cronAdmission: admission },
            metadata: {
              cronRunId: owner.runId,
              cronJobId: owner.jobId,
              cronExecutionGeneration: owner.executionGeneration,
              cronAdmission: admission,
            },
          };
        },
      },
    } as unknown as Storage,
    specOwner: createTestCronSpecOwner(cronJobs),
    publishRealtime: vi.fn(),
    requireFeatureEnabled: () => {},
    // Review queue stays OFF so the evidence path is isolated from db access.
    isFeatureEnabled: (flag) => flag === "cronEvidenceV1Enabled" && (options.evidenceEnabled ?? true),
    recordEvidenceEnvelope,
    runHandlers: {
      task: async () => ({ taskId: "task-1" }),
      improvement: async () => {},
      backup: async () => {},
      memoryFlush: async () => {},
      costReport: async () => {},
      updateReview: async () => {},
      curator: async () => {},
      watchdog: async () => ({ status: "ok" as const, checkId: "runtime_health" as const, summary: "healthy" }),
      noAgent: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      agentTurn: async () => ({
        mode: "agent_turn",
        durableRunId: "durable-1",
        sessionId: "sess-1",
        turnId: "turn-1",
        userMessageId: "message-user-1",
        assistantMessageId: "message-assistant-1",
      }),
      ...options.handlers,
    },
  });
  return { service, cronJobs, recordEvidenceEnvelope };
}

function seedJob(cronJobs: FakeCronJobs, input: Partial<CronJobRecord> & Pick<CronJobRecord, "jobId">): void {
  cronJobs.upsert({
    name: input.jobId,
    revision: input.revision ?? 1,
    action: "task",
    schedule: "0 12 * * *",
    enabled: true,
    ...input,
  } as CronJobRecord);
}

describe("cron run evidence envelopes", () => {
  it("records a signed envelope on success and pins it on the job and run snapshot", async () => {
    const { service, cronJobs, recordEvidenceEnvelope } = createEvidenceHarness();
    seedJob(cronJobs, { jobId: "daily-task" });

    const result = await service.runCronJobNow("daily-task");

    expect(recordEvidenceEnvelope).toHaveBeenCalledTimes(1);
    const input = vi.mocked(recordEvidenceEnvelope!).mock.calls[0][0];
    expect(input.eventKind).toBe("cron_job_executed");
    expect(input.runId).toBe(result.runId);
    expect(input.metadata).toMatchObject({ jobId: "daily-task", status: "ok", action: "task" });
    expect(typeof (input.metadata as Record<string, unknown>).outputHash).toBe("string");

    expect(cronJobs.get("daily-task")?.lastRunEvidenceEnvelopeId).toBe("env-cron_job_executed");
    expect(service.findCronRunById(result.runId)?.evidenceEnvelopeId).toBe("env-cron_job_executed");
  });

  it("does not mint success evidence while an agent_turn child is only admitted", async () => {
    const { service, cronJobs, recordEvidenceEnvelope } = createEvidenceHarness();
    seedJob(cronJobs, {
      jobId: "scheduled-turn",
      action: "agent_turn",
      actionConfig: { agentTurn: { prompt: "Summarize the day." } },
    });

    const result = await service.runCronJobNow("scheduled-turn");

    expect(result.status).toBe("pending");
    expect(recordEvidenceEnvelope).not.toHaveBeenCalled();
    expect(cronJobs.get("scheduled-turn")?.lastRunEvidenceEnvelopeId).toBeUndefined();
  });

  it("records a failure envelope with the failure message", async () => {
    const { service, cronJobs, recordEvidenceEnvelope } = createEvidenceHarness({
      handlers: { task: async () => Promise.reject(new Error("task exploded")) },
    });
    seedJob(cronJobs, { jobId: "failing-task" });

    await expect(service.runCronJobNow("failing-task")).rejects.toThrow("task exploded");

    expect(recordEvidenceEnvelope).toHaveBeenCalledTimes(1);
    const input = vi.mocked(recordEvidenceEnvelope!).mock.calls[0][0];
    expect(input.metadata).toMatchObject({ status: "failed", failureMessage: "task exploded" });
    expect(cronJobs.get("failing-task")?.lastRunEvidenceEnvelopeId).toBe("env-cron_job_executed");
  });

  it("records nothing when the flag is off", async () => {
    const { service, cronJobs, recordEvidenceEnvelope } = createEvidenceHarness({ evidenceEnabled: false });
    seedJob(cronJobs, { jobId: "quiet-task" });

    const result = await service.runCronJobNow("quiet-task");

    expect(recordEvidenceEnvelope).not.toHaveBeenCalled();
    expect(cronJobs.get("quiet-task")?.lastRunEvidenceEnvelopeId).toBeUndefined();
    expect(service.findCronRunById(result.runId)?.evidenceEnvelopeId).toBeUndefined();
  });

  it("never fails the run when the envelope callback reports failure", async () => {
    const { service, cronJobs } = createEvidenceHarness({
      recordEvidenceEnvelope: vi.fn(() => undefined),
    });
    seedJob(cronJobs, { jobId: "resilient-task" });

    const result = await service.runCronJobNow("resilient-task");

    expect(result.status).toBe("ok");
    expect(cronJobs.get("resilient-task")?.lastRunEvidenceEnvelopeId).toBeUndefined();
  });
});
