import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createSqliteSchemaBlueprint } from "./sqlite.js";

describe("model council recovery schema parity", () => {
  it("pairs forward-only SQLite 160 with PostgreSQL 102 and preserves the Assembly owner", () => {
    const sqlite = createSqliteSchemaBlueprint();
    const table = sqlite.tables.find((candidate) => candidate.name === "assembly_runs");
    assert.ok(table);
    for (const column of [
      "source_turn_id",
      "run_kind",
      "generation",
      "lease_owner_id",
      "lease_expires_at",
      "council_resolution_json",
      "council_evidence_json",
    ]) {
      assert.ok(
        table.columns.some((candidate) => candidate.name === column),
        `missing SQLite ${column}`,
      );
    }

    const postgres = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 102);
    assert.equal(postgres?.name, "assembly_model_council_recovery");
    const sql = postgres?.sql ?? "";
    assert.match(sql, /ALTER TABLE assembly_runs/u);
    assert.match(sql, /run_kind IN \('assembly', 'chat_model_council'\)/u);
    assert.match(sql, /generation >= 0/u);
    assert.match(sql, /idx_assembly_runs_council_source_turn/u);
    assert.match(sql, /idx_assembly_runs_council_lease/u);
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|UPDATE assembly_runs/u);
  });
});
