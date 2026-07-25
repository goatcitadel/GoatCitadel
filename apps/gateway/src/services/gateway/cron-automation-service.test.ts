import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJobRecord, CronRunRecord, DurableRunStatus } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import {
  computeNextCronRunAt,
  CronAutomationService,
  EXPERIMENTAL_NO_AGENT_CRON_ENV,
  type CronAutomationServiceDeps,
  didCronJobRunInCurrentWindow,
  isCronJobActive,
  isExplicitCronJobDueNow,
  normalizeCronEndAt,
  normalizeCronJobDescription,
  normalizeCronJobId,
  normalizeCronJobName,
  normalizeCronSchedule,
  parseSimpleCronSchedule,
  UPDATE_REVIEW_DAILY_JOB_ID,
} from "./cron-automation-service.js";
import { createTestCronSpecOwner } from "./cron-spec-owner.test-utils.js";
import { SharedHostLifecycleService } from "../shared-host-lifecycle-service.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

interface CronReviewRow {
  item_id: string;
  job_id: string;
  run_id: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "resolved" | "retrying" | "ignored";
  summary_json: string;
  diff_json: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

class FakeDb {
  public review = new Map<string, CronReviewRow>();
  public diffs = new Map<
    string,
    {
      diff_id: string;
      run_id: string;
      previous_run_id: string | null;
      previousRunId: string | null;
      diff_json: string;
      created_at: string;
    }
  >();
  public failDiffInsert = false;
  public dropUpdatedReviewSelect = false;
  private snapshot: {
    review: Map<string, CronReviewRow>;
    diffs: Map<
      string,
      {
        diff_id: string;
        run_id: string;
        previous_run_id: string | null;
        previousRunId: string | null;
        diff_json: string;
        created_at: string;
      }
    >;
  } | null = null;

