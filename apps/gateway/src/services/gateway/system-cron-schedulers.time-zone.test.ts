import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronJobRecord } from "@goatcitadel/contracts";
import { toWeekKeyForTimezone } from "../improvement-replay.js";
import {
  runMemoryConsolidationSchedulerIfDue,
  runPrivateBetaBackupSchedulerIfDue,
  type SystemCronSchedulerDeps,
} from "./system-cron-schedulers.js";

// 2026-10-11 02:31 UTC is Sunday in UTC but still Saturday 19:31 in Los Angeles.
const SUNDAY_0231_UTC = new Date("2026-10-11T02:31:00.000Z");

function createDeps(schedule: string) {
  const job = { jobId: "system-job", name: "System Job", enabled: true, schedule, failureCount: 0 } as CronJobRecord;
  const settings = new Map<string, string>();
  const createBackup = vi.fn(async (input: { name: string }) => ({
    backupId: "backup-1",
    outputPath: `/backups/${input.name}.zip`,
    bytes: 1,
  }));
  const runMemoryConsolidation = vi.fn(async () => ({ status: "completed" }));
  const deps = {
    storage: {
      cronJobs: {
        get: vi.fn(async () => job),
        mergeRuntimeTelemetry: vi.fn(async () => job),
      },
      systemSettings: {
        get: vi.fn(async (key: string) => (settings.has(key) ? { value: settings.get(key) } : undefined)),
        set: vi.fn(async (key: string, value: string) => {
          settings.set(key, value);
        }),
      },
    },
    rootDir: "/goatcitadel",
    isFeatureEnabled: vi.fn(async (flag: string) => flag !== "autonomyV1Disabled" && flag !== "cronEvidenceV1Enabled"),
    publishRealtime: vi.fn(async () => undefined),
    recordDevDiagnostic: vi.fn(),
    createBackup,
    pruneRetention: vi.fn(async () => undefined),
    runMemoryConsolidation,
    memoryLifecycle: {},
    recordCronReviewItem: vi.fn(async () => undefined),
  } as unknown as SystemCronSchedulerDeps;
  return { deps, settings, createBackup, runMemoryConsolidation };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("system cron schedulers follow the schedule's timezone", () => {
  it("dates the daily backup and its dedup key in the zone the schedule names", async () => {
    vi.useFakeTimers({ now: SUNDAY_0231_UTC });
    const { deps, settings, createBackup } = createDeps("30 2 * * * UTC");

    await runPrivateBetaBackupSchedulerIfDue(deps);

    expect(createBackup).toHaveBeenCalledWith({ name: "private-beta-20261011" });
    expect(settings.get("private_beta_backup_last_day_key_v1")).toBe("2026-10-11");
  });

  it("does not fire a Pacific-zoned backup at 02:30 UTC", async () => {
    vi.useFakeTimers({ now: SUNDAY_0231_UTC });
    const { deps, createBackup } = createDeps("30 2 * * * America/Los_Angeles");

    await runPrivateBetaBackupSchedulerIfDue(deps);

    expect(createBackup).not.toHaveBeenCalled();
  });

  it("opens the weekly consolidation window on Sunday 02:00 in the schedule's zone", async () => {
    vi.useFakeTimers({ now: SUNDAY_0231_UTC });
    const utc = createDeps("30 2 * * 0 UTC");
    const pacific = createDeps("30 2 * * 0 America/Los_Angeles");

    await runMemoryConsolidationSchedulerIfDue(utc.deps);
    await runMemoryConsolidationSchedulerIfDue(pacific.deps);

    expect(utc.runMemoryConsolidation).toHaveBeenCalledTimes(1);
    expect(utc.settings.get("memory_consolidation_weekly_last_week_key_v1")).toBe(
      toWeekKeyForTimezone(SUNDAY_0231_UTC, "UTC"),
    );
    expect(pacific.runMemoryConsolidation).not.toHaveBeenCalled();
  });
});
