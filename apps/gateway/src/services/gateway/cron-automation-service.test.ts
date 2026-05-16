import { describe, expect, it, vi } from "vitest";
import type { CronJobRecord } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import {
  computeNextCronRunAt,
  CronAutomationService,
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
    if (sql.includes("BEGIN IMMEDIATE")) {
      this.snapshot = {
        review: new Map([...this.review.entries()].map(([id, row]) => [id, { ...row }])),
        diffs: new Map(this.diffs),
      };
      return;
    }
    if (sql.includes("COMMIT")) {
      this.snapshot = null;
      return;
    }
    if (sql.includes("ROLLBACK")) {
      if (this.snapshot) {
        this.review = new Map(this.snapshot.review);
        this.diffs = new Map(this.snapshot.diffs);
      }
      this.snapshot = null;
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
    this.rows.set(job.jobId, { ...job });
    return this.rows.get(job.jobId) as CronJobRecord;
  }

  public delete(jobId: string): boolean {
    return this.rows.delete(jobId);
  }
}

function buildTaskJob(input: Partial<CronJobRecord> & Pick<CronJobRecord, "jobId">): CronJobRecord {
  return {
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
  } = {},
): CronAutomationService {
  const cronJobs = options.cronJobs ?? new FakeCronJobs();
  return new CronAutomationService({
    storage: { db, cronJobs } as unknown as Storage,
    persistCronJobsConfig: () => {},
    publishRealtime,
    requireFeatureEnabled: () => {},
    isFeatureEnabled: () => options.isFeatureEnabled ?? true,
    runHandlers: {
      task: async () => ({ taskId: "task-1" }),
      improvement: async () => {},
      backup: async () => {},
      memoryFlush: async () => {},
      costReport: async () => {},
      updateReview: async () => {},
      watchdog: async () => ({
        status: "ok",
        checkId: "runtime_health",
        summary: "runtime healthy",
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
    expect(() =>
      service.createCronJob({ jobId: "existing-job", name: "Existing", schedule: "0 12 * * * UTC" }),
    ).toThrow("Cron job already exists: existing-job");

    await expect(service.runCronJobNow("paused-job")).rejects.toThrow("Cron job is paused: paused-job");
    await expect(service.runCronJobNow("ended-job")).rejects.toThrow("Cron job has ended: ended-job");
    await expect(service.runCronJobNow("custom-job")).rejects.toThrow("Cron job has no runnable handler: custom-job");
  });

  it("creates, updates, pauses, and deletes non-system jobs with persisted realtime events", () => {
    const db = new FakeDb();
    const cronJobs = new FakeCronJobs();
    const publishRealtime = vi.fn();
    const service = createService(db, publishRealtime, { cronJobs });

    const created = service.createCronJob({
      jobId: "Daily_Task",
      name: " Daily task ",
      schedule: "0 12 * * * UTC",
      description: " hello ",
      workdir: "F:/code/personal-ai",
      contextFrom: "upstream",
      lastRunOutput: "previous",
      lastRunId: "run-1",
    });
    expect(created).toMatchObject({
      jobId: "daily_task",
      name: "Daily task",
      description: "hello",
      action: "task",
      enabled: true,
      workdir: "F:/code/personal-ai",
      contextFrom: "upstream",
      lastRunOutput: "previous",
      lastRunId: "run-1",
    });
    expect(created.nextRunAt).toBeDefined();

    const updated = service.updateCronJob("daily_task", {
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
      lastRunOutput: null,
      lastRunId: "run-2",
    });
    expect(updated.actionConfig).toEqual({
      watchdog: {
        checkId: "mcp_posture",
        severityThreshold: "error",
        notifyHomeChannel: true,
      },
    });
    expect(updated.workdir).toBeUndefined();
    expect(updated.contextFrom).toBe("upstream-2");
    expect(updated.lastRunOutput).toBeUndefined();
    expect(updated.lastRunId).toBe("run-2");
    expect(service.updateCronJob("daily_task", { action: "improvement" }).actionConfig).toBeUndefined();
    expect(service.setCronJobEnabled("daily_task", true).enabled).toBe(true);
    expect(service.deleteCronJob("daily_task")).toEqual({ deleted: true, jobId: "daily_task" });
    expect(() => service.deleteCronJob(UPDATE_REVIEW_DAILY_JOB_ID)).toThrow("System cron job cannot be deleted");
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "cron",
      expect.objectContaining({ type: "cron_job_created", jobId: "daily_task" }),
    );
  });

  it("runs due scheduled task jobs once per cron window and skips inactive/system jobs", async () => {
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

    expect(task).toHaveBeenCalledTimes(1);
    expect(task.mock.calls[0]?.[0]).toMatchObject({ jobId: "due-job" });
    expect(cronJobs.get("due-job")?.lastRunAt).toBeDefined();
    expect(cronJobs.get("due-job")?.nextRunAt).toMatch(/^2026-05-15T12:0[0-4]:/);
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
    };
    const service = createService(db, vi.fn(), { cronJobs, handlers });
    for (const action of ["improvement", "backup", "memory_flush", "cost_report", "update_review"] as const) {
      cronJobs.upsert(buildTaskJob({ jobId: `${action.replace("_", "-")}-job`, action }));
    }

    for (const job of cronJobs.list()) {
      await expect(service.runCronJobNow(job.jobId)).resolves.toMatchObject({ jobId: job.jobId, status: "ok" });
    }

    expect(handlers.improvement).toHaveBeenCalledTimes(1);
    expect(handlers.backup).toHaveBeenCalledTimes(1);
    expect(handlers.memoryFlush).toHaveBeenCalledTimes(1);
    expect(handlers.costReport).toHaveBeenCalledTimes(1);
    expect(handlers.updateReview).toHaveBeenCalledTimes(1);
    expect([...db.review.values()].map((row) => row.status)).toEqual([
      "resolved",
      "resolved",
      "resolved",
      "resolved",
      "resolved",
    ]);
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

      service.updateCronJob("watchdog-job", {
        actionConfig: {
          watchdog: {
            checkId: "runtime_health",
            severityThreshold: "warning",
          },
        },
      });
      await service.runCronJobNow("watchdog-job");
      expect(recordSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "watchdog-job",
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

    await service.runCronJobNow("watchdog-details");

    const [row] = [...db.review.values()];
    expect(row).toMatchObject({ job_id: "watchdog-details", severity: "high", status: "open" });
    expect(JSON.parse(row?.summary_json ?? "{}")).toMatchObject({
      trigger: "watchdog",
      checkId: "durable_dead_letters",
      details: { count: 3 },
    });

    const created = service.createCronJob({
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
  const deps: CronAutomationServiceDeps = {
    storage: { db, cronJobs } as unknown as Storage,
    persistCronJobsConfig: () => {},
    publishRealtime: opts.realtime,
    requireFeatureEnabled: () => {},
    isFeatureEnabled: () => false,
    runHandlers: {
      task: async () => ({}),
      improvement: async () => {},
      backup: async () => {},
      memoryFlush: async () => {},
      costReport: async () => {},
      updateReview: async () => {},
      watchdog: async () => ({ status: "ok", checkId: "runtime_health", summary: "ok" }),
      noAgent: opts.runner,
    },
  };
  return new CronAutomationService(deps);
}

describe("createCronJob workdir + contextFrom", () => {
  it("stores workdir and contextFrom on the persisted record", () => {
    const service = makeServiceWithNoAgent({
      realtime: vi.fn(),
      runner: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    });
    const saved = service.createCronJob({
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
    const deps: CronAutomationServiceDeps = {
      storage: { db, cronJobs: opts.cronJobs } as unknown as Storage,
      persistCronJobsConfig: () => {},
      publishRealtime: opts.realtime,
      requireFeatureEnabled: () => {},
      isFeatureEnabled: () => false,
      runHandlers: {
        task: opts.task,
        improvement: async () => {},
        backup: async () => {},
        memoryFlush: async () => {},
        costReport: async () => {},
        updateReview: async () => {},
        watchdog: async () => ({ status: "ok", checkId: "runtime_health", summary: "ok" }),
        noAgent: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
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

describe("no_agent cron action", () => {
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
});

describe("no_agent workdir forwarding", () => {
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
});