  public exec(sql: string): void {
    // "BEGIN IMMEDIATE" is sqlite-only and breaks on the Postgres driver
    // (syntax error at or near "IMMEDIATE"); raw COMMIT/ROLLBACK would bypass
    // the sync client's transaction bookkeeping. Reject them so any regression
    // back to raw transaction-control exec fails here the way it does live.
    const leadingKeyword =
      sql
        .trim()
        .split(/[\s;(]+/, 1)[0]
        ?.toUpperCase() ?? "";
    if (["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "END"].includes(leadingKeyword)) {
      throw new Error(
        `raw transaction-control exec is dialect-unsafe; use storage.runImmediateTransaction (got: ${sql.trim()})`,
      );
    }
  }

  public runImmediateTransaction<T>(callback: () => T): T {
    const snapshot = {
      review: new Map([...this.review.entries()].map(([id, row]) => [id, { ...row }])),
      diffs: new Map(this.diffs),
    };
    this.snapshot = snapshot;
    try {
      const result = callback();
      this.snapshot = null;
      return result;
    } catch (error) {
      this.review = new Map(snapshot.review);
      this.diffs = new Map(snapshot.diffs);
      this.snapshot = null;
      throw error;
    }
  }

  public prepare(sql: string): {
    get: (arg?: unknown) => unknown;
    run: (arg?: unknown) => unknown;
    all: (arg?: unknown) => unknown[];
  } {
    if (sql.includes("FROM cron_review_items") && sql.includes("ORDER BY updated_at DESC")) {
      return {
        get: () => undefined,
        run: () => undefined,
        all: (limit?: unknown) => {
          const safeLimit = typeof limit === "number" ? limit : 200;
          return [...this.review.values()]
            .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
            .slice(0, safeLimit);
        },
      };
    }

    if (sql.includes("FROM cron_review_items") && sql.includes("WHERE item_id = ?")) {
      return {
        get: (itemId?: unknown) =>
          typeof itemId === "string" && !(this.dropUpdatedReviewSelect && this.snapshot)
            ? this.review.get(itemId)
            : undefined,
        run: () => undefined,
        all: () => [],
      };
    }

    if (sql.includes("UPDATE cron_review_items")) {
      return {
        get: () => undefined,
        run: (params?: unknown) => {
          const payload = params as { itemId: string; runId: string; updatedAt: string };
          const current = this.review.get(payload.itemId);
          if (!current) {
            return undefined;
          }
          this.review.set(payload.itemId, {
            ...current,
            status: "retrying",
            run_id: payload.runId,
            updated_at: payload.updatedAt,
            resolved_at: null,
          });
          return undefined;
        },
        all: () => [],
      };
    }

    if (sql.includes("INSERT INTO cron_run_diffs")) {
      return {
        get: () => undefined,
        run: (params?: unknown) => {
          if (this.failDiffInsert) {
            throw new Error("cron_run_diffs unavailable");
          }
          const payload = params as {
            diffId: string;
            runId: string;
            previousRunId: string | null;
            diffJson: string;
            createdAt: string;
          };
          this.diffs.set(payload.runId, {
            diff_id: payload.diffId,
            run_id: payload.runId,
            previous_run_id: payload.previousRunId,
            previousRunId: payload.previousRunId,
            diff_json: payload.diffJson,
            created_at: payload.createdAt,
          });
          return undefined;
        },
        all: () => [],
      };
    }

    if (sql.includes("FROM cron_run_diffs") && sql.includes("WHERE run_id = ?")) {
      return {
        get: (runId?: unknown) => (typeof runId === "string" ? this.diffs.get(runId) : undefined),
        run: () => undefined,
        all: () => [],
      };
    }

    if (sql.includes("INSERT INTO cron_review_items")) {
      return {
        get: () => undefined,
        run: (params?: unknown) => {
          const payload = params as {
            itemId: string;
            jobId: string;
            runId: string;
            severity: CronReviewRow["severity"];
            status: CronReviewRow["status"];
            summaryJson: string;
            diffJson: string | null;
            createdAt: string;
            updatedAt: string;
            resolvedAt: string | null;
          };
          this.review.set(payload.itemId, {
            item_id: payload.itemId,
            job_id: payload.jobId,
            run_id: payload.runId,
            severity: payload.severity,
            status: payload.status,
            summary_json: payload.summaryJson,
            diff_json: payload.diffJson,
            created_at: payload.createdAt,
            updated_at: payload.updatedAt,
            resolved_at: payload.resolvedAt,
          });
          return undefined;
        },
        all: () => [],
      };
    }

    return {
      get: () => undefined,
      run: () => undefined,
      all: () => [],
    };
  }
}

class FakeCronJobs {
  public rows = new Map<string, CronJobRecord>();

  public list(): CronJobRecord[] {
    return [...this.rows.values()];
  }

  public get(jobId: string): CronJobRecord | undefined {
    return this.rows.get(jobId);
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
    const next = { ...current } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return this.upsert({ ...(next as unknown as CronJobRecord), revision: expectedRevision + 1 });
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
    if (this.rows.get(jobId)?.executionGeneration !== executionGeneration) {
      return undefined;
    }
    return this.mergeRuntimeTelemetry(jobId, patch);
  }

  public deleteWithRevision(jobId: string): boolean {
    return this.rows.delete(jobId);
  }

  public delete(jobId: string): boolean {
    return this.rows.delete(jobId);
  }
}

class FakeCronRuns {
  private readonly rows = new Map<string, CronRunRecord>();

  public constructor(private readonly jobs: FakeCronJobs) {}

  public get(runId: string): CronRunRecord | undefined {
    return this.rows.get(runId);
  }

  public list(): CronRunRecord[] {
    return [...this.rows.values()];
  }

  public findByDurableRunId(runId: string): CronRunRecord | undefined {
    return [...this.rows.values()].find((run) => run.childDurableRunId === runId);
  }

  public listPendingSettlement(): CronRunRecord[] {
    return [...this.rows.values()].filter((run) =>
      ["admitting", "admitted", "running", "waiting"].includes(run.status),
    );
  }

  public beginAdmission(input: {
    runId?: string;
    jobId: string;
    admissionKey: string;
    scheduledFor: string;
    trigger?: "scheduled_due" | "manual" | "forced";
  }) {
    const duplicate = [...this.rows.values()].find(
      (run) => run.jobId === input.jobId && run.admissionKey === input.admissionKey,
    );
    if (duplicate) {
      return { outcome: "duplicate" as const, run: duplicate };
    }
    const job = this.jobs.get(input.jobId) as CronJobRecord;
    if (job.activeRunId) {
      return { outcome: "blocked" as const, activeRun: this.rows.get(job.activeRunId) as CronRunRecord };
    }
    const runId = input.runId as string;
    const executionGeneration = (job.executionGeneration ?? 0) + 1;
    this.jobs.upsert({ ...job, executionGeneration, activeRunId: runId });
    const now = new Date().toISOString();
    const run: CronRunRecord = {
      runId,
      jobId: input.jobId,
      admissionKey: input.admissionKey,
      executionGeneration,
      trigger: input.trigger ?? "scheduled_due",
      jobRevision: job.revision,
      action: job.action,
      actionSnapshot: { action: job.action, actionConfig: job.actionConfig },
      scheduledFor: input.scheduledFor,
      status: "admitting",
      phase: "child_admission",
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(runId, run);
    return { outcome: "begun" as const, run };
  }

  public attachDeterministicChild(
    token: { runId: string; executionGeneration: number },
    linkage: object,
  ): CronRunRecord | undefined {
    const current = this.rows.get(token.runId);
    if (!current || current.executionGeneration !== token.executionGeneration) return undefined;
    const next = { ...current, ...linkage, status: "admitted" as const, phase: "chat_execution" as const };
    this.rows.set(token.runId, next);
    return next;
  }

  public admitInlineExecution(token: { runId: string; executionGeneration: number }): CronRunRecord | undefined {
    const current = this.rows.get(token.runId);
    if (!current || current.executionGeneration !== token.executionGeneration) return undefined;
    if (current.status === "running" && current.phase === "chat_execution") return current;
    const next = { ...current, status: "running" as const, phase: "chat_execution" as const };
    this.rows.set(token.runId, next);
    return next;
  }

  public requireReconciliation(
    token: { runId: string; executionGeneration: number },
    input: { reason: string; error?: string },
  ): CronRunRecord | undefined {
    return this.terminalize(token, {
      status: "manual_reconciliation_required",
      reconciliationReason: input.reason,
      failure: input.error ? { message: input.error } : undefined,
    });
  }

  public advancePhase(
    token: { runId: string; executionGeneration: number },
    input: { status: CronRunRecord["status"]; phase: CronRunRecord["phase"]; linkage?: object },
  ): CronRunRecord | undefined {
    const current = this.rows.get(token.runId);
    if (!current || current.executionGeneration !== token.executionGeneration) return undefined;
    const next = { ...current, ...input.linkage, status: input.status, phase: input.phase } as CronRunRecord;
    this.rows.set(token.runId, next);
    return next;
  }

  public terminalize(
    token: { runId: string; executionGeneration: number },
    input: {
      status: CronRunRecord["status"];
      outcome?: Record<string, unknown>;
      failure?: Record<string, unknown>;
      reconciliationReason?: string;
      evidenceEnvelopeId?: string;
      now?: string;
    },
  ): CronRunRecord | undefined {
    const current = this.rows.get(token.runId);
    if (!current || current.executionGeneration !== token.executionGeneration) return undefined;
    const next: CronRunRecord = {
      ...current,
      ...input,
      phase: "settlement",
      settledAt: input.now ?? new Date().toISOString(),
      updatedAt: input.now ?? new Date().toISOString(),
    };
    this.rows.set(token.runId, next);
    if (input.status !== "manual_reconciliation_required") {
      const job = this.jobs.get(current.jobId);
      if (job?.activeRunId === current.runId) this.jobs.upsert({ ...job, activeRunId: undefined });
    }
    return next;
  }
}

function buildTaskJob(input: Partial<CronJobRecord> & Pick<CronJobRecord, "jobId">): CronJobRecord {
  return {
    revision: input.revision ?? 1,
    name: input.jobId,
    action: "task",
    schedule: "0 12 * * *",
    enabled: true,
    ...input,
  };
}

function createService(
  db: FakeDb,
  publishRealtime = vi.fn(),
  options: {
    cronJobs?: FakeCronJobs;
    isFeatureEnabled?: boolean;
    handlers?: Partial<CronAutomationServiceDeps["runHandlers"]>;
    durableStatuses?: Record<string, DurableRunStatus>;
    cronRuns?: FakeCronRuns;
    sharedHostLifecycle?: SharedHostLifecycleService;
  } = {},
): CronAutomationService {
  const cronJobs = options.cronJobs ?? new FakeCronJobs();
  const cronRuns = options.cronRuns ?? new FakeCronRuns(cronJobs);
  return new CronAutomationService({
    storage: {
      db,
      cronJobs,
      cronRuns,
      runImmediateTransaction: <T>(callback: () => T): T => db.runImmediateTransaction(callback),
      durableRuns: {
        getRun: (runId: string) => {
          const owner = cronRuns.findByDurableRunId(runId);
          if (!owner) return undefined;
          const status = options.durableStatuses?.[runId] ?? "queued";
          const admission = {
            cronRunId: owner.runId,
            jobId: owner.jobId,
            executionGeneration: owner.executionGeneration,
          };
          return {
            runId,
            workflowKey: "chat.turn.execute",
            status,
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
    publishRealtime,
    requireFeatureEnabled: () => {},
    isFeatureEnabled: () => options.isFeatureEnabled ?? true,
    sharedHostLifecycle: options.sharedHostLifecycle,
    runHandlers: {
      task: async () => ({ taskId: "task-1" }),
      improvement: async () => {},
      backup: async () => {},
      memoryFlush: async () => {},
      memoryConsolidation: async () => {},
      costReport: async () => {},
      updateReview: async () => {},
      curator: async () => {},
      watchdog: async () => ({
        status: "ok",
        checkId: "runtime_health",
        summary: "runtime healthy",
      }),
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
}

describe("cron schedule helpers", () => {
  it("normalizes ids, names, descriptions, end dates, and supported cron shapes", () => {
    expect(normalizeCronJobId(" JOB_01 ")).toBe("job_01");
    expect(() => normalizeCronJobId("no")).toThrow("Cron job id must be 3-64 chars");
    expect(normalizeCronJobName(" Daily check ")).toBe("Daily check");
    expect(() => normalizeCronJobName(" ")).toThrow("Cron job name is required");
    expect(normalizeCronJobDescription("  details  ")).toBe("details");
    expect(normalizeCronJobDescription(" ")).toBeUndefined();
    expect(normalizeCronEndAt("2026-05-14T12:00:00-07:00")).toBe("2026-05-14T19:00:00.000Z");
    expect(() => normalizeCronEndAt("soon")).toThrow("Cron end date must be a valid ISO date/time");

    expect(normalizeCronSchedule("0 */6 * * * UTC")).toBe("0 */6 * * * UTC");
    expect(parseSimpleCronSchedule("15 9 * * 1,3 America/Los_Angeles")).toMatchObject({
      minute: 15,
      hour: 9,
      weekdays: [1, 3],
      timeZone: "America/Los_Angeles",
    });
    expect(parseSimpleCronSchedule("0 25 * * *")).toBeNull();
    expect(() => normalizeCronSchedule("* * *")).toThrow("Cron schedule must look like");
  });

  it("rejects malformed schedules and no-op normalization inputs", () => {
    expect(normalizeCronEndAt(null)).toBeUndefined();
    expect(normalizeCronEndAt(" ")).toBeUndefined();
    expect(() => normalizeCronJobName("x".repeat(121))).toThrow("Cron job name must be 120 characters or less");
    expect(() => normalizeCronJobDescription("x".repeat(2001))).toThrow(
      "Cron job description must be 2000 characters or less",
    );
    expect(() => normalizeCronSchedule(" ")).toThrow("Cron schedule is required");

    expect(parseSimpleCronSchedule("0 12 1 * *")).toBeNull();
    expect(parseSimpleCronSchedule("x 12 * * *")).toBeNull();
    expect(parseSimpleCronSchedule("60 12 * * *")).toBeNull();
    expect(parseSimpleCronSchedule("0 */0 * * *")).toBeNull();
    expect(parseSimpleCronSchedule("0 nope * * *")).toBeNull();
    expect(parseSimpleCronSchedule("0 24 * * *")).toBeNull();
    expect(parseSimpleCronSchedule("0 12 * * 9")).toBeNull();
    expect(parseSimpleCronSchedule("0 12 * * * Not/AZone")).toBeNull();

    const invalidJob = buildTaskJob({ jobId: "invalid", schedule: "bad" });
    expect(isExplicitCronJobDueNow(invalidJob, new Date("2026-05-14T12:00:00.000Z"))).toBe(false);
    expect(didCronJobRunInCurrentWindow({ ...invalidJob, lastRunAt: "bad-date" }, new Date())).toBe(false);
    expect(
      didCronJobRunInCurrentWindow(
        { ...buildTaskJob({ jobId: "valid", schedule: "0 12 * * * UTC" }), lastRunAt: "bad-date" },
        new Date("2026-05-14T12:00:00.000Z"),
      ),
    ).toBe(false);
    expect(computeNextCronRunAt("bad", new Date("2026-05-14T12:00:00.000Z"))).toBeUndefined();
    expect(
      computeNextCronRunAt("0 12 * * * UTC", new Date("2026-05-14T12:00:00.000Z"), "2026-05-14T12:00:30.000Z"),
    ).toBeUndefined();
    expect(
      isExplicitCronJobDueNow(
        buildTaskJob({ jobId: "weekday", schedule: "0 12 * * 1 UTC" }),
        new Date("2026-05-14T12:00:00.000Z"),
      ),
    ).toBe(false);

    const weekdayCases = [
      ["sun", "0 12 * * 0 UTC", "2026-05-17T12:00:00.000Z"],
      ["mon", "0 12 * * 1 UTC", "2026-05-18T12:00:00.000Z"],
      ["tue", "0 12 * * 2 UTC", "2026-05-19T12:00:00.000Z"],
      ["wed", "0 12 * * 3 UTC", "2026-05-20T12:00:00.000Z"],
      ["sat", "0 12 * * 6 UTC", "2026-05-16T12:00:00.000Z"],
    ] as const;
    for (const [jobId, schedule, now] of weekdayCases) {
      expect(isExplicitCronJobDueNow(buildTaskJob({ jobId, schedule }), new Date(now))).toBe(true);
    }
  });

  it("matches due windows, suppresses duplicate runs, and computes the next run before endAt", () => {
    const now = new Date("2026-05-14T12:03:00.000Z");
    const job = buildTaskJob({
      jobId: "job-1",
      schedule: "0 12 * * * UTC",
      lastRunAt: "2026-05-14T12:03:00.000Z",
      endAt: "2026-05-15T00:00:00.000Z",
    });

    expect(isCronJobActive(job, now)).toBe(true);
    expect(isExplicitCronJobDueNow(job, now)).toBe(true);
    expect(didCronJobRunInCurrentWindow(job, now)).toBe(true);
    expect(computeNextCronRunAt("0 12 * * * UTC", now, "2026-05-14T12:30:00.000Z")).toBe("2026-05-14T12:04:00.000Z");
    expect(computeNextCronRunAt("0 */6 * * * UTC", new Date("2026-05-14T12:04:00.000Z"))).toBe(
      "2026-05-14T18:00:00.000Z",
    );
  });
});

describe("CronAutomationService job behavior", () => {
  it("lists jobs and reports missing, duplicate, paused, ended, and unrunnable jobs", async () => {
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const service = createService(db, vi.fn(), { cronJobs });
    cronJobs.upsert(buildTaskJob({ jobId: "existing-job" }));
    cronJobs.upsert(buildTaskJob({ jobId: "paused-job", enabled: false }));
    cronJobs.upsert(buildTaskJob({ jobId: "ended-job", endAt: "2000-01-01T00:00:00.000Z" }));
    cronJobs.upsert(buildTaskJob({ jobId: "custom-job", action: "custom" as never }));

    expect(service.listCronJobs()).toHaveLength(4);
    expect(service.getCronJob(" EXISTING-JOB ")).toMatchObject({ jobId: "existing-job" });
    expect(() => service.getCronJob("missing-job")).toThrow("Cron job not found: missing-job");
    await expect(
      service.createCronJob({ jobId: "existing-job", name: "Existing", schedule: "0 12 * * * UTC" }),
    ).rejects.toThrow("Cron job already exists: existing-job");

    await expect(service.runCronJobNow("paused-job")).rejects.toThrow("Cron job is paused: paused-job");
    await expect(service.runCronJobNow("ended-job")).rejects.toThrow("Cron job has ended: ended-job");
    await expect(service.runCronJobNow("custom-job")).rejects.toThrow("Cron job has no runnable handler: custom-job");
  });

  it("creates, updates, pauses, and deletes non-system jobs with persisted realtime events", async () => {
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const publishRealtime = vi.fn();
    const service = createService(db, publishRealtime, { cronJobs });

    const created = await service.createCronJob({
      jobId: "Daily_Task",
      name: " Daily task ",
      schedule: "0 12 * * * UTC",
      description: " hello ",
      workdir: "F:/code/personal-ai",
      contextFrom: "upstream",
    });
    expect(created).toMatchObject({
      jobId: "daily_task",
      name: "Daily task",
      description: "hello",
      action: "task",
      enabled: true,
      workdir: "F:/code/personal-ai",
      contextFrom: "upstream",
    });
    expect(created.nextRunAt).toBeDefined();

    cronJobs.mergeRuntimeTelemetry("daily_task", {
      lastRunAt: "2026-07-12T12:00:00.000Z",
      lastRunOutput: "newer scheduler result",
      lastRunId: "scheduler-run-2",
      lastRunStatus: "ok",
    });

    const updated = await service.updateCronJob(
      "daily_task",
      {
        action: "watchdog",
        actionConfig: {
          watchdog: {
            checkId: "mcp_posture",
            severityThreshold: "error",
            notifyHomeChannel: true,
          },
        },
        enabled: false,
        workdir: null,
        contextFrom: "upstream-2",
      },
      created.revision,
    );
    expect(updated.actionConfig).toEqual({
      watchdog: {
        checkId: "mcp_posture",
        severityThreshold: "error",
        notifyHomeChannel: true,
      },
    });
    expect(updated.workdir).toBeUndefined();
    expect(updated.contextFrom).toBe("upstream-2");
    expect(updated.lastRunOutput).toBe("newer scheduler result");
    expect(updated.lastRunId).toBe("scheduler-run-2");
    const changedAction = await service.updateCronJob("daily_task", { action: "improvement" }, updated.revision);
    expect(changedAction.actionConfig).toBeUndefined();
    const enabled = await service.setCronJobEnabled("daily_task", true, changedAction.revision);
    expect(enabled.enabled).toBe(true);
    await expect(service.deleteCronJob("daily_task", enabled.revision)).resolves.toEqual({
      deleted: true,
      jobId: "daily_task",
    });
    await expect(service.deleteCronJob(UPDATE_REVIEW_DAILY_JOB_ID, 1)).rejects.toThrow(
      "System cron job cannot be deleted",
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "cron",
      expect.objectContaining({ type: "cron_job_created", jobId: "daily_task" }),
    );
  });

  it("runs due scheduled task and built-in jobs once per cron window while skipping inactive jobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:03:00.000Z"));
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const task = vi.fn(async () => ({ taskId: "task-created" }));
    const service = createService(db, vi.fn(), {
      cronJobs,
      handlers: { task },
    });
    cronJobs.upsert(buildTaskJob({ jobId: "due-job", schedule: "0 12 * * * UTC" }));
    cronJobs.upsert(
      buildTaskJob({ jobId: "ended-window", schedule: "0 12 * * * UTC", endAt: "2026-05-13T00:00:00.000Z" }),
    );
    cronJobs.upsert(buildTaskJob({ jobId: "future-window", schedule: "0 13 * * * UTC" }));
    cronJobs.upsert(
      buildTaskJob({
        jobId: "already-ran",
        schedule: "0 12 * * * UTC",
        lastRunAt: "2026-05-15T12:03:00.000Z",
      }),
    );
    cronJobs.upsert(buildTaskJob({ jobId: UPDATE_REVIEW_DAILY_JOB_ID, schedule: "0 12 * * * UTC" }));
    cronJobs.upsert(buildTaskJob({ jobId: "disabled-job", schedule: "0 12 * * * UTC", enabled: false }));

    try {
      await service.runDueTaskCronJobs(new Date("2026-05-15T12:03:00.000Z"));
    } finally {
      vi.useRealTimers();
    }

    expect(task).toHaveBeenCalledTimes(2);
    expect(task.mock.calls.map((call) => call[0].jobId).sort()).toEqual(["due-job", UPDATE_REVIEW_DAILY_JOB_ID].sort());
    expect(cronJobs.get("due-job")?.lastRunAt).toBeDefined();
    expect(cronJobs.get("due-job")?.nextRunAt).toMatch(/^2026-05-15T12:0[0-4]:/);
  });

  it("isolates due job failures, records backoff, and keeps running later due jobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:03:00.000Z"));
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const publishRealtime = vi.fn();
    const task = vi.fn(async (job: CronJobRecord) => {
      if (job.jobId === "failing-due") {
        throw new Error("downstream worker refused the run\nwith extra detail");
      }
      return { taskId: `task-${job.jobId}` };
    });
    const service = createService(db, publishRealtime, {
      cronJobs,
      handlers: { task },
    });
    cronJobs.upsert(buildTaskJob({ jobId: "failing-due", schedule: "0 12 * * * UTC" }));
    cronJobs.upsert(buildTaskJob({ jobId: "next-due", schedule: "0 12 * * * UTC" }));

    let summary;
    try {
      summary = await service.runDueTaskCronJobs(new Date("2026-05-15T12:03:00.000Z"));
    } finally {
      vi.useRealTimers();
    }

    expect(summary).toMatchObject({
      dueCount: 2,
      ranCount: 1,
      failedCount: 1,
      backoffCount: 0,
    });
    expect(task).toHaveBeenCalledTimes(2);
    expect(summary.items.map((item) => [item.jobId, item.status])).toEqual([
      ["failing-due", "failed"],
      ["next-due", "ran"],
    ]);
    expect(cronJobs.get("failing-due")).toMatchObject({
      lastRunStatus: "failed",
      failureCount: 1,
      lastFailure: { message: "downstream worker refused the run with extra detail", code: "Error" },
      backoffUntil: "2026-05-15T12:04:00.000Z",
    });
    expect(cronJobs.get("next-due")).toMatchObject({
      lastRunStatus: "ok",
      failureCount: 0,
    });
    expect(publishRealtime).toHaveBeenCalledWith(
      "cron_job_run",
      "cron",
      expect.objectContaining({
        type: "cron_job_run_failed",
        jobId: "failing-due",
        failureCount: 1,
        backoffUntil: "2026-05-15T12:04:00.000Z",
      }),
    );
  });

  it("skips backed-off due jobs but lets an explicit force run clear stale backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:03:00.000Z"));
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const task = vi.fn(async () => ({ taskId: "forced-task" }));
    const service = createService(db, vi.fn(), {
      cronJobs,
      handlers: { task },
    });
    cronJobs.upsert(
      buildTaskJob({
        jobId: "backoff-due",
        schedule: "0 12 * * * UTC",
        backoffUntil: "2026-05-15T12:10:00.000Z",
        failureCount: 2,
        lastRunStatus: "failed",
        lastFailureAt: "2026-05-15T12:02:00.000Z",
        lastFailure: { message: "previous failure" },
      }),
    );

    let summary;
    let forced;
    try {
      summary = await service.runDueTaskCronJobs(new Date("2026-05-15T12:03:00.000Z"));
      forced = await service.runCronJobNow("backoff-due", { force: true, reason: "operator_retry" });
    } finally {
      vi.useRealTimers();
    }

    expect(summary).toMatchObject({
      dueCount: 1,
      ranCount: 0,
      failedCount: 0,
      backoffCount: 1,
    });
    expect(task).toHaveBeenCalledTimes(1);
    expect(forced).toMatchObject({ jobId: "backoff-due", status: "ok", force: true });
    const clearedBackoffJob = cronJobs.get("backoff-due");
    expect(clearedBackoffJob).toMatchObject({
      lastRunStatus: "ok",
      failureCount: 0,
    });
    expect(clearedBackoffJob?.backoffUntil).toBeUndefined();
    expect(clearedBackoffJob?.lastFailure).toBeUndefined();
  });

  it("runs non-task handlers and records low-severity manual review entries when enabled", async () => {
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const handlers = {
      improvement: vi.fn(async () => {}),
      backup: vi.fn(async () => {}),
      memoryFlush: vi.fn(async () => {}),
      costReport: vi.fn(async () => {}),
      updateReview: vi.fn(async () => {}),
      curator: vi.fn(async () => {}),
    };
    const service = createService(db, vi.fn(), { cronJobs, handlers });
    for (const action of [
      "improvement",
      "backup",
      "memory_flush",
      "cost_report",
      "update_review",
      "curator",
    ] as const) {
      cronJobs.upsert(buildTaskJob({ jobId: `${action.replace("_", "-")}-job`, action }));
    }

    const runIdsByJob = new Map<string, string>();
    for (const job of cronJobs.list()) {
      const result = await service.runCronJobNow(job.jobId);
      expect(result).toMatchObject({ jobId: job.jobId, status: "ok" });
      runIdsByJob.set(job.jobId, result.runId);
    }

    expect(handlers.improvement).toHaveBeenCalledTimes(1);
    expect(handlers.backup).toHaveBeenCalledTimes(1);
    expect(handlers.memoryFlush).toHaveBeenCalledTimes(1);
    expect(handlers.costReport).toHaveBeenCalledTimes(1);
    expect(handlers.updateReview).toHaveBeenCalledTimes(1);
    expect(handlers.curator).toHaveBeenCalledTimes(1);
    expect([...db.review.values()].map((row) => row.status)).toEqual([
      "resolved",
      "resolved",
      "resolved",
      "resolved",
      "resolved",
      "resolved",
    ]);
    for (const row of db.review.values()) {
      expect(row.run_id).toBe(runIdsByJob.get(row.job_id));
    }
  });

  it("keeps no_agent cron jobs behind the explicit experimental env gate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:03:00.000Z"));
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const noAgent = vi.fn(async () => ({ stdout: "alert", stderr: "", exitCode: 0, timedOut: false }));
    const service = createService(db, vi.fn(), {
      cronJobs,
      handlers: { noAgent },
    });

    try {
      await expect(
        service.createCronJob({
          jobId: "new-no-agent",
          name: "New no-agent",
          action: "no_agent",
          schedule: "0 12 * * * UTC",
          actionConfig: { noAgent: { command: "echo" } },
        }),
      ).rejects.toThrow(EXPERIMENTAL_NO_AGENT_CRON_ENV);

      cronJobs.upsert(
        buildTaskJob({
          jobId: "legacy-no-agent",
          action: "no_agent",
          schedule: "0 12 * * * UTC",
          actionConfig: { noAgent: { command: "echo" } },
        }),
      );

      await expect(service.runCronJobNow("legacy-no-agent")).rejects.toThrow(EXPERIMENTAL_NO_AGENT_CRON_ENV);
      await service.runDueTaskCronJobs(new Date("2026-05-15T12:03:00.000Z"));
      expect(noAgent).not.toHaveBeenCalled();
      await expect(service.updateCronJob("legacy-no-agent", { enabled: false }, 1)).resolves.toMatchObject({
        enabled: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs curator as a scheduled cron action and records its run window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T02:03:00.000Z"));
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const curator = vi.fn(async () => {});
    const service = createService(db, vi.fn(), {
      cronJobs,
      handlers: { curator },
    });
    cronJobs.upsert(
      buildTaskJob({
        jobId: "curator-weekly",
        action: "curator",
        schedule: "0 2 * * 0 UTC",
      }),
    );

    try {
      await service.runDueTaskCronJobs(new Date("2026-05-17T02:03:00.000Z"));
      await service.runDueTaskCronJobs(new Date("2026-05-17T02:04:00.000Z"));
    } finally {
      vi.useRealTimers();
    }

    expect(curator).toHaveBeenCalledTimes(1);
    expect(cronJobs.get("curator-weekly")?.lastRunAt).toBeDefined();
    expect(cronJobs.get("curator-weekly")?.lastRunId).toBeDefined();
    expect(cronJobs.get("curator-weekly")?.nextRunAt).toBeDefined();
  });

  it("executes one curator effect and one terminal canonical run under concurrent same-tick sweeps", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-05-17T02:03:00.000Z");
    vi.setSystemTime(now);
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const cronRuns = new FakeCronRuns(cronJobs);
    let releaseCurator: (() => void) | undefined;
    const curatorGate = new Promise<void>((resolve) => {
      releaseCurator = resolve;
    });
    const curator = vi.fn(() => curatorGate);
    const service = createService(db, vi.fn(), {
      cronJobs,
      cronRuns,
      handlers: { curator },
    });
    cronJobs.upsert(
      buildTaskJob({
        jobId: "curator-weekly-concurrent",
        action: "curator",
        schedule: "0 2 * * 0 UTC",
      }),
    );

    try {
      const firstSweep = service.runDueTaskCronJobs(now);
      expect(curator).toHaveBeenCalledTimes(1);
      const overlappingSweep = service.runDueTaskCronJobs(now);
      await overlappingSweep;
      releaseCurator?.();
      await firstSweep;
    } finally {
      vi.useRealTimers();
    }

    expect(curator).toHaveBeenCalledTimes(1);
    expect(cronRuns.list()).toHaveLength(1);
    expect(cronRuns.list()[0]).toMatchObject({
      jobId: "curator-weekly-concurrent",
      status: "completed",
      phase: "settlement",
      trigger: "scheduled_due",
    });
  });

  it("records a manual curator invocation as one effect and one terminal canonical run", async () => {
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const cronRuns = new FakeCronRuns(cronJobs);
    const curator = vi.fn(async () => undefined);
    const service = createService(db, vi.fn(), { cronJobs, cronRuns, handlers: { curator } });
    cronJobs.upsert(buildTaskJob({ jobId: "curator-manual", action: "curator" }));

    const result = await service.runCronJobNow("curator-manual");

    expect(curator).toHaveBeenCalledTimes(1);
    expect(cronRuns.list()).toHaveLength(1);
    expect(cronRuns.get(result.runId)).toMatchObject({
      status: "completed",
      phase: "settlement",
      trigger: "manual",
    });
  });

  it("records watchdog review items only when the configured threshold is met", async () => {
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const publishRealtime = vi.fn();
    const recordSpy = vi.spyOn(CronAutomationService.prototype, "recordCronReviewItem").mockImplementation(() => {});
    try {
      const service = createService(db, publishRealtime, {
        cronJobs,
        handlers: {
          watchdog: async () => ({
            status: "warning",
            checkId: "runtime_health",
            summary: "latency elevated",
            notifyHomeChannel: true,
          }),
        },
      });
      cronJobs.upsert(
        buildTaskJob({
          jobId: "watchdog-job",
          action: "watchdog",
          actionConfig: {
            watchdog: {
              checkId: "runtime_health",
              severityThreshold: "error",
              notifyHomeChannel: true,
            },
          },
        }),
      );

      await service.runCronJobNow("watchdog-job");
      expect(recordSpy).not.toHaveBeenCalled();
      expect(publishRealtime).toHaveBeenCalledWith(
        "cron_job_run",
        "cron",
        expect.objectContaining({ type: "watchdog_check_attention_required", status: "warning" }),
      );

      await service.updateCronJob(
        "watchdog-job",
        {
          actionConfig: {
            watchdog: {
              checkId: "runtime_health",
              severityThreshold: "warning",
            },
          },
        },
        1,
      );
      const warningResult = await service.runCronJobNow("watchdog-job");
      expect(recordSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "watchdog-job",
          runId: warningResult.runId,
          severity: "medium",
          status: "open",
        }),
      );
    } finally {
      recordSpy.mockRestore();
    }
  });

