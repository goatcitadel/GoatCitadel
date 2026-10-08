import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CronJobRecord } from "@goatcitadel/contracts";
import { CronJobRepository } from "./cron-job-repo.js";
import { createDatabase } from "./sqlite.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createRepoWithDb(): { repo: CronJobRepository; db: ReturnType<typeof createDatabase> } {
  const dbPath = tempDbs.path("goatcitadel-cron-citadel");
  const db = tempDbs.open({ dbPath });
  return { repo: new CronJobRepository(db), db };
}

function makeJob(jobId: string): CronJobRecord {
  return { jobId, revision: 1, name: jobId, action: "task", schedule: "0 8 * * *", enabled: true };
}

describe("CronJobRepository citadel scoping", () => {
  it("lists a citadel's jobs plus global (unscoped) jobs", () => {
    const { repo, db } = createRepoWithDb();
    repo.upsert(makeJob("a"));
    repo.upsert(makeJob("b"));
    repo.upsert(makeJob("global"));
    db.prepare("UPDATE cron_jobs SET citadel_id = @citadelId WHERE job_id = @jobId").run({
      citadelId: "ws-a",
      jobId: "a",
    });
    db.prepare("UPDATE cron_jobs SET citadel_id = @citadelId WHERE job_id = @jobId").run({
      citadelId: "ws-b",
      jobId: "b",
    });

    const scoped = repo.listByCitadel("ws-a");
    assert.deepEqual(scoped.map((job) => job.jobId).sort(), ["a", "global"]);

    // Unscoped list still returns everything.
    assert.equal(repo.list().length, 3);
  });
});
