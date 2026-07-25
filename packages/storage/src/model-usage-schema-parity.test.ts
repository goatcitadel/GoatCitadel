import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";
import { createSqliteSchemaBlueprint, type SqliteSchemaColumnBlueprint } from "./sqlite.js";

const REQUIRED_NULLABLE_USAGE_COLUMNS = ["input_tokens", "output_tokens", "cached_input_tokens", "cost_usd"];

describe("model usage schema parity", () => {
  it("pairs HX-414 output-cap receipts in additive SQLite 163 and PostgreSQL 105", () => {
    const required = [
      "requested_output_token_cap",
      "effective_output_token_cap",
      "output_cap_disposition",
      "output_cap_recovery_source_event_id",
      "output_cap_recovery_reason_code",
      "output_cap_provider_available_tokens",
      "output_cap_provider_minimum_tokens",
      "output_cap_request_input_estimate",
      "output_cap_configured_context_window_tokens",
      "output_cap_safety_margin_tokens",
      "output_cap_evidence_format",
      "transport_retry_parent_event_id",
      "transport_retry_reason",
    ];
    const sqlite = createSqliteSchemaBlueprint();
    const table = sqlite.tables.find((candidate) => candidate.name === "model_usage_events");
    assert.ok(table);
    for (const column of required) {
      assert.ok(
        table.columns.some((candidate) => candidate.name === column),
        `missing SQLite ${column}`,
      );
    }
    const postgresMigration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 105);
    assert.equal(postgresMigration?.name, "context_pressure_recovery_truth");
    for (const column of required) assert.match(postgresMigration?.sql ?? "", new RegExp(column, "u"));
    assert.match(
      postgresMigration?.sql ?? "",
      /output_cap_disposition IN \('initial', 'preserved_retry', 'reduced_retry'\)/u,
    );
    assert.match(postgresMigration?.sql ?? "", /model_usage_events_cap_retry_lineage_check/u);
    assert.match(postgresMigration?.sql ?? "", /idx_model_usage_events_transport_retry_parent/u);
  });

  it("pairs additive SQLite 158 with PostgreSQL 100 and does not backfill legacy cost rows", () => {
    const sqlite = createSqliteSchemaBlueprint();
    const table = sqlite.tables.find((candidate) => candidate.name === "model_usage_events");
    assert.ok(table);
    for (const column of REQUIRED_NULLABLE_USAGE_COLUMNS) {
      const definition: SqliteSchemaColumnBlueprint | undefined = table.columns.find(
        (candidate: SqliteSchemaColumnBlueprint) => candidate.name === column,
      );
      assert.ok(definition, `missing SQLite ${column}`);
      assert.equal(definition.notNull, false, `${column} must preserve unknown as NULL`);
    }
    assert.ok(table.columns.some((column) => column.name === "dispatch_generation" && column.notNull));
    assert.ok(table.columns.some((column) => column.name === "transport_attempt_index" && column.notNull));
    for (const column of [
      "requested_reasoning_level",
      "dispatched_reasoning_effort",
      "reasoning_disposition",
      "reasoning_reason_code",
      "dispatch_reconciled_by",
    ]) {
      assert.ok(
        table.columns.some((candidate) => candidate.name === column),
        `missing SQLite ${column}`,
      );
    }

    const postgresMigration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 100);
    assert.equal(postgresMigration?.name, "model_usage_events");
    assert.match(postgresMigration?.sql ?? "", /CREATE TABLE IF NOT EXISTS model_usage_events/u);
    assert.doesNotMatch(postgresMigration?.sql ?? "", /INSERT INTO model_usage_events|UPDATE model_usage_events/u);
    assert.doesNotMatch(postgresMigration?.sql ?? "", /SELECT.+FROM cost_ledger/isu);

    const postgres = buildPostgresRuntimeSchemaSql();
    assert.match(postgres, /CREATE TABLE IF NOT EXISTS model_usage_events/u);
    assert.match(postgres, /dispatch_generation TEXT NOT NULL/u);
    assert.match(postgres, /canonical_usage_event_id TEXT/u);
    assert.match(
      postgresMigration?.sql ?? "",
      /credential_type IN \('api_key', 'oauth', 'service_account', 'adc', 'unknown'\)/u,
    );
    assert.match(
      postgresMigration?.sql ?? "",
      /credential_source IN \('inline', 'env', 'keychain', 'oauth', 'adc', 'none', 'unknown'\)/u,
    );
    assert.match(postgresMigration?.sql ?? "", /reasoning_disposition IS NULL OR reasoning_disposition IN/u);
    assert.match(postgres, /dispatch_reconciled_by TEXT/u);
  });
});
