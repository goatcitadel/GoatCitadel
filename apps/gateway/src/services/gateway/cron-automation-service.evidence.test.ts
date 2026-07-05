import { describe, expect, it, vi } from "vitest";
import type { CronJobRecord } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { CronAutomationService, type CronAutomationServiceDeps } from "./cron-automation-service.js";

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
    this.rows.set(job.jobId, { ...job });
    return this.rows.get(job.jobId) as CronJobRecord;
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
  const recordEvidenceEnvelope =
    options.recordEvidenceEnvelope ?? vi.fn((input) => ({ envelopeId: `env-${input.eventKind}` }));
  const service = new CronAutomationService({
    storage: {
      cronJobs,
      durableRuns: { getRun: () => undefined },
    } as unknown as Storage,
    persistCronJobsConfig: () => {},
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
      }),
      ...options.handlers,
    },
  });
  return { service, cronJobs, recordEvidenceEnvelope };
}

function seedJob(cronJobs: FakeCronJobs, input: Partial<CronJobRecord> & Pick<CronJobRecord, "jobId">): void {
  cronJobs.upsert({
    name: input.jobId,
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

  it("covers agent_turn runs, which persist run state outside recordCronRunSuccess", async () => {
    const { service, cronJobs, recordEvidenceEnvelope } = createEvidenceHarness();
    seedJob(cronJobs, {
      jobId: "scheduled-turn",
      action: "agent_turn",
      actionConfig: { agentTurn: { prompt: "Summarize the day." } },
    });

    await service.runCronJobNow("scheduled-turn");

    expect(recordEvidenceEnvelope).toHaveBeenCalledTimes(1);
    expect(cronJobs.get("scheduled-turn")?.lastRunEvidenceEnvelopeId).toBe("env-cron_job_executed");
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