  it("records watchdog details at the default warning threshold", async () => {
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const service = createService(db, vi.fn(), {
      cronJobs,
      handlers: {
        watchdog: async () => ({
          status: "error",
          checkId: "durable_dead_letters",
          summary: "dead letter queue backed up",
          notifyHomeChannel: true,
          details: { count: 3 },
        }),
      },
    });
    cronJobs.upsert(
      buildTaskJob({
        jobId: "watchdog-details",
        action: "watchdog",
        actionConfig: {
          watchdog: {
            checkId: "not-real" as never,
            severityThreshold: "warning",
          },
        },
      }),
    );

    const result = await service.runCronJobNow("watchdog-details");

    const [row] = [...db.review.values()];
    expect(row).toMatchObject({
      job_id: "watchdog-details",
      run_id: result.runId,
      severity: "high",
      status: "open",
    });
    expect(JSON.parse(row?.summary_json ?? "{}")).toMatchObject({
      trigger: "watchdog",
      checkId: "durable_dead_letters",
      details: { count: 3 },
    });

    const created = await service.createCronJob({
      jobId: "watchdog-default",
      name: "Watchdog default",
      action: "watchdog",
      schedule: "0 12 * * * UTC",
      actionConfig: { unexpected: true },
    });
    expect(created.actionConfig).toEqual({
      watchdog: {
        checkId: "runtime_health",
        severityThreshold: "warning",
        notifyHomeChannel: false,
      },
    });
  });
});

