import { describe, expect, it, vi } from "vitest";
import type { CronJobRecord } from "@goatcitadel/contracts";
import type { MemoryConsolidationRunSummary } from "../memory-consolidation-service.js";
import { MEMORY_CONSOLIDATION_WEEKLY_JOB_ID } from "./cron-job-ids.js";
import {
  runMemoryConsolidationSchedulerIfDue,
  type SystemCronFeatureFlag,
  type SystemCronSchedulerDeps,
} from "./system-cron-schedulers.js";

// CronAutomation owns cadence and telemetry; the scheduler must report what it actually did.
const CRON_HANDLER_OPTIONS = { force: true, recordCronState: false } as const;

function buildSummary(status: MemoryConsolidationRunSummary["status"]): MemoryConsolidationRunSummary {
  return {
    status,
    scannedTurns: status === "completed" ? 4 : 0,
    qualifyingTurns: 0,
    sessionsSampled: 0,
    sessionsFailed: 0,
    drafted: 0,
    deduplicated: 0,
    proposed: status === "completed" ? 2 : 0,
  };
}

function createDeps(options: {
  job?: Partial<CronJobRecord>;
  flags?: Partial<Record<SystemCronFeatureFlag, boolean>>;
  summary?: MemoryConsolidationRunSummary;
}) {
  const flags: Partial<Record<SystemCronFeatureFlag, boolean>> = {
    memoryConsolidationV1Enabled: true,
    memoryLifecycleAdminV1Enabled: true,
    autonomyV1Disabled: false,
    ...options.flags,
  };
  const job = {
    jobId: MEMORY_CONSOLIDATION_WEEKLY_JOB_ID,
    name: "Memory consolidation",
    action: "memory_consolidation",
    schedule: "0 2 * * 0",
    enabled: true,
    ...options.job,
  } as CronJobRecord;
  const runMemoryConsolidation = vi.fn(async () => options.summary ?? buildSummary("completed"));
  const systemSettingSet = vi.fn(async () => undefined);
  const cronJobUpsert = vi.fn();
  const deps = {
    storage: {
      cronJobs: { get: vi.fn(async () => job), upsert: cronJobUpsert },
      systemSettings: { get: vi.fn(async () => undefined), set: systemSettingSet },
    },
    isFeatureEnabled: vi.fn(async (flag: SystemCronFeatureFlag) => flags[flag] ?? false),
    runMemoryConsolidation,
  } as unknown as SystemCronSchedulerDeps;
  return { deps, runMemoryConsolidation, systemSettingSet, cronJobUpsert };
}

describe("runMemoryConsolidationSchedulerIfDue outcome", () => {
  it("reports a flag-gated skip with the flag posture instead of returning silently", async () => {
    const { deps, runMemoryConsolidation, systemSettingSet } = createDeps({
      flags: { memoryConsolidationV1Enabled: false },
    });

    await expect(runMemoryConsolidationSchedulerIfDue(deps, CRON_HANDLER_OPTIONS)).resolves.toEqual({
      status: "skipped",
      reason: "memory_consolidation_flags_disabled",
      detail: { memoryConsolidationV1Enabled: false, memoryLifecycleAdminV1Enabled: true },
    });
    expect(runMemoryConsolidation).not.toHaveBeenCalled();
    expect(systemSettingSet).not.toHaveBeenCalled();
  });

  it("reports the autonomy kill switch as a skip", async () => {
    const { deps, runMemoryConsolidation } = createDeps({ flags: { autonomyV1Disabled: true } });

    await expect(runMemoryConsolidationSchedulerIfDue(deps, CRON_HANDLER_OPTIONS)).resolves.toEqual({
      status: "skipped",
      reason: "autonomy_kill_switch",
    });
    expect(runMemoryConsolidation).not.toHaveBeenCalled();
  });

  it("reports a disabled job as a skip", async () => {
    const { deps, runMemoryConsolidation } = createDeps({ job: { enabled: false } });

    await expect(runMemoryConsolidationSchedulerIfDue(deps, CRON_HANDLER_OPTIONS)).resolves.toEqual({
      status: "skipped",
      reason: "job_disabled",
    });
    expect(runMemoryConsolidation).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled", "memory_consolidation_flags_disabled"],
    ["skipped_kill_switch", "autonomy_kill_switch"],
  ] as const)(
    "maps a non-completed consolidation status %s to a skip without advancing the weekly dedup key",
    async (status, reason) => {
      const { deps, systemSettingSet, cronJobUpsert } = createDeps({ summary: buildSummary(status) });

      await expect(runMemoryConsolidationSchedulerIfDue(deps, CRON_HANDLER_OPTIONS)).resolves.toEqual({
        status: "skipped",
        reason,
        detail: { consolidationStatus: status, consolidation: buildSummary(status) },
      });
      expect(systemSettingSet).not.toHaveBeenCalled();
      expect(cronJobUpsert).not.toHaveBeenCalled();
    },
  );

  it("reports a kill switch that stops a run after sessions were processed as a partial completion", async () => {
    const interrupted = { ...buildSummary("skipped_kill_switch"), sessionsSampled: 1, drafted: 2, proposed: 1 };
    const { deps, systemSettingSet } = createDeps({ summary: interrupted });

    await expect(runMemoryConsolidationSchedulerIfDue(deps, CRON_HANDLER_OPTIONS)).resolves.toEqual({
      status: "completed",
      summary: interrupted,
      partial: { reason: "autonomy_kill_switch" },
    });
    expect(systemSettingSet).not.toHaveBeenCalled();
  });

  it("reports a kill-switch stop as a skip when every sampled session failed", async () => {
    const allFailed = { ...buildSummary("skipped_kill_switch"), sessionsSampled: 2, sessionsFailed: 2 };
    const { deps } = createDeps({ summary: allFailed });

    await expect(runMemoryConsolidationSchedulerIfDue(deps, CRON_HANDLER_OPTIONS)).resolves.toEqual({
      status: "skipped",
      reason: "autonomy_kill_switch",
      detail: { consolidationStatus: "skipped_kill_switch", consolidation: allFailed },
    });
  });

  it("keeps a partial completion when a sampled session drafted zero candidates", async () => {
    const zeroDrafts = { ...buildSummary("skipped_kill_switch"), sessionsSampled: 1, sessionsFailed: 0 };
    const { deps } = createDeps({ summary: zeroDrafts });

    await expect(runMemoryConsolidationSchedulerIfDue(deps, CRON_HANDLER_OPTIONS)).resolves.toMatchObject({
      status: "completed",
      partial: { reason: "autonomy_kill_switch" },
    });
  });

  it("reports a completed consolidation with its summary and leaves cron telemetry to CronAutomation", async () => {
    const { deps, runMemoryConsolidation, systemSettingSet, cronJobUpsert } = createDeps({});

    await expect(runMemoryConsolidationSchedulerIfDue(deps, CRON_HANDLER_OPTIONS)).resolves.toEqual({
      status: "completed",
      summary: buildSummary("completed"),
    });
    expect(runMemoryConsolidation).toHaveBeenCalledTimes(1);
    expect(systemSettingSet).toHaveBeenCalledTimes(1);
    expect(cronJobUpsert).not.toHaveBeenCalled();
  });
});
