import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { CronJobRepository } from "./cron-job-repo.js";

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
      schedule: "0 * * * * America/Los_Angeles",
      enabled: true,
      lastRunAt: "2026-03-29T10:00:00.000Z",
      nextRunAt: "2026-03-29T11:00:00.000Z",
    };

    const first = repo.upsert(job, "2026-03-29T10:30:00.000Z");
    const second = repo.upsertIfChanged(job, "2026-03-29T10:31:00.000Z");

    assert.equal(second.updatedAt, first.updatedAt);
    assert.deepEqual(repo.list(), [first]);
  });
});
