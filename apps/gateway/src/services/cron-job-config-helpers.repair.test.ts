import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadCronJobsFromConfig, type CronJobConfigHost } from "./cron-job-config-helpers.js";

function buildHost(rootDir: string, reconcileSpec: ReturnType<typeof vi.fn>): CronJobConfigHost {
  return {
    config: { rootDir },
    storage: {
      cronJobs: {
        get: () => undefined,
      } as never,
    } as never,
    cronConfigGenerationOwner: {
      reconcileSpec,
    },
  };
}

async function writeConfig(rootDir: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "config", "cron-jobs.json"), JSON.stringify(payload), "utf8");
}

describe("loadCronJobsFromConfig — repair + tolerance", () => {
  it("skips malformed rows and still hydrates valid rows (does not throw)", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "cron-malformed-"));
    const valid = {
      jobId: "valid-job",
      name: "Valid",
      action: "task",
      schedule: "0 9 * * *",
      enabled: true,
    };
    // Multiple malformed shapes that the loader must tolerate without throwing:
    // - empty jobId
    // - non-string name with numeric jobId (no schedule)
    // - null entry
    // - missing schedule
    // - non-object entry
    const malformedRows: unknown[] = [
      { jobId: "", name: "no-id", action: "task", schedule: "0 9 * * *", enabled: true },
      { jobId: 42, name: 42 },
      null,
      { jobId: "no-schedule", name: "No Schedule", action: "task", enabled: true },
      "not-an-object",
    ];
    await writeConfig(rootDir, { jobs: [...malformedRows, valid] });

    const upsert = vi.fn();
    const host = buildHost(rootDir, upsert);

    await expect(loadCronJobsFromConfig(host)).resolves.toBeUndefined();

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[0]?.jobId).toBe("valid-job");
  });

  it("does not throw when the cron config file is unparseable JSON", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "cron-bad-json-"));
    await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "config", "cron-jobs.json"), "{ not json", "utf8");

    const upsert = vi.fn();
    const host = buildHost(rootDir, upsert);

    await expect(loadCronJobsFromConfig(host)).resolves.toBeUndefined();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("emits a structured warning to stderr when JSON parsing fails", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "cron-bad-json-warn-"));
    await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "config", "cron-jobs.json"), "{ not json", "utf8");

    const upsert = vi.fn();
    const host = buildHost(rootDir, upsert);

    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });

    try {
      await loadCronJobsFromConfig(host);
    } finally {
      stderrSpy.mockRestore();
    }

    const warning = stderrLines.find((line) => line.includes("is not valid JSON"));
    expect(warning).toBeDefined();
    const parsed = JSON.parse(warning!) as { level: string; msg: string; component: string };
    expect(parsed.level).toBe("warn");
    expect(parsed.component).toBe("core:cron-job-config-helpers");
    expect(parsed.msg).toMatch(/not valid JSON/);
  });

  it("ignores non-array payloads (neither array nor { jobs: [] })", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "cron-shape-"));
    await writeConfig(rootDir, { jobs: "not an array" });

    const upsert = vi.fn();
    const host = buildHost(rootDir, upsert);

    await expect(loadCronJobsFromConfig(host)).resolves.toBeUndefined();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("drops stale legacy nextRunAt telemetry from the canonical spec", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "cron-stale-"));
    // schedule = every day at 09:00 UTC; persisted nextRunAt is far in the past.
    const stale = {
      jobId: "daily-report",
      name: "Daily Report",
      action: "task",
      schedule: "0 9 * * *",
      enabled: true,
      nextRunAt: "2020-01-01T09:00:00.000Z",
    };
    await writeConfig(rootDir, { jobs: [stale] });

    const upsert = vi.fn();
    const host = buildHost(rootDir, upsert);
    await loadCronJobsFromConfig(host);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[0]).not.toHaveProperty("nextRunAt");
  });

  it("drops unparseable legacy nextRunAt telemetry from the canonical spec", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "cron-bad-next-"));
    const job = {
      jobId: "daily-bad-next",
      name: "Daily Bad Next",
      action: "task",
      schedule: "0 9 * * *",
      enabled: true,
      nextRunAt: "not-a-date",
    };
    await writeConfig(rootDir, { jobs: [job] });

    const upsert = vi.fn();
    const host = buildHost(rootDir, upsert);
    await loadCronJobsFromConfig(host);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[0]).not.toHaveProperty("nextRunAt");
  });

  it("drops future legacy nextRunAt telemetry from the canonical spec", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "cron-future-"));
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const job = {
      jobId: "daily-future",
      name: "Daily Future",
      action: "task",
      schedule: "0 9 * * *",
      enabled: true,
      nextRunAt: future,
    };
    await writeConfig(rootDir, { jobs: [job] });

    const upsert = vi.fn();
    const host = buildHost(rootDir, upsert);
    await loadCronJobsFromConfig(host);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[0]).not.toHaveProperty("nextRunAt");
  });

  it("keeps timezone-aware schedules while dropping their legacy nextRunAt telemetry", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "cron-tz-"));
    // Mirrors PRIVATE_BETA_BACKUP_SCHEDULE_LABEL shape.
    const job = {
      jobId: "private-beta-backup",
      name: "Private Beta Backup",
      action: "backup",
      schedule: "30 2 * * * America/Los_Angeles",
      enabled: true,
      nextRunAt: "2020-01-01T10:30:00.000Z",
    };
    await writeConfig(rootDir, { jobs: [job] });

    const upsert = vi.fn();
    const host = buildHost(rootDir, upsert);
    await loadCronJobsFromConfig(host);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({ schedule: "30 2 * * * America/Los_Angeles" });
    expect(upsert.mock.calls[0]?.[0]).not.toHaveProperty("nextRunAt");
  });
});
