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

    const scoped = repo.listByCitadel({ citadelId: "ws-a", readableCitadelIds: "all" });
    assert.deepEqual(scoped.map((job) => job.jobId).sort(), ["a", "global"]);

    // Unscoped list still returns everything.
    assert.equal(repo.list().length, 3);
  });

  it("returns nothing when the access scope does not permit the citadel", () => {
    const { repo, db } = createRepoWithDb();
    repo.upsert(makeJob("a"));
    repo.upsert(makeJob("global"));
    db.prepare("UPDATE cron_jobs SET citadel_id = 'ws-a' WHERE job_id = 'a'").run();

    assert.deepEqual(repo.listByCitadel({ citadelId: "ws-a", readableCitadelIds: [] }), []);
    assert.deepEqual(repo.listByCitadel({ citadelId: "ws-a", readableCitadelIds: ["ws-b"] }), []);
    assert.deepEqual(repo.listByCitadel({ citadelId: " ", readableCitadelIds: "all" }), []);
  });

  it("never returns another citadel's jobs to a listed scope", () => {
    const { repo, db } = createRepoWithDb();
    repo.upsert(makeJob("a"));
    repo.upsert(makeJob("b"));
    repo.upsert(makeJob("global"));
    db.prepare("UPDATE cron_jobs SET citadel_id = 'ws-a' WHERE job_id = 'a'").run();
    db.prepare("UPDATE cron_jobs SET citadel_id = 'ws-b' WHERE job_id = 'b'").run();

    const jobs = repo.listByCitadel({ citadelId: "ws-a", readableCitadelIds: ["ws-a"] });
    assert.deepEqual(jobs.map((job) => job.jobId).sort(), ["a", "global"]);
  });
});
