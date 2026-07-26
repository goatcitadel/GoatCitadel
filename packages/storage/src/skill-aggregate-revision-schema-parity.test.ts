import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";

describe("skill aggregate revision schema parity", () => {
  it("keeps the SQLite-derived canonical schema and PostgreSQL forward migration aligned", () => {
    const canonicalSql = buildPostgresRuntimeSchemaSql();
    const canonicalTable = canonicalSql.match(
      /CREATE TABLE IF NOT EXISTS skill_aggregate_revisions \([\s\S]*?\n\);/,
    )?.[0];
    assert.ok(canonicalTable);
    assert.match(canonicalTable, /aggregate_kind TEXT NOT NULL/);
    assert.match(canonicalTable, /aggregate_id TEXT NOT NULL/);
    assert.match(canonicalTable, /revision BIGINT NOT NULL DEFAULT 1/);
    assert.match(canonicalTable, /created_at TEXT NOT NULL/);
    assert.match(canonicalTable, /updated_at TEXT NOT NULL/);
    assert.match(canonicalTable, /PRIMARY KEY \(aggregate_kind, aggregate_id\)/);

    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.name === "skill_aggregate_revision_cas");
    assert.equal(migration?.version, 106);
    const migrationSql = migration?.sql ?? "";
    assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS skill_aggregate_revisions \(/);
    assert.match(migrationSql, /aggregate_kind IN \('runtime_skill', 'candidate_skill', 'activation_policy'\)/);
    assert.match(
      migrationSql,
      /aggregate_id TEXT NOT NULL CHECK\([\s\S]*aggregate_id = BTRIM\(aggregate_id\)[\s\S]*char_length\(aggregate_id\) BETWEEN 1 AND 256/,
    );
    assert.match(migrationSql, /revision BIGINT NOT NULL DEFAULT 1 CHECK\(revision > 0\)/);
    assert.match(migrationSql, /PRIMARY KEY \(aggregate_kind, aggregate_id\)/);

    for (const source of ["skill_lifecycle", "skill_state", "candidate_skill_versions", "system_settings"]) {
      assert.match(migrationSql, new RegExp(`FROM ${source}`));
    }
    assert.match(migrationSql, /WHERE setting_key = 'skill_activation_policy_v1'/);
    assert.equal((migrationSql.match(/ON CONFLICT \(aggregate_kind, aggregate_id\) DO NOTHING/g) ?? []).length, 3);

    const repair = POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.name === "skill_aggregate_revision_constraint_repair",
    );
    assert.equal(repair?.version, 123);
    const repairSql = repair?.sql ?? "";
    for (const column of ["aggregate_kind", "aggregate_id", "revision", "created_at", "updated_at"]) {
      assert.match(repairSql, new RegExp(`DROP CONSTRAINT IF EXISTS skill_aggregate_revisions_${column}_check`));
      assert.match(repairSql, new RegExp(`ADD CONSTRAINT skill_aggregate_revisions_${column}_check`));
    }
    assert.match(repairSql, /aggregate_kind IN \('runtime_skill', 'candidate_skill', 'activation_policy'\)/);
    assert.match(repairSql, /aggregate_id = BTRIM\(aggregate_id\) AND char_length\(aggregate_id\) BETWEEN 1 AND 256/);
    assert.match(repairSql, /CHECK\(revision > 0\)/);
    assert.match(repairSql, /CHECK\(char_length\(BTRIM\(created_at\)\) > 0\)/);
    assert.match(repairSql, /CHECK\(char_length\(BTRIM\(updated_at\)\) > 0\)/);
  });
});
