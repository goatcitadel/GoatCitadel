import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { CronJobRecord } from "@goatcitadel/contracts";
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
      // ignore cleanup noise
    }
  }
});

function createRepoWithDb(): { repo: CronJobRepository; db: ReturnType<typeof createDatabase> } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-cron-citadel-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { repo: new CronJobRepository(db), db };
}

function makeJob(jobId: string): CronJobRecord {
  return { jobId, name: jobId, action: "task", schedule: "0 8 * * *", enabled: true };
}

describe("CronJobRepository citadel scoping", () => {
  it("lists a citadel's jobs plus global (unscoped) jobs", () => {
    const { repo, db } = createRepoWithDb();
    repo.upsert(makeJob("a"));
    repo.upsert(makeJob("b"));
    repo.upsert(makeJob("global"));
    db.prepare("UPDATE cron_jobs SET citadel_id = @citadelId WHERE job_id = @jobId").run({ citadelId: "ws-a", jobId: "a" });
    db.prepare("UPDATE cron_jobs SET citadel_id = @citadelId WHERE job_id = @jobId").run({ citadelId: "ws-b", jobId: "b" });

    const scoped = repo.listByCitadel("ws-a");
    assert.deepEqual(
      scoped.map((job) => job.jobId).sort(),
      ["a", "global"],
    );

    // Unscoped list still returns everything.
    assert.equal(repo.list().length, 3);
  });
});
