import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";
import { createSqliteSchemaBlueprint } from "./sqlite.js";

describe("Code Mode verification ledger schema parity", () => {
  it("keeps the live SQLite and generated Postgres schemas aligned", () => {
    const blueprint = createSqliteSchemaBlueprint();
    const runs = blueprint.tables.find((table) => table.name === "code_mode_runs");
    const evidence = blueprint.tables.find((table) => table.name === "code_mode_verification_evidence");
    assert.ok(runs);
    assert.ok(evidence);
    for (const column of [
      "trusted_code_write_verification_json",
      "verification_status",
      "verification_evidence_id",
      "verification_subject_hash",
      "verification_reason",
      "verification_updated_at",
    ]) {
      assert.ok(
        runs.columns.some((candidate) => candidate.name === column),
        `missing SQLite ${column}`,
      );
    }
    assert.ok(evidence.columns.some((column) => column.name === "evidence_json"));
    assert.equal(
      evidence.indexes.find((index) => index.name === "idx_code_mode_verification_evidence_run")?.unique,
      false,
    );

    const postgresRuntimeSql = buildPostgresRuntimeSchemaSql();
    assert.match(postgresRuntimeSql, /trusted_code_write_verification_json TEXT/);
    assert.match(postgresRuntimeSql, /verification_status TEXT NOT NULL DEFAULT 'not_applicable'/);
    assert.match(postgresRuntimeSql, /CREATE TABLE IF NOT EXISTS code_mode_verification_evidence/);
    assert.match(postgresRuntimeSql, /sequence BIGSERIAL PRIMARY KEY/);
    assert.match(postgresRuntimeSql, /idx_code_mode_verification_evidence_run/);
  });

  it("provides forward Postgres migration 93 for existing runtimes", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 93);
    assert.equal(migration?.name, "code_mode_verification_ledger");
    assert.match(migration?.sql ?? "", /ALTER TABLE code_mode_runs/);
    assert.match(migration?.sql ?? "", /ADD COLUMN IF NOT EXISTS trusted_code_write_verification_json TEXT/);
    assert.match(migration?.sql ?? "", /WHEN status = 'completed' THEN 'completed_unverified'/);
    assert.match(migration?.sql ?? "", /CREATE TABLE IF NOT EXISTS code_mode_verification_evidence/);
    assert.match(migration?.sql ?? "", /code_mode_verification_evidence is append-only/);
    assert.doesNotMatch(migration?.sql ?? "", /DELETE FROM code_mode_verification_evidence/);
  });
});
