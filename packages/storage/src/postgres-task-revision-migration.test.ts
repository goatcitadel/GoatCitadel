import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";

describe("Postgres task resource revision parity", () => {
  it("keeps the generated canonical schema and forward migration aligned", () => {
    const canonicalSql = buildPostgresRuntimeSchemaSql();
    assert.match(canonicalSql, /CREATE TABLE IF NOT EXISTS tasks \([\s\S]*revision BIGINT NOT NULL DEFAULT 1/);

    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.name === "task_resource_revision_cas");
    assert.equal(migration?.version, 90);
    assert.match(migration?.sql ?? "", /ALTER TABLE tasks[\s\S]*revision BIGINT NOT NULL DEFAULT 1/);
  });
});
