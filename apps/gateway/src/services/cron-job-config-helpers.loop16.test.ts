import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureCostReportCronJob,
  ensureMemoryFlushCronJob,
  ensurePrivateBetaBackupCronJob,
  ensureUpdateReviewCronJob,
  getCronJobsConfigPath,
  loadCronJobsFromConfig,
  persistCronJobsConfig,
} from "./cron-job-config-helpers.js";

const TEMP_ROOTS: string[] = [];

afterEach(async () => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("cron job config helpers", () => {
  it("returns cleanly when cron config is missing and loads legacy array payloads", async () => {
    const host = createHost(await makeRoot());

    await expect(loadCronJobsFromConfig(host)).resolves.toBeUndefined();
    expect(host.storage.runImmediateTransaction).not.toHaveBeenCalled();

    await writeFile(
      getCronJobsConfigPath(host),
      JSON.stringify([
        {
          jobId: " daily-review ",
          name: " Daily Review ",
          schedule: "0 8 * * *",
          enabled: 1,
          lastRunAt: "2026-05-01T00:00:00.000Z",
        },
      ]),
      "utf8",
    );
    const futureNextRunAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    host.storage.cronJobs.get.mockReturnValueOnce({
      jobId: "daily-review",
      action: "update_review",
      actionConfig: { mode: "full" },
      description: "Existing description",
      endAt: "2026-06-01T00:00:00.000Z",
      nextRunAt: futureNextRunAt,
      workdir: "F:/existing",
      contextFrom: "upstream-existing",
      lastRunOutput: "existing output",
      lastRunId: "run-existing",
    });

    await loadCronJobsFromConfig(host);

    expect(host.storage.runImmediateTransaction).toHaveBeenCalledTimes(1);
    expect(host.storage.cronJobs.upsertIfChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "daily-review",
        name: "Daily Review",
        action: "update_review",
        actionConfig: { mode: "full" },
        description: "Existing description",
        enabled: true,
        endAt: "2026-06-01T00:00:00.000Z",
        lastRunAt: "2026-05-01T00:00:00.000Z",
        nextRunAt: futureNextRunAt,
        schedule: "0 8 * * *",
        workdir: "F:/existing",
        contextFrom: "upstream-existing",
        lastRunOutput: "existing output",
        lastRunId: "run-existing",
      }),
    );
  });

  it("persists the cron config shape and records unified config persistence", async () => {
    const host = createHost(await makeRoot());
    host.storage.cronJobs.list.mockReturnValueOnce([
      {
        jobId: "job-1",
        name: "Job One",
        action: "task",
        actionConfig: { taskId: "task-1" },
        description: "Run a task",
        schedule: "*/15 * * * *",
        enabled: true,
        endAt: undefined,
        lastRunAt: "2026-05-01T00:00:00.000Z",
        nextRunAt: "2026-05-01T00:15:00.000Z",
        workdir: "F:/code/personal-ai",
        contextFrom: "upstream-job",
        lastRunOutput: "alert body",
        lastRunId: "run-1",
      },
    ]);

    persistCronJobsConfig(host);

    const raw = await readFile(getCronJobsConfigPath(host), "utf8");
    expect(JSON.parse(raw)).toEqual({
      jobs: [
        {
          jobId: "job-1",
          name: "Job One",
          action: "task",
          actionConfig: { taskId: "task-1" },
          description: "Run a task",
          schedule: "*/15 * * * *",
          enabled: true,
          lastRunAt: "2026-05-01T00:00:00.000Z",
          lastRunOutput: "alert body",
          lastRunId: "run-1",
          nextRunAt: "2026-05-01T00:15:00.000Z",
          workdir: "F:/code/personal-ai",
          contextFrom: "upstream-job",
        },
      ],
    });
    expect(host.persistUnifiedConfig).toHaveBeenCalledTimes(1);
  });

  it("preserves existing enabled and schedule state when ensuring built-in cron jobs", () => {
    const host = createHost("F:/tmp/goatcitadel");
    host.storage.cronJobs.get.mockImplementation((jobId: string) => ({
      jobId,
      enabled: false,
      description: `${jobId} custom description`,
      endAt: "2026-06-01T00:00:00.000Z",
      lastRunAt: "2026-05-01T00:00:00.000Z",
      nextRunAt: "2026-05-02T00:00:00.000Z",
    }));

    ensurePrivateBetaBackupCronJob(host);
    ensureMemoryFlushCronJob(host);
    ensureCostReportCronJob(host);
    ensureUpdateReviewCronJob(host);

    expect(host.storage.cronJobs.upsertIfChanged).toHaveBeenCalledTimes(4);
    for (const [record, now] of host.storage.cronJobs.upsertIfChanged.mock.calls) {
      expect(record).toEqual(
        expect.objectContaining({
          enabled: false,
          description: expect.stringContaining("custom description"),
          endAt: "2026-06-01T00:00:00.000Z",
          lastRunAt: "2026-05-01T00:00:00.000Z",
          nextRunAt: "2026-05-02T00:00:00.000Z",
        }),
      );
      expect(new Date(now as string).toString()).not.toBe("Invalid Date");
    }
  });

  it("repairs canonical actions for built-in cron job ids loaded from config", async () => {
    const host = createHost(await makeRoot());
    await writeFile(
      getCronJobsConfigPath(host),
      JSON.stringify({
        jobs: [
          {
            jobId: "self_improvement_weekly_replay",
            name: "Self-Improvement Weekly Replay",
            action: "task",
            schedule: "0 2 * * 0 America/Los_Angeles",
            enabled: false,
          },
          {
            jobId: "private_beta_backup_daily",
            name: "Private Beta Daily Backup",
            schedule: "30 2 * * * America/Los_Angeles",
            enabled: true,
          },
          {
            jobId: "memory-flush-daily",
            name: "Memory Flush Daily",
            schedule: "0 3 * * * America/Los_Angeles",
            enabled: true,
          },
          {
            jobId: "cost-report-hourly",
            name: "Cost Report Hourly",
            schedule: "0 * * * * America/Los_Angeles",
            enabled: true,
          },
          {
            jobId: "update-review-daily",
            name: "Daily Update Review",
            schedule: "15 4 * * * America/Los_Angeles",
            enabled: true,
          },
        ],
      }),
      "utf8",
    );

    await loadCronJobsFromConfig(host);

    const actionsByJobId = new Map(
      host.storage.cronJobs.upsertIfChanged.mock.calls.map(([record]) => [record.jobId, record.action]),
    );
    expect(actionsByJobId).toEqual(
      new Map([
        ["self_improvement_weekly_replay", "improvement"],
        ["private_beta_backup_daily", "backup"],
        ["memory-flush-daily", "memory_flush"],
        ["cost-report-hourly", "cost_report"],
        ["update-review-daily", "update_review"],
      ]),
    );
  });
});

async function makeRoot(): Promise<string> {
  const root = path.join(os.tmpdir(), `goatcitadel-cron-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  TEMP_ROOTS.push(root);
  await mkdir(path.join(root, "config"), { recursive: true });
  return root;
}

function createHost(rootDir: string) {
  return {
    config: { rootDir },
    storage: {
      cronJobs: {
        get: vi.fn(),
        list: vi.fn(() => []),
        upsertIfChanged: vi.fn(),
      },
      runImmediateTransaction: vi.fn((callback: () => void) => callback()),
    },
    persistUnifiedConfig: vi.fn(),
  };
}
