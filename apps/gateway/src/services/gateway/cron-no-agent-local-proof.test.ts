/**
 * Local-only proof lane for graduated no_agent cron (`pnpm verify:cron:no-agent`).
 *
 * Wires the real CronAutomationService to the real `runNoAgentCommand` runner and
 * spawns `process.execPath` locally. No model, provider, or network dependency is
 * reachable: every other run handler throws if it is invoked.
 */
import { describe, expect, it, vi } from "vitest";
import type { CronJobRecord, CronRunRecord } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { CronAutomationService, type CronAutomationServiceDeps } from "./cron-automation-service.js";
import { NO_AGENT_DEFAULT_TIMEOUT_MS, NO_AGENT_MAX_TIMEOUT_MS, runNoAgentCommand } from "./cron-no-agent-runner.js";
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

function forbidden(name: string): () => never {
  return () => {
    throw new Error(`${name} handler must not run for a no_agent cron job`);
  };
}

function createProofHarness() {
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
    admitInlineExecution: (token: { runId: string; executionGeneration: number }) => {
      const current = cronRunRows.get(token.runId);
      if (!current || current.executionGeneration !== token.executionGeneration) return undefined;
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
        evidenceEnvelopeId?: string;
        now?: string;
      },
    ) => {
      const current = cronRunRows.get(token.runId);
      if (!current || current.executionGeneration !== token.executionGeneration) return undefined;
      const settledAt = input.now ?? new Date().toISOString();
      const next: CronRunRecord = { ...current, ...input, phase: "settlement", settledAt, updatedAt: settledAt };
      cronRunRows.set(token.runId, next);
      const job = cronJobs.get(current.jobId);
      if (job?.activeRunId === current.runId) {
        cronJobs.mergeRuntimeTelemetry(current.jobId, { activeRunId: null });
      }
      return next;
    },
  };
  const publishRealtime = vi.fn(async () => undefined);
  const recordEvidenceEnvelope = vi.fn((input: { eventKind: string }) => ({ envelopeId: `env-${input.eventKind}` }));
  const runHandlers = {
    task: forbidden("task"),
    improvement: forbidden("improvement"),
    backup: forbidden("backup"),
    memoryFlush: forbidden("memoryFlush"),
    memoryConsolidation: forbidden("memoryConsolidation"),
    costReport: forbidden("costReport"),
    updateReview: forbidden("updateReview"),
    curator: forbidden("curator"),
    watchdog: forbidden("watchdog"),
    agentTurn: forbidden("agentTurn"),
    // Small default-timeout seam so the absent-timeoutMs path is provable without waiting minutes.
    noAgent: (input: Parameters<typeof runNoAgentCommand>[0]) => runNoAgentCommand({ ...input, defaultTimeoutMs: 600 }),
  } as unknown as CronAutomationServiceDeps["runHandlers"];
  const service = new CronAutomationService({
    storage: { cronJobs, cronRuns } as unknown as Storage,
    specOwner: createTestCronSpecOwner(cronJobs),
    publishRealtime,
    requireFeatureEnabled: () => {},
    isFeatureEnabled: (flag) => flag === "cronEvidenceV1Enabled",
    recordEvidenceEnvelope: recordEvidenceEnvelope as unknown as CronAutomationServiceDeps["recordEvidenceEnvelope"],
    runHandlers,
  });
  return { service, cronJobs, cronRunRows, publishRealtime, recordEvidenceEnvelope };
}

async function createNoAgentJob(
  service: CronAutomationService,
  jobId: string,
  noAgent: { args: string[]; timeoutMs?: number; command?: string },
): Promise<void> {
  await service.createCronJob({
    jobId,
    name: jobId,
    action: "no_agent",
    schedule: "0 12 * * * UTC",
    actionConfig: { noAgent: { command: process.execPath, ...noAgent } },
  });
}

function outputEvents(publishRealtime: ReturnType<typeof createProofHarness>["publishRealtime"]) {
  return (publishRealtime.mock.calls as unknown as Array<[string, string, Record<string, unknown>]>)
    .map((call) => call[2])
    .filter((payload) => payload?.type === "cron_no_agent_output");
}

async function waitUntilDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

