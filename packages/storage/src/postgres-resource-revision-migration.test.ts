import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";

describe("Postgres operator resource revision parity", () => {
  it("keeps the generated canonical schema and forward migration aligned", () => {
    const canonicalSql = buildPostgresRuntimeSchemaSql();
    assert.match(canonicalSql, /CREATE TABLE IF NOT EXISTS workspaces \([\s\S]*revision BIGINT NOT NULL DEFAULT 1/);
    assert.match(canonicalSql, /CREATE TABLE IF NOT EXISTS chat_projects \([\s\S]*revision BIGINT NOT NULL DEFAULT 1/);

    const migration = POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.name === "operator_resource_revision_cas_foundation",
    );
    assert.equal(migration?.version, 87);
    assert.match(migration?.sql ?? "", /ALTER TABLE workspaces[\s\S]*revision BIGINT NOT NULL DEFAULT 1/);
    assert.match(migration?.sql ?? "", /ALTER TABLE chat_projects[\s\S]*revision BIGINT NOT NULL DEFAULT 1/);
  });
});