function makeServiceWithNoAgent(opts: {
  realtime: ReturnType<typeof vi.fn>;
  runner: (input: unknown) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
}): CronAutomationService {
  const db = new FakeDb();
  const cronJobs = new FakeCronJobs();
  const cronRuns = new FakeCronRuns(cronJobs);
  const deps: CronAutomationServiceDeps = {
    storage: { db, cronJobs, cronRuns } as unknown as Storage,
    specOwner: createTestCronSpecOwner(cronJobs),
    publishRealtime: opts.realtime,
    requireFeatureEnabled: () => {},
    isFeatureEnabled: () => false,
    runHandlers: {
      task: async () => ({}),
      improvement: async () => {},
      backup: async () => {},
      memoryFlush: async () => {},
      memoryConsolidation: async () => {},
      costReport: async () => {},
      updateReview: async () => {},
      curator: async () => {},
      watchdog: async () => ({ status: "ok", checkId: "runtime_health", summary: "ok" }),
      noAgent: opts.runner,
      agentTurn: async () => ({ mode: "agent_turn", durableRunId: "durable-1" }),
    },
  };
  return new CronAutomationService(deps);
}

describe("createCronJob workdir + contextFrom", () => {
  it("stores workdir and contextFrom on the persisted record", async () => {
    const service = makeServiceWithNoAgent({
      realtime: vi.fn(),
      runner: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    });
    const saved = await service.createCronJob({
      jobId: "chained",
      name: "Chained",
      action: "task",
      schedule: "0 */6 * * * UTC",
      workdir: "/tmp/test",
      contextFrom: "upstream",
    });
    expect(saved.workdir).toBe("/tmp/test");
    expect(saved.contextFrom).toBe("upstream");
  });
});

