import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";
import { createSqliteSchemaBlueprint } from "./sqlite.js";

const EFFECT_COLUMNS = [
  "effect_potential",
  "effect_disposition",
  "effect_outcome_kind",
  "effect_evidence_json",
] as const;

describe("Chat tool effect truth schema parity", () => {
  it("owns all effect columns in fresh SQLite and generated Postgres schemas", () => {
    const blueprint = createSqliteSchemaBlueprint();
    const toolRuns = blueprint.tables.find((table) => table.name === "chat_tool_runs");
    assert.ok(toolRuns);
    for (const column of EFFECT_COLUMNS) {
      assert.ok(
        toolRuns.columns.some((candidate) => candidate.name === column),
        `missing SQLite ${column}`,
      );
    }

    const postgres = buildPostgresRuntimeSchemaSql();
    for (const column of EFFECT_COLUMNS) {
      assert.match(postgres, new RegExp(`\\b${column} TEXT\\b`), `missing Postgres ${column}`);
    }
  });

  it("adds nullable columns without manufacturing legacy runtime evidence", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 99);
    assert.equal(migration?.name, "chat_tool_effect_truth");
    for (const column of EFFECT_COLUMNS) {
      assert.match(migration?.sql ?? "", new RegExp(`ADD COLUMN IF NOT EXISTS ${column} TEXT`));
    }
    assert.doesNotMatch(migration?.sql ?? "", /UPDATE chat_tool_runs/u);
    assert.doesNotMatch(migration?.sql ?? "", /legacy_or_malformed_effect_truth/u);
  });
});
