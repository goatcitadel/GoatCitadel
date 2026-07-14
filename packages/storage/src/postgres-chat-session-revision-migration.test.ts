import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";

describe("Postgres Chat session aggregate revision parity", () => {
  it("keeps the generated canonical schema and forward migration aligned", () => {
    const canonicalSql = buildPostgresRuntimeSchemaSql();
    assert.match(
      canonicalSql,
      /CREATE TABLE IF NOT EXISTS chat_session_meta \([\s\S]*revision BIGINT NOT NULL DEFAULT 1/,
    );

    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.name === "chat_session_aggregate_revision_cas");
    assert.equal(migration?.version, 88);
    assert.match(migration?.sql ?? "", /ALTER TABLE chat_session_meta[\s\S]*revision BIGINT NOT NULL DEFAULT 1/);
  });
});