describe("contextFrom resolution", () => {
  function makeServiceWithTask(opts: {
    realtime: ReturnType<typeof vi.fn>;
    cronJobs: FakeCronJobs;
    task: CronAutomationServiceDeps["runHandlers"]["task"];
  }): CronAutomationService {
    const db = new FakeDb();
    const cronRuns = new FakeCronRuns(opts.cronJobs);
    const deps: CronAutomationServiceDeps = {
      storage: { db, cronJobs: opts.cronJobs, cronRuns } as unknown as Storage,
      specOwner: createTestCronSpecOwner(opts.cronJobs),
      publishRealtime: opts.realtime,
      requireFeatureEnabled: () => {},
      isFeatureEnabled: () => false,
      runHandlers: {
        task: opts.task,
        improvement: async () => {},
        backup: async () => {},
        memoryFlush: async () => {},
        memoryConsolidation: async () => {},
        costReport: async () => {},
        updateReview: async () => {},
        curator: async () => {},
        watchdog: async () => ({ status: "ok", checkId: "runtime_health", summary: "ok" }),
        noAgent: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
        agentTurn: async () => ({ mode: "agent_turn", durableRunId: "durable-1" }),
      },
    };
    return new CronAutomationService(deps);
  }

  it("passes upstream lastRunOutput to task handler as contextOutput", async () => {
    const cronJobs = new FakeCronJobs();
    const captured: Array<{ contextFrom?: string; contextOutput?: string }> = [];

    const service = makeServiceWithTask({
      realtime: vi.fn(),
      cronJobs,
      task: async (_job, context) => {
        captured.push({ contextFrom: context?.contextFrom, contextOutput: context?.contextOutput });
        return {};
      },
    });

    // Pre-seed the upstream job with a lastRunOutput.
    cronJobs.upsert({
      jobId: "upstream",
      name: "Upstream",
      action: "no_agent",
      schedule: "0 */6 * * * UTC",
      enabled: true,
      lastRunOutput: "context-payload",
    });

    service.createCronJob({
      jobId: "downstream",
      name: "Downstream",
      action: "task",
      schedule: "0 */6 * * * UTC",
      contextFrom: "upstream",
    });

    await service.runCronJobNow("downstream");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.contextFrom).toBe("upstream");
    expect(captured[0]?.contextOutput).toBe("context-payload");
  });

  it("passes undefined contextOutput when contextFrom job has no lastRunOutput yet", async () => {
    const cronJobs = new FakeCronJobs();
    const captured: Array<{ contextFrom?: string; contextOutput?: string }> = [];

    const service = makeServiceWithTask({
      realtime: vi.fn(),
      cronJobs,
      task: async (_job, context) => {
        captured.push({ contextFrom: context?.contextFrom, contextOutput: context?.contextOutput });
        return {};
      },
    });

    // Pre-seed upstream with no lastRunOutput.
    cronJobs.upsert({
      jobId: "upstream",
      name: "Upstream",
      action: "no_agent",
      schedule: "0 */6 * * * UTC",
      enabled: true,
    });

    service.createCronJob({
      jobId: "downstream2",
      name: "Downstream2",
      action: "task",
      schedule: "0 */6 * * * UTC",
      contextFrom: "upstream",
    });

    await service.runCronJobNow("downstream2");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.contextFrom).toBe("upstream");
    expect(captured[0]?.contextOutput).toBeUndefined();
  });
});

