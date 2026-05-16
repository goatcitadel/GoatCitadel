import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { CronJobRepository } from "./cron-job-repo.js";
import { StateValidationQuarantineRepository } from "./state-validation-quarantine-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepo(): CronJobRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-cron-job-repo-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new CronJobRepository(db);
}

describe("CronJobRepository", () => {
  it("reuses the existing row when a cron job is unchanged", () => {
    const repo = createRepo();
    const job = {
      jobId: "cost-report-hourly",
      name: "Cost Report Hourly",
      action: "cost_report" as const,
      description: undefined,
      schedule: "0 * * * * America/Los_Angeles",
      enabled: true,
      endAt: undefined,
      lastRunAt: "2026-03-29T10:00:00.000Z",
      nextRunAt: "2026-03-29T11:00:00.000Z",
    };

    const first = repo.upsert(job, "2026-03-29T10:30:00.000Z");
    const second = repo.upsertIfChanged(job, "2026-03-29T10:31:00.000Z");

    assert.equal(second.updatedAt, first.updatedAt);
    assert.deepEqual(repo.list(), [first]);
  });

  it("updates changed jobs, maps optional fields, deletes rows, and guards malformed adapter output", () => {
    const repo = createRepo();
    const job = {
      jobId: "daily-summary",
      name: "Daily Summary",
      action: "watchdog" as const,
      actionConfig: { watchdog: { checkId: "runtime_health" as const, notifyHomeChannel: true } },
      description: "Send a summary",
      schedule: "0 8 * * * America/Los_Angeles",
      enabled: false,
      endAt: "2026-04-01T00:00:00.000Z",
      lastRunAt: undefined,
      nextRunAt: "2026-03-30T08:00:00.000Z",
    };

    const first = repo.upsert(job, "2026-03-29T10:30:00.000Z");
    const changed = repo.upsertIfChanged(
      {
        ...job,
        enabled: true,
        lastRunAt: "2026-03-30T08:00:00.000Z",
      },
      "2026-03-30T08:01:00.000Z",
    );

    assert.equal(changed.enabled, true);
    assert.equal(changed.updatedAt, "2026-03-30T08:01:00.000Z");
    assert.deepEqual(repo.get(job.jobId)?.actionConfig, {
      watchdog: { checkId: "runtime_health", notifyHomeChannel: true },
    });
    assert.equal(repo.delete(job.jobId), true);
    assert.equal(repo.delete(job.jobId), false);
    assert.equal(repo.get(job.jobId), undefined);

    const internal = repo as unknown as {
      getStmt: { get: (...args: unknown[]) => unknown };
      listStmt: { all: (...args: unknown[]) => unknown[] };
    };
    internal.getStmt = { get: () => ({ job_id: "bad" }) };
    assert.throws(() => repo.get("bad-job"), /cron_jobs query returned an unexpected row shape/);

    internal.listStmt = { all: () => [null] };
    assert.throws(() => repo.list(), /cron_jobs query returned an unexpected row shape/);

    assert.equal(first.updatedAt, "2026-03-29T10:30:00.000Z");
  });
});

describe("CronJobRepository sanitization", () => {
  it("quarantines a cron job whose action_config_json is malformed and falls back to undefined", () => {
    const dbPath = path.join(os.tmpdir(), `gc-cron-sanitize-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const quarantine = new StateValidationQuarantineRepository(db);
    const repo = new CronJobRepository(db, { quarantine });

    const cron = repo.upsert({
      jobId: `sanitize-test-${randomUUID()}`,
      name: "Sanitize Test",
      action: "watchdog" as const,
      actionConfig: { watchdog: { checkId: "runtime_health" as const, notifyHomeChannel: false } },
      description: undefined,
      schedule: "0 * * * * America/Los_Angeles",
      enabled: true,
      endAt: undefined,
      lastRunAt: undefined,
      nextRunAt: undefined,
    });

    db.prepare("UPDATE cron_jobs SET action_config_json = ? WHERE job_id = ?").run("{not json", cron.jobId);

    const reloaded = repo.get(cron.jobId);
    assert.ok(reloaded);
    assert.equal(reloaded.actionConfig, undefined);
    assert.equal(quarantine.count(), 1);
    const entry0 = quarantine.list(10)[0];
    assert.ok(entry0);
    assert.equal(entry0.store, "cron_job.action_config");
    assert.equal(entry0.rowId, cron.jobId);
    assert.match(entry0.schemaError, /json_parse|schema/);
  });
});

describe("CronJobRepository workdir/contextFrom/lastRunOutput/lastRunId", () => {
  it("persists and reads new columns", () => {
    const repo = createRepo();
    const saved = repo.upsert({
      jobId: "probe",
      name: "Probe",
      action: "no_agent" as const,
      actionConfig: { noAgent: { command: "echo", args: ["alert"] } },
      schedule: "*/5 * * * *",
      enabled: true,
      workdir: "/tmp/test",
      contextFrom: "upstream",
      lastRunOutput: "alert",
      lastRunId: "run-1",
    });
    const reloaded = repo.get("probe");
    assert.equal(reloaded?.workdir, "/tmp/test");
    assert.equal(reloaded?.contextFrom, "upstream");
    assert.equal(reloaded?.lastRunOutput, "alert");
    assert.equal(reloaded?.lastRunId, "run-1");
    assert.equal(reloaded?.action, "no_agent");
    assert.equal(saved.workdir, "/tmp/test");
  });
});
