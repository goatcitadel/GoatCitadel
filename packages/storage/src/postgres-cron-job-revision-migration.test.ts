import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";

describe("Postgres cron job spec revision parity", () => {
  it("keeps the generated canonical schema and forward migration aligned", () => {
    const canonicalSql = buildPostgresRuntimeSchemaSql();
    assert.match(canonicalSql, /CREATE TABLE IF NOT EXISTS cron_jobs \([\s\S]*revision BIGINT NOT NULL DEFAULT 1/);

    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.name === "cron_job_spec_revision_cas");
    assert.equal(migration?.version, 89);
    assert.match(migration?.sql ?? "", /ALTER TABLE cron_jobs[\s\S]*revision BIGINT NOT NULL DEFAULT 1/);
  });
});