describe("shared-host cron admission", () => {
  it("persists canonical inline admission before the task handler can perform side effects", async () => {
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    cronJobs.upsert(buildTaskJob({ jobId: "canonical-inline" }));
    const cronRuns = new FakeCronRuns(cronJobs);
    let observedDuringHandler: CronRunRecord | undefined;
    const service = createService(db, vi.fn(), {
      cronJobs,
      cronRuns,
      handlers: {
        task: async () => {
          const activeRunId = cronJobs.get("canonical-inline")?.activeRunId;
          observedDuringHandler = activeRunId ? cronRuns.get(activeRunId) : undefined;
          return { taskId: "task-inline" };
        },
      },
    });

    const result = await service.runCronJobNow("canonical-inline", {
      admissionKey: "manual:inline-proof",
      scheduledFor: "2026-07-14T05:00:00.000Z",
    });

    expect(observedDuringHandler).toMatchObject({
      runId: result.runId,
      status: "running",
      phase: "chat_execution",
      admissionKey: "manual:inline-proof",
    });
    expect(cronRuns.get(result.runId)).toMatchObject({ status: "completed", phase: "settlement" });
    expect(cronJobs.get("canonical-inline")?.activeRunId).toBeUndefined();
  });

  it("rejects a cron fire before canonical reservation or handler side effects once drain begins", async () => {
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    cronJobs.upsert(buildTaskJob({ jobId: "drain-rejected" }));
    const cronRuns = new FakeCronRuns(cronJobs);
    const task = vi.fn(async () => ({ taskId: "should-not-run" }));
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    await lifecycle.drain({ mode: "pause", timeoutMs: 10, reason: "scale_down", actorId: "ops" });
    const service = createService(db, vi.fn(), {
      cronJobs,
      cronRuns,
      handlers: { task },
      sharedHostLifecycle: lifecycle,
    });
    await expect(service.runCronJobNow("drain-rejected")).rejects.toMatchObject({
      code: "SHARED_HOST_ADMISSION_CLOSED",
      lifecycleState: "quiesced",
    });
    expect(task).not.toHaveBeenCalled();
    expect(cronRuns.listPendingSettlement()).toEqual([]);
  });

  it("holds an inline occurrence for reconciliation after restart instead of replaying its side effect", async () => {
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    cronJobs.upsert(buildTaskJob({ jobId: "restart-inline" }));
    const cronRuns = new FakeCronRuns(cronJobs);
    const begun = cronRuns.beginAdmission({
      runId: "run-before-restart",
      jobId: "restart-inline",
      admissionKey: "scheduled:2026-07-14T05:00:00.000Z",
      scheduledFor: "2026-07-14T05:00:00.000Z",
      trigger: "scheduled_due",
    });
    if (begun.outcome !== "begun") throw new Error("expected canonical admission");
    cronRuns.admitInlineExecution({
      runId: begun.run.runId,
      executionGeneration: begun.run.executionGeneration,
    });
    const task = vi.fn(async () => ({ taskId: "must-not-replay" }));
    const service = createService(db, vi.fn(), { cronJobs, cronRuns, handlers: { task } });

    const recovery = await service.recoverPendingAgentTurnCronRuns();

    expect(recovery).toMatchObject({ checkedCount: 1, settledCount: 1, reconciliationCount: 1 });
    expect(cronRuns.get("run-before-restart")).toMatchObject({
      status: "manual_reconciliation_required",
      failure: { message: "restart_after_inline_admission" },
    });
    expect(task).not.toHaveBeenCalled();
  });

  it("does not run a recovery sweep after the shared host has quiesced", async () => {
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    cronJobs.upsert(buildTaskJob({ jobId: "quiesced-recovery" }));
    const cronRuns = new FakeCronRuns(cronJobs);
    const begun = cronRuns.beginAdmission({
      runId: "run-quiesced-recovery",
      jobId: "quiesced-recovery",
      admissionKey: "scheduled:quiesced",
      scheduledFor: "2026-07-14T05:00:00.000Z",
    });
    if (begun.outcome !== "begun") throw new Error("expected canonical admission");
    cronRuns.admitInlineExecution({ runId: begun.run.runId, executionGeneration: begun.run.executionGeneration });
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    await lifecycle.drain({ mode: "pause", timeoutMs: 10, reason: "scale_down", actorId: "ops" });
    const service = createService(db, vi.fn(), { cronJobs, cronRuns, sharedHostLifecycle: lifecycle });
    const recovery = await service.recoverPendingAgentTurnCronRuns();
    expect(recovery).toMatchObject({ checkedCount: 0, errors: [{ runId: "shared-host-admission" }] });
    expect(cronRuns.get("run-quiesced-recovery")).toMatchObject({ status: "running" });
  });
});

