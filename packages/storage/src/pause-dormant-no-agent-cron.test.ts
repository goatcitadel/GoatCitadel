import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CronJobRecord } from "@goatcitadel/contracts";
import { CronJobRepository } from "./cron-job-repo.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import {
  PAUSE_DORMANT_NO_AGENT_CRON_JOBS_POSTGRES_SQL,
  PAUSE_DORMANT_NO_AGENT_CRON_JOBS_SQLITE_SQL,
} from "./pause-dormant-no-agent-cron.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function noAgentJob(jobId: string, overrides: Partial<CronJobRecord> = {}): CronJobRecord {
  return {
    jobId,
    revision: 1,
    name: jobId,
    action: "no_agent",
    actionConfig: { noAgent: { command: "node", args: ["-e", "0"] } },
    schedule: "0 8 * * *",
    enabled: true,
    ...overrides,
  };
}

describe("pause_dormant_no_agent_cron_jobs migration", () => {
  it("pauses only enabled no_agent jobs that never ran when v267 upgrades the ledger", () => {
    const dbPath = tempDbs.path("goatcitadel-pause-dormant-no-agent");
    const before = tempDbs.open({ dbPath });
    const seed = new CronJobRepository(before);
    seed.upsert(noAgentJob("dormant"));
    seed.upsert(
      noAgentJob("already-ran", { lastRunAt: "2026-10-01T00:00:00.000Z", lastRunId: "run-1", lastRunStatus: "ok" }),
    );
    seed.upsert(noAgentJob("disabled", { enabled: false }));
    seed.upsert({ ...noAgentJob("agent-task"), action: "task", actionConfig: undefined });
    // Simulate an install whose ledger predates v267.
    before.prepare("DELETE FROM schema_migrations WHERE version >= 267").run();
    before.close();

    const repo = new CronJobRepository(tempDbs.open({ dbPath }));
    const dormant = repo.get("dormant");
    assert.equal(dormant?.enabled, false);
    assert.equal(dormant?.revision, 2, "the pause bumps the CAS revision");
    assert.equal(repo.get("already-ran")?.enabled, true);
    assert.equal(repo.get("already-ran")?.revision, 1);
    assert.equal(repo.get("disabled")?.enabled, false);
    assert.equal(repo.get("disabled")?.revision, 1);
    assert.equal(repo.get("agent-task")?.enabled, true);
  });

  it("registers the same predicate for Postgres with a pinned integrity hash", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.name === "pause_dormant_no_agent_cron_jobs");
    assert.ok(migration);
    assert.equal(migration.sql, PAUSE_DORMANT_NO_AGENT_CRON_JOBS_POSTGRES_SQL);
    assert.match(migration.integritySha256 ?? "", /^[0-9a-f]{64}$/u);
    const predicate = (sql: string) => sql.slice(sql.indexOf("WHERE"));
    assert.equal(
      predicate(PAUSE_DORMANT_NO_AGENT_CRON_JOBS_POSTGRES_SQL),
      predicate(PAUSE_DORMANT_NO_AGENT_CRON_JOBS_SQLITE_SQL),
    );
  });
});