describe("no_agent cron local-only proof", () => {
  it("runs a local command, surfaces stdout, and records an ok outcome with evidence", async () => {
    const { service, cronJobs, cronRunRows, publishRealtime, recordEvidenceEnvelope } = createProofHarness();
    await createNoAgentJob(service, "local-ok", { args: ["-e", "process.stdout.write('cron-local-ok')"] });

    const result = await service.runCronJobNow("local-ok");

    expect(result.status).toBe("ok");
    const events = outputEvents(publishRealtime);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ jobId: "local-ok", runId: result.runId, output: "cron-local-ok" });
    expect(cronJobs.get("local-ok")).toMatchObject({ lastRunStatus: "ok", lastRunOutput: "cron-local-ok" });
    expect(cronRunRows.get(result.runId)).toMatchObject({
      status: "completed",
      outcome: { result: "ok", action: "no_agent" },
    });
    expect(recordEvidenceEnvelope).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordEvidenceEnvelope).mock.calls[0]?.[0]).toMatchObject({
      metadata: { jobId: "local-ok", status: "ok", action: "no_agent" },
    });
  });

  it("passes shell metacharacters literally because shell is false", async () => {
    const { service, publishRealtime } = createProofHarness();
    await createNoAgentJob(service, "literal-args", {
      args: ["-e", "process.stdout.write(process.argv[1])", "alpha && echo injected"],
    });

    await service.runCronJobNow("literal-args");

    expect(outputEvents(publishRealtime)[0]).toMatchObject({ output: "alpha && echo injected" });
  });

  it("records a failed outcome with the exit code and a bounded, redacted stderr summary", async () => {
    const { service, cronJobs, cronRunRows, recordEvidenceEnvelope } = createProofHarness();
    const noisy = "x".repeat(2000);
    await createNoAgentJob(service, "local-fail", {
      args: ["-e", `process.stderr.write('${noisy} password=hunter2hunter2'); process.exit(3)`],
    });

    let thrown: Error | undefined;
    try {
      await service.runCronJobNow("local-fail");
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain("exitCode=3");
    expect(thrown?.message).toContain("timedOut=false");
    expect(thrown?.message).toContain("[REDACTED]");
    expect(thrown?.message).not.toContain("hunter2hunter2");
    expect(thrown?.message.length).toBeLessThan(600);
    const job = cronJobs.get("local-fail");
    expect(job).toMatchObject({ lastRunStatus: "failed" });
    expect(job?.lastFailure?.message).toContain("exitCode=3");
    expect(job?.lastFailure?.message).toContain("[REDACTED]");
    expect(job?.lastFailure?.message).not.toContain("hunter2hunter2");
    const runs = [...cronRunRows.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed" });
    expect(vi.mocked(recordEvidenceEnvelope).mock.calls[0]?.[0]).toMatchObject({
      metadata: { jobId: "local-fail", status: "failed" },
    });
  });

  it("redacts secrets from stdout before persisting and broadcasting on success", async () => {
    const { service, cronJobs, publishRealtime, cronRunRows } = createProofHarness();
    await createNoAgentJob(service, "secret-stdout", {
      args: ["-e", "process.stdout.write('status ok password=hunter2hunter2')"],
    });

    const result = await service.runCronJobNow("secret-stdout");

    const output = String(outputEvents(publishRealtime)[0]?.output);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("hunter2hunter2");
    const persisted = String(cronJobs.get("secret-stdout")?.lastRunOutput);
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).not.toContain("hunter2hunter2");
    expect(JSON.stringify(cronRunRows.get(result.runId)?.outcome)).not.toContain("hunter2hunter2");
  });

  it("bounds oversized stdout in the persisted and broadcast copies", async () => {
    const { service, cronJobs, publishRealtime } = createProofHarness();
    await createNoAgentJob(service, "big-stdout", {
      args: ["-e", "process.stdout.write('a'.repeat(1500000) + 'END')"],
    });

    await service.runCronJobNow("big-stdout");

    const output = String(outputEvents(publishRealtime)[0]?.output);
    expect(output.length).toBeLessThan(20000);
    expect(output.startsWith("[output truncated")).toBe(true);
    expect(output.endsWith("END")).toBe(true);
    expect(String(cronJobs.get("big-stdout")?.lastRunOutput).length).toBeLessThan(20000);
  });

  it("applies a default timeout when none is configured and caps oversized timeouts", async () => {
    const { service, cronJobs, publishRealtime } = createProofHarness();
    await createNoAgentJob(service, "defaulted", { args: ["-e", "0"] });
    expect(cronJobs.get("defaulted")?.actionConfig?.noAgent?.timeoutMs).toBe(NO_AGENT_DEFAULT_TIMEOUT_MS);
    await createNoAgentJob(service, "capped", { args: ["-e", "0"], timeoutMs: NO_AGENT_MAX_TIMEOUT_MS * 10 });
    expect(cronJobs.get("capped")?.actionConfig?.noAgent?.timeoutMs).toBe(NO_AGENT_MAX_TIMEOUT_MS);

    // A job stored without timeoutMs (for example pre-existing) still gets the runner default.
    cronJobs.upsert({
      jobId: "legacy-no-timeout",
      name: "legacy-no-timeout",
      revision: 1,
      action: "no_agent",
      schedule: "0 12 * * * UTC",
      enabled: true,
      actionConfig: {
        noAgent: {
          command: process.execPath,
          args: ["-e", "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)"],
        },
      },
    } as CronJobRecord);
    await expect(service.runCronJobNow("legacy-no-timeout")).rejects.toThrow("timedOut=true");
    const pid = Number(outputEvents(publishRealtime)[0]?.output);
    expect(await waitUntilDead(pid)).toBe(false);
  });

  it("surfaces the spawn error code for a nonexistent command", async () => {
    const { service, cronJobs } = createProofHarness();
    await createNoAgentJob(service, "missing-cmd", {
      command: "goatcitadel-definitely-not-a-command",
      args: [],
    });

    await expect(service.runCronJobNow("missing-cmd")).rejects.toThrow("spawnError=ENOENT");
    expect(cronJobs.get("missing-cmd")).toMatchObject({ lastRunStatus: "failed" });
  });

  it("kills the child on timeout and records a failed outcome", async () => {
    const { service, cronJobs, publishRealtime } = createProofHarness();
    await createNoAgentJob(service, "local-timeout", {
      args: ["-e", "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)"],
      timeoutMs: 750,
    });

    await expect(service.runCronJobNow("local-timeout")).rejects.toThrow("timedOut=true");

    expect(cronJobs.get("local-timeout")).toMatchObject({ lastRunStatus: "failed" });
    const pid = Number(outputEvents(publishRealtime)[0]?.output);
    expect(Number.isInteger(pid)).toBe(true);
    expect(await waitUntilDead(pid)).toBe(false);
  });

  it("never reaches a model, provider, or other run handler", async () => {
    const { service } = createProofHarness();
    await createNoAgentJob(service, "isolated", { args: ["-e", "0"] });
    await expect(service.runCronJobNow("isolated")).resolves.toMatchObject({ status: "ok" });
  });
});