describe("no_agent cron action", () => {
  beforeEach(() => {
    vi.stubEnv(EXPERIMENTAL_NO_AGENT_CRON_ENV, "true");
  });

  it("skips delivery when stdout is empty", async () => {
    const realtime = vi.fn();
    const service = makeServiceWithNoAgent({
      realtime,
      runner: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    });
    service.createCronJob({
      jobId: "probe-empty",
      name: "probe-empty",
      action: "no_agent",
      schedule: "0 */6 * * * UTC",
      actionConfig: { noAgent: { command: "echo", args: [""] } },
    });
    await service.runCronJobNow("probe-empty");
    const events = realtime.mock.calls.map((call) => call[2]?.type).filter(Boolean);
    expect(events).not.toContain("cron_no_agent_output");
    const job = service.getCronJob("probe-empty");
    expect(job.lastRunOutput).toBeUndefined();
  });

  it("delivers stdout verbatim and stores it on lastRunOutput when non-empty", async () => {
    const realtime = vi.fn();
    const service = makeServiceWithNoAgent({
      realtime,
      runner: async () => ({ stdout: "alert", stderr: "", exitCode: 0, timedOut: false }),
    });
    service.createCronJob({
      jobId: "probe-alert",
      name: "probe-alert",
      action: "no_agent",
      schedule: "0 */6 * * * UTC",
      actionConfig: { noAgent: { command: "echo", args: ["alert"] } },
    });
    await service.runCronJobNow("probe-alert");
    const payloads = realtime.mock.calls
      .filter((call) => call[2]?.type === "cron_no_agent_output")
      .map((call) => call[2]);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.output).toBe("alert");
    const job = service.getCronJob("probe-alert");
    expect(job.lastRunOutput).toBe("alert");
  });

  it("reports runner failures instead of returning ok", async () => {
    const service = makeServiceWithNoAgent({
      realtime: vi.fn(),
      runner: async () => ({ stdout: "", stderr: "boom", exitCode: 2, timedOut: false }),
    });
    service.createCronJob({
      jobId: "probe-fail",
      name: "probe-fail",
      action: "no_agent",
      schedule: "0 */6 * * * UTC",
      actionConfig: { noAgent: { command: "exit", args: ["2"] } },
    });
    await expect(service.runCronJobNow("probe-fail")).rejects.toThrow("no_agent cron job failed: probe-fail");
  });
});

describe("agent_turn cron action", () => {
  it("admits runCronJobNow under a canonical token without reporting enqueue as success", async () => {
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const publishRealtime = vi.fn();
    const agentTurn = vi.fn(async () => ({
      mode: "agent_turn" as const,
      durableRunId: "durable-99",
      sessionId: "sess-cron",
      turnId: "turn-99",
      userMessageId: "message-user-99",
      assistantMessageId: "message-assistant-99",
      profilePosture: "creator_intersection" as const,
    }));
    const service = createService(db, publishRealtime, {
      cronJobs,
      handlers: { agentTurn },
      durableStatuses: { "durable-99": "running" },
    });

    const created = await service.createCronJob({
      jobId: "agent-turn-job",
      name: "Agent turn job",
      action: "agent_turn",
      schedule: "0 12 * * * UTC",
      actionConfig: { agentTurn: { prompt: "Summarize alerts", deliveryChannel: { channelKey: "telegram" } } },
    });
    expect(created.actionConfig).toEqual({
      agentTurn: {
        prompt: "Summarize alerts",
        deliveryChannel: { channelKey: "telegram" },
        deliverMode: "always",
      },
    });

    const result = await service.runCronJobNow("agent-turn-job");
    expect(result).toMatchObject({
      jobId: "agent-turn-job",
      status: "pending",
      childDurableRunId: "durable-99",
      childDurableStatus: "running",
      childTurnId: "turn-99",
      profilePosture: "creator_intersection",
    });
    expect(agentTurn).toHaveBeenCalledTimes(1);
    expect(agentTurn.mock.calls[0]?.[0]).toMatchObject({
      runId: result.runId,
      config: { prompt: "Summarize alerts" },
      cronRun: {
        runId: result.runId,
        jobId: "agent-turn-job",
        executionGeneration: 1,
      },
    });
    expect(publishRealtime).toHaveBeenCalledWith(
      "cron_job_run",
      "cron",
      expect.objectContaining({
        type: "cron_agent_turn_admitted",
        jobId: "agent-turn-job",
        durableRunId: "durable-99",
        childDurableRunId: "durable-99",
        sessionId: "sess-cron",
        turnId: "turn-99",
        childTurnId: "turn-99",
        profilePosture: "creator_intersection",
      }),
    );
    expect(cronJobs.get("agent-turn-job")?.lastRunStatus).toBeUndefined();
    const lookup = service.findCronRunById(result.runId);
    expect(lookup).toMatchObject({
      childDurableRunId: "durable-99",
      childDurableStatus: "running",
      childTurnId: "turn-99",
    });
    expect(service.listCronReviewQueue()).toEqual([]);
  });

  it("rejects creating an agent_turn job with an empty prompt", async () => {
    const service = createService(new FakeDb(), vi.fn());
    await expect(
      service.createCronJob({
        jobId: "agent-turn-empty",
        name: "Agent turn empty",
        action: "agent_turn",
        schedule: "0 12 * * * UTC",
        actionConfig: { agentTurn: { prompt: "   " } },
      }),
    ).rejects.toThrow("non-empty actionConfig.agentTurn.prompt");
  });

  it("includes due agent_turn jobs in the scheduled due-scan", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:03:00.000Z"));
    const cronJobs = new FakeCronJobs();
    const agentTurn = vi.fn(async () => ({
      mode: "agent_turn" as const,
      durableRunId: "durable-due",
      sessionId: "session-due",
      turnId: "turn-due",
      userMessageId: "message-user-due",
      assistantMessageId: "message-assistant-due",
    }));
    const service = createService(new FakeDb(), vi.fn(), { cronJobs, handlers: { agentTurn } });
    cronJobs.upsert(
      buildTaskJob({
        jobId: "agent-turn-due",
        action: "agent_turn",
        schedule: "0 12 * * * UTC",
        actionConfig: { agentTurn: { prompt: "Run me", deliverMode: "always" } },
      }),
    );

    let summary;
    try {
      summary = await service.runDueTaskCronJobs(new Date("2026-05-15T12:03:00.000Z"));
    } finally {
      vi.useRealTimers();
    }

    expect(summary).toMatchObject({ dueCount: 1, ranCount: 0, pendingCount: 1 });
    expect(summary.items).toContainEqual(expect.objectContaining({ jobId: "agent-turn-due", status: "pending" }));
    expect(agentTurn).toHaveBeenCalledTimes(1);
    expect(cronJobs.get("agent-turn-due")?.lastRunStatus).toBeUndefined();
  });

  it("records a review warning when an agent_turn run fails closed to inbox", async () => {
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const agentTurn = vi.fn(async () => ({
      mode: "inbox" as const,
      taskId: "task-fallback",
      profilePosture: "creator_profile_missing" as const,
      profileWarning: "creator profile missing",
    }));
    const service = createService(db, vi.fn(), { cronJobs, handlers: { agentTurn } });
    service.createCronJob({
      jobId: "agent-turn-fail-closed",
      name: "Agent turn fail closed",
      action: "agent_turn",
      schedule: "0 12 * * * UTC",
      actionConfig: { agentTurn: { prompt: "Run safely" } },
    });

    const result = await service.runCronJobNow("agent-turn-fail-closed");
    const [review] = service.listCronReviewQueue();

    expect(result).toMatchObject({ jobId: "agent-turn-fail-closed", status: "ok" });
    expect(review).toMatchObject({
      jobId: "agent-turn-fail-closed",
      runId: result.runId,
      severity: "medium",
      status: "open",
      summary: expect.objectContaining({
        trigger: "agent_turn_profile_warning",
        mode: "inbox",
        taskId: "task-fallback",
        profilePosture: "creator_profile_missing",
        warning: "creator profile missing",
      }),
      diff: { type: "agent_turn_profile_warning", changed: false },
    });
  });
});

describe("no_agent workdir forwarding", () => {
  beforeEach(() => {
    vi.stubEnv(EXPERIMENTAL_NO_AGENT_CRON_ENV, "true");
  });

  it("forwards workdir into the no_agent runner", async () => {
    const captured: Array<{ workdir?: string }> = [];
    const service = makeServiceWithNoAgent({
      realtime: vi.fn(),
      runner: async (input) => {
        captured.push({ workdir: (input as { workdir?: string }).workdir });
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      },
    });
    service.createCronJob({
      jobId: "wd-job",
      name: "Wd",
      action: "no_agent",
      schedule: "0 */6 * * * UTC",
      workdir: "/tmp/test",
      actionConfig: { noAgent: { command: "echo" } },
    });
    await service.runCronJobNow("wd-job");
    expect(captured[0]?.workdir).toBe("/tmp/test");
  });
});

