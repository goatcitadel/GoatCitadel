import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";
import { createSqliteSchemaBlueprint } from "./sqlite.js";

const RECOVERY_COLUMNS = [
  "execution_generation",
  "execution_phase",
  "recovery_disposition",
  "execution_boundary_crossed_at",
  "interrupted_at",
  "interruption_reason",
  "final_transcript_event_id",
  "final_transcript_enqueued_at",
] as const;

describe("Code Mode interruption recovery schema parity", () => {
  it("keeps the live SQLite and generated Postgres schemas aligned", () => {
    const blueprint = createSqliteSchemaBlueprint();
    const runs = blueprint.tables.find((table) => table.name === "code_mode_runs");
    assert.ok(runs);
    for (const column of RECOVERY_COLUMNS) {
      assert.ok(
        runs.columns.some((candidate) => candidate.name === column),
        `missing SQLite ${column}`,
      );
    }
    assert.ok(
      runs.indexes.some((index) => index.name === "idx_code_mode_runs_pending_final_transcript"),
      "missing SQLite pending final transcript index",
    );

    const postgresRuntimeSql = buildPostgresRuntimeSchemaSql();
    assert.match(postgresRuntimeSql, /execution_generation BIGINT NOT NULL DEFAULT 0/);
    assert.match(postgresRuntimeSql, /execution_phase TEXT NOT NULL DEFAULT 'legacy_unknown'/);
    assert.match(postgresRuntimeSql, /recovery_disposition TEXT NOT NULL DEFAULT 'none'/);
    assert.match(postgresRuntimeSql, /final_transcript_event_id TEXT/);
    assert.match(postgresRuntimeSql, /idx_code_mode_runs_pending_final_transcript/);
  });

  it("provides paired forward migrations for existing runtimes", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 95);
    assert.equal(migration?.name, "code_mode_interruption_recovery");
    assert.match(migration?.sql ?? "", /ADD COLUMN IF NOT EXISTS execution_generation BIGINT NOT NULL DEFAULT 0/);
    assert.match(migration?.sql ?? "", /WHEN status = 'running' THEN 'manual_reconciliation'/);
    assert.match(migration?.sql ?? "", /'code-mode-final:' \|\| run_id/);
    assert.match(migration?.sql ?? "", /idx_code_mode_runs_pending_final_transcript/);
  });
});
