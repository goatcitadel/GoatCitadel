import { describe, expect, it, vi } from "vitest";
import type { CronJobRecord } from "@goatcitadel/contracts";
import {
  COST_REPORT_HOURLY_JOB_ID,
  MEMORY_FLUSH_DAILY_JOB_ID,
  PRIVATE_BETA_BACKUP_JOB_ID,
  UPDATE_REVIEW_DAILY_JOB_ID,
} from "./cron-job-ids.js";
import {
  runCostReportSchedulerIfDue,
  runMemoryFlushSchedulerIfDue,
  runPrivateBetaBackupSchedulerIfDue,
  runUpdateReviewSchedulerIfDue,
  type SystemCronSchedulerDeps,
} from "./system-cron-schedulers.js";

// CronAutomation owns cadence and telemetry; each scheduler must report what it actually did.
const CRON_HANDLER_OPTIONS = { force: true, recordCronState: false } as const;

function createDeps(job?: Partial<CronJobRecord>) {
  const record = job
    ? ({ name: "system job", schedule: "0 2 * * * UTC", enabled: true, ...job } as CronJobRecord)
    : undefined;
  const createBackup = vi.fn(async () => ({ backupId: "backup-1", outputPath: "/backups/b1.zip", bytes: 42 }));
  const deps = {
    storage: {
      cronJobs: { get: vi.fn(async () => record), upsert: vi.fn() },
      systemSettings: { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) },
    },
    isFeatureEnabled: vi.fn(async () => false),
    publishRealtime: vi.fn(async () => undefined),
    createBackup,
    pruneRetention: vi.fn(async () => undefined),
  } as unknown as SystemCronSchedulerDeps;
  return { deps, createBackup };
}

describe("system cron scheduler outcomes", () => {
  it.each([
    ["backup", runPrivateBetaBackupSchedulerIfDue],
    ["memory flush", runMemoryFlushSchedulerIfDue],
    ["cost report", runCostReportSchedulerIfDue],
    ["update review", runUpdateReviewSchedulerIfDue],
  ] as const)("reports a missing %s job as a skip instead of returning silently", async (_name, run) => {
    const { deps } = createDeps();

    await expect(run(deps, CRON_HANDLER_OPTIONS)).resolves.toEqual({ status: "skipped", reason: "job_disabled" });
  });

  it.each([
    ["backup", runPrivateBetaBackupSchedulerIfDue, PRIVATE_BETA_BACKUP_JOB_ID],
    ["memory flush", runMemoryFlushSchedulerIfDue, MEMORY_FLUSH_DAILY_JOB_ID],
    ["cost report", runCostReportSchedulerIfDue, COST_REPORT_HOURLY_JOB_ID],
    ["update review", runUpdateReviewSchedulerIfDue, UPDATE_REVIEW_DAILY_JOB_ID],
  ] as const)("reports a disabled %s job as a skip", async (_name, run, jobId) => {
    const { deps } = createDeps({ jobId, enabled: false });

    await expect(run(deps, CRON_HANDLER_OPTIONS)).resolves.toEqual({ status: "skipped", reason: "job_disabled" });
  });

  it("reports a backed-off job as a skip on the unforced cadence path", async () => {
    const { deps } = createDeps({ jobId: COST_REPORT_HOURLY_JOB_ID, backoffUntil: "2099-01-01T00:00:00.000Z" });

    await expect(runCostReportSchedulerIfDue(deps, { recordCronState: false })).resolves.toEqual({
      status: "skipped",
      reason: "backed_off",
    });
  });

  it("reports a completed backup with its summary", async () => {
    const { deps, createBackup } = createDeps({ jobId: PRIVATE_BETA_BACKUP_JOB_ID });

    await expect(runPrivateBetaBackupSchedulerIfDue(deps, CRON_HANDLER_OPTIONS)).resolves.toEqual({
      status: "completed",
      summary: { type: "private_beta_daily_backup", backupId: "backup-1", bytes: 42 },
    });
    expect(createBackup).toHaveBeenCalledTimes(1);
  });
});