describe("CronAutomationService.retryCronReviewQueueItem", () => {
  it("lists review queue items and resolves cron run diffs", () => {
    const db = new FakeDb();
    db.review.set("older", {
      item_id: "older",
      job_id: "job-1",
      run_id: "run-1",
      severity: "low",
      status: "resolved",
      summary_json: "null",
      diff_json: JSON.stringify(["not", "an", "object"]),
      created_at: "2026-03-05T00:00:00.000Z",
      updated_at: "2026-03-05T00:00:00.000Z",
      resolved_at: "2026-03-05T00:00:00.000Z",
    });
    db.review.set("newer", {
      item_id: "newer",
      job_id: "job-2",
      run_id: "run-2",
      severity: "medium",
      status: "open",
      summary_json: "{broken",
      diff_json: JSON.stringify({ changed: true }),
      created_at: "2026-03-06T00:00:00.000Z",
      updated_at: "2026-03-06T00:00:00.000Z",
      resolved_at: null,
    });
    db.diffs.set("run-2", {
      diff_id: "diff-2",
      run_id: "run-2",
      previous_run_id: "run-1",
      previousRunId: "run-1",
      diff_json: JSON.stringify({ changed: true }),
      created_at: "2026-03-06T00:00:00.000Z",
    });

    const service = createService(db);

    expect(service.listCronReviewQueue(1.5)).toEqual([
      expect.objectContaining({
        itemId: "newer",
        summary: {},
        diff: { changed: true },
      }),
    ]);
    expect(service.listCronReviewQueue(5)[1]).toMatchObject({
      itemId: "older",
      summary: {},
      diff: {},
      resolvedAt: "2026-03-05T00:00:00.000Z",
    });
    expect(service.getCronRunDiff("run-2")).toEqual({
      diffId: "diff-2",
      runId: "run-2",
      previousRunId: "run-1",
      diff: { changed: true },
      createdAt: "2026-03-06T00:00:00.000Z",
    });
    expect(() => service.getCronRunDiff("missing")).toThrow("Cron run diff not found for run missing");
  });

  it("rolls back review-item update when diff insert fails", () => {
    const db = new FakeDb();
    db.review.set("item-1", {
      item_id: "item-1",
      job_id: "job-1",
      run_id: "run-old",
      severity: "low",
      status: "open",
      summary_json: JSON.stringify({ trigger: "test" }),
      diff_json: null,
      created_at: "2026-03-05T00:00:00.000Z",
      updated_at: "2026-03-05T00:00:00.000Z",
      resolved_at: null,
    });
    db.failDiffInsert = true;

    const service = createService(db);
    expect(() => service.retryCronReviewQueueItem("missing")).toThrow("Cron review item not found: missing");
    expect(() => service.retryCronReviewQueueItem("item-1")).toThrow("cron_run_diffs unavailable");

    const row = db.review.get("item-1");
    expect(row?.status).toBe("open");
    expect(row?.run_id).toBe("run-old");
  });

  it("throws when retry update cannot reload the review item", () => {
    const db = new FakeDb();
    db.dropUpdatedReviewSelect = true;
    db.review.set("item-stale", {
      item_id: "item-stale",
      job_id: "job-1",
      run_id: "run-old",
      severity: "low",
      status: "open",
      summary_json: JSON.stringify({ trigger: "test" }),
      diff_json: null,
      created_at: "2026-03-05T00:00:00.000Z",
      updated_at: "2026-03-05T00:00:00.000Z",
      resolved_at: null,
    });

    const service = createService(db);
    expect(() => service.retryCronReviewQueueItem("item-stale")).toThrow("Cron review item retry update failed.");
  });

  it("updates item and publishes retry event on success", () => {
    const db = new FakeDb();
    const publishRealtime = vi.fn();
    db.review.set("item-2", {
      item_id: "item-2",
      job_id: "job-2",
      run_id: "run-prev",
      severity: "medium",
      status: "open",
      summary_json: JSON.stringify({ trigger: "test" }),
      diff_json: null,
      created_at: "2026-03-05T00:00:00.000Z",
      updated_at: "2026-03-05T00:00:00.000Z",
      resolved_at: null,
    });

    const service = createService(db, publishRealtime);
    const updated = service.retryCronReviewQueueItem("item-2");

    expect(updated.itemId).toBe("item-2");
    expect(updated.status).toBe("retrying");
    expect(updated.runId).not.toBe("run-prev");
    expect(db.diffs.get(updated.runId)?.previousRunId).toBe("run-prev");
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "cron",
      expect.objectContaining({
        type: "cron_review_item_retried",
        itemId: "item-2",
        runId: updated.runId,
      }),
    );
  });
});

describe("runCronJobNow returns runId", () => {
  beforeEach(() => {
    vi.stubEnv(EXPERIMENTAL_NO_AGENT_CRON_ENV, "true");
  });

  it("returns the runId for the manual run", async () => {
    const service = makeServiceWithNoAgent({
      realtime: vi.fn(),
      runner: async () => ({ stdout: "alert", stderr: "", exitCode: 0, timedOut: false }),
    });
    service.createCronJob({
      jobId: "rid-job",
      name: "Rid",
      action: "no_agent",
      schedule: "0 */6 * * * UTC",
      actionConfig: { noAgent: { command: "echo" } },
    });
    const result = await service.runCronJobNow("rid-job");
    expect(typeof result.runId).toBe("string");
    expect(result.runId.length).toBeGreaterThan(0);
    expect(result.jobId).toBe("rid-job");
    expect(result.status).toBe("ok");
  });
});

describe("findCronRunById", () => {
  beforeEach(() => {
    vi.stubEnv(EXPERIMENTAL_NO_AGENT_CRON_ENV, "true");
  });

  it("returns undefined for unknown run ids", () => {
    const service = makeServiceWithNoAgent({
      realtime: vi.fn(),
      runner: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    });
    expect(service.findCronRunById("missing-run-id")).toBeUndefined();
  });

  it("returns the job snapshot when a run id matches lastRunId", async () => {
    const service = makeServiceWithNoAgent({
      realtime: vi.fn(),
      runner: async () => ({ stdout: "alert", stderr: "", exitCode: 0, timedOut: false }),
    });
    service.createCronJob({
      jobId: "found-job",
      name: "Found",
      action: "no_agent",
      schedule: "0 */6 * * * UTC",
      actionConfig: { noAgent: { command: "echo" } },
    });
    const result = await service.runCronJobNow("found-job");
    const lookup = service.findCronRunById(result.runId);
    expect(lookup?.jobId).toBe("found-job");
    expect(lookup?.runId).toBe(result.runId);
    expect(lookup?.status).toBe("ok");
    expect(lookup?.output).toBe("alert");
  });

  it("returns failed run status and failure metadata when the last run failed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:03:00.000Z"));
    const service = makeServiceWithNoAgent({
      realtime: vi.fn(),
      runner: async () => ({ stdout: "", stderr: "boom", exitCode: 2, timedOut: false }),
    });
    service.createCronJob({
      jobId: "failed-job",
      name: "Failed",
      action: "no_agent",
      schedule: "0 */6 * * * UTC",
      actionConfig: { noAgent: { command: "exit", args: ["2"] } },
    });

    try {
      await expect(service.runCronJobNow("failed-job")).rejects.toThrow("no_agent cron job failed: failed-job");
    } finally {
      vi.useRealTimers();
    }

    const job = service.getCronJob("failed-job");
    expect(job.lastRunId).toBeDefined();
    const lookup = service.findCronRunById(job.lastRunId ?? "");
    expect(lookup).toMatchObject({
      jobId: "failed-job",
      runId: job.lastRunId,
      status: "failed",
      failure: {
        message: expect.stringContaining("no_agent cron job failed: failed-job"),
      },
      failureCount: 1,
      backoffUntil: "2026-05-15T12:04:00.000Z",
    });
  });
});
