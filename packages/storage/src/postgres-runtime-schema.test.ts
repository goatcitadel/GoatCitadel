import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SqliteSchemaTableBlueprint } from "./sqlite.js";
import { createDatabase, createSqliteSchemaBlueprint } from "./sqlite.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";
import {
  buildPostgresRuntimeSchemaSqlFromBlueprint,
  renderColumn,
  renderForeignKey,
} from "./postgres/runtime-schema.internal.js";

function table(input: Partial<SqliteSchemaTableBlueprint> & { name: string }): SqliteSchemaTableBlueprint {
  return {
    name: input.name,
    sql: input.sql ?? `CREATE TABLE ${input.name} ()`,
    columns: input.columns ?? [],
    foreignKeys: input.foreignKeys ?? [],
    indexes: input.indexes ?? [],
    seedRows: input.seedRows ?? [],
  };
}

describe("Postgres runtime schema generation", () => {
  it("preserves SQLite inline UNIQUE constraints as Postgres unique indexes", () => {
    const sql = buildPostgresRuntimeSchemaSql();

    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_message_id_unique ON chat_messages\(message_id\);/,
    );
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_key_unique ON sessions\(session_key\);/);
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_unique ON prompt_pack_benchmark_items\(benchmark_run_id, provider_id, model, test_id\);/,
    );
    assert.match(sql, /CREATE TABLE IF NOT EXISTS mutation_idempotency \(/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS external_side_effect_runs \(/);
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_external_side_effect_runs_idempotency ON external_side_effect_runs\(route_path, idempotency_key, actor_scope\);/,
    );
    assert.doesNotMatch(sql, /sqlite_autoindex_/);
  });

  it("preserves SQLite partial-index WHERE predicates on the generated Postgres schema", () => {
    const sql = buildPostgresRuntimeSchemaSql();

    // STORAGE-001: the improvement-candidate fingerprint index must stay OPEN-only on
    // Postgres. Dropping the predicate turns it into a full unique index and breaks the
    // candidate reopen/dedup flow (a new OPEN candidate sharing a CLOSED candidate's
    // fingerprint would raise an unhandled unique-constraint violation).
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_improvement_candidates_open_fingerprint ON improvement_candidates\(workspace_id, kind, fingerprint\) WHERE status IN \('proposed', 'evaluating', 'ready_for_approval', 'approval_pending', 'approved'\);/,
    );

    // The nullable comms-delivery idempotency index is partial too: without the predicate
    // multiple NULL idempotency keys would collide under the unique constraint.
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_comms_deliveries_idempotency ON comms_deliveries\(idempotency_key\) WHERE idempotency_key IS NOT NULL;/,
    );

    // Full (non-partial) unique indexes must not gain a WHERE clause.
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_key_unique ON sessions\(session_key\);/);
  });

  it("renders the improvement-candidate fingerprint index as OPEN-only and allows a closed/open fingerprint to coexist", () => {
    // DDL parity: the SQLite schema and the generated Postgres schema must carry the
    // identical partial predicate, so the unique scope is OPEN-only on both backends.
    const blueprint = createSqliteSchemaBlueprint();
    const candidatesTable = blueprint.tables.find((table) => table.name === "improvement_candidates");
    const fingerprintIndex = candidatesTable?.indexes.find(
      (index) => index.name === "idx_improvement_candidates_open_fingerprint",
    );
    assert.ok(fingerprintIndex, "expected improvement_candidates fingerprint index in the SQLite blueprint");
    assert.equal(fingerprintIndex?.unique, true);
    assert.equal(
      fingerprintIndex?.where,
      "status IN ('proposed', 'evaluating', 'ready_for_approval', 'approval_pending', 'approved')",
    );

    // Behavioral regression: under the real SQLite schema, a CLOSED candidate and a new
    // OPEN candidate that share a fingerprint must coexist (the unique index only spans
    // open statuses). This is exactly the reopen/dedup flow STORAGE-001 protects.
    const dbPath = path.join(os.tmpdir(), `goatcitadel-improvement-candidate-${randomUUID()}.db`);
    try {
      const client = createDatabase({ dbPath });
      try {
        const baseRow = {
          workspaceId: "workspace-1",
          kind: "skill_quality",
          targetKey: "skill:example",
          fingerprint: "fp-shared",
          summary: "Example candidate",
          createdAt: "2026-05-28T00:00:00.000Z",
          updatedAt: "2026-05-28T00:00:00.000Z",
        };
        const insert = client.prepare(`
          INSERT INTO improvement_candidates (
            candidate_id, workspace_id, kind, status, target_key, fingerprint, summary, created_at, updated_at
          ) VALUES (
            @candidateId, @workspaceId, @kind, @status, @targetKey, @fingerprint, @summary, @createdAt, @updatedAt
          )
        `);

        // A closed candidate followed by a new open candidate with the same fingerprint.
        insert.run({ ...baseRow, candidateId: "cand-closed", status: "rejected" });
        insert.run({ ...baseRow, candidateId: "cand-open", status: "proposed" });

        const rows = client
          .prepare(`SELECT candidate_id FROM improvement_candidates WHERE fingerprint = ? ORDER BY candidate_id`)
          .all<{ candidate_id: string }>("fp-shared");
        assert.deepEqual(
          rows.map((row) => row.candidate_id),
          ["cand-closed", "cand-open"],
        );

        // But two OPEN candidates with the same fingerprint must still collide.
        assert.throws(
          () => insert.run({ ...baseRow, candidateId: "cand-open-2", status: "evaluating" }),
          /UNIQUE constraint failed/,
        );
      } finally {
        client.close();
      }
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("repairs stale runtime schemas that applied the canonical migration before inline unique indexes were preserved", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 6);

    assert.equal(repairMigration?.name, "runtime_inline_unique_indexes");
    assert.match(
      repairMigration?.sql ?? "",
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_message_id_unique ON chat_messages\(message_id\);/,
    );
  });

  it("replays the current canonical schema as a repair migration for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 7);

    assert.equal(repairMigration?.name, "canonical_runtime_schema_repairs");
    assert.match(repairMigration?.sql ?? "", /CREATE TABLE IF NOT EXISTS approval_effects \(/);
  });

  it("repairs approval shell explanation storage for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 37);

    assert.equal(repairMigration?.name, "approval_shell_explanations");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE approvals/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS shell_explanations_json TEXT/);
  });

  it("repairs Code Mode run sandbox columns for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 44);

    assert.equal(repairMigration?.name, "code_mode_run_sandbox_schema_parity");
    assert.match(repairMigration?.sql ?? "", /CREATE TABLE IF NOT EXISTS code_mode_runs \(/);
    assert.match(repairMigration?.sql ?? "", /sandbox_json TEXT/);
    assert.match(repairMigration?.sql ?? "", /execution_backend_json TEXT/);
    assert.match(repairMigration?.sql ?? "", /error_details_json TEXT/);
    assert.match(repairMigration?.sql ?? "", /idx_code_mode_runs_approval/);
  });

  it("repairs state validation quarantine history drift for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 47);

    assert.equal(repairMigration?.name, "state_validation_quarantine_history_repair");
    assert.match(repairMigration?.sql ?? "", /CREATE TABLE IF NOT EXISTS state_validation_quarantine \(/);
    assert.match(repairMigration?.sql ?? "", /idx_state_validation_quarantine_store_observed/);
    assert.match(repairMigration?.sql ?? "", /WHERE version = 32/);
    assert.match(repairMigration?.sql ?? "", /WHERE version = 33/);
  });

  it("repairs benchmark lease columns for older Postgres prompt-pack runtime tables", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 8);

    assert.equal(repairMigration?.name, "prompt_pack_benchmark_claim_repairs");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE prompt_pack_benchmark_runs/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS claimed_by_worker_id TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS claim_heartbeat_at TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS claim_expires_at TEXT/);
    assert.match(repairMigration?.sql ?? "", /CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_runs_claim/);
  });

  it("repairs chat user-input prompt columns for older Postgres chat trace tables", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 10);

    assert.equal(repairMigration?.name, "chat_user_input_prompt_repairs");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE chat_turn_traces/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS pending_user_input_json TEXT/);
  });

  it("repairs missing mutation idempotency tables for older Postgres gateway runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 11);

    assert.equal(repairMigration?.name, "mutation_idempotency_runtime_repairs");
    assert.match(repairMigration?.sql ?? "", /CREATE TABLE IF NOT EXISTS mutation_idempotency \(/);
    assert.match(repairMigration?.sql ?? "", /PRIMARY KEY \(method, route_path, idempotency_key, actor_scope\)/);
    assert.match(repairMigration?.sql ?? "", /CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_updated/);
  });

  it("repairs prompt-pack run columns for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 12);

    assert.equal(repairMigration?.name, "prompt_pack_runs_shape_repairs");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE prompt_pack_runs/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS mode TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS tool_tier TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS tool_autonomy TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS web_mode TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS memory_mode TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS thinking_level TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS derived_response_text TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS derived_response_signals_json TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS integrity_json TEXT/);
  });

  it("repairs chat turn trace columns for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 13);

    assert.equal(repairMigration?.name, "chat_turn_trace_shape_repairs");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE chat_turn_traces/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS orchestration_json TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS guidance_json TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS loop_guard_json TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS capability_upgrade_suggestions_json TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS specialist_candidate_suggestions_json TEXT/);
  });

  it("repairs chat tool run and delegation step columns for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 14);

    assert.equal(repairMigration?.name, "chat_tool_and_delegation_shape_repairs");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE chat_tool_runs/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS reused BIGINT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS reused_from_tool_run_id TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS reuse_reason TEXT/);
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE chat_delegation_steps/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS label TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS durable_run_id TEXT/);
  });

  it("reasserts current chat delegation step columns for already-migrated Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 24);

    assert.equal(repairMigration?.name, "chat_delegation_step_current_shape_repairs");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE chat_delegation_steps/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS label TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS provider_id TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS model TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS summary TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS output TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS error TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS failure_guidance TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS durable_run_id TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS child_session_id TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS child_turn_id TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS citations_json TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS degraded_handoff_step_ids_json TEXT/);
  });

  it("repairs execution plan step durable run columns for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 15);

    assert.equal(repairMigration?.name, "chat_execution_plan_step_shape_repairs");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE chat_execution_plan_steps/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS durable_run_id TEXT/);
  });

  it("repairs chat session organization and generated artifact schema for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 17);

    assert.equal(repairMigration?.name, "chat_session_and_agent_refresh_repairs");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE agent_profiles/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS preset_defaults_json TEXT/);
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE chat_session_meta/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS folder_id TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS folder_name TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS tags_json TEXT NOT NULL DEFAULT '\[\]'/);
    assert.match(repairMigration?.sql ?? "", /CREATE TABLE IF NOT EXISTS chat_generated_artifacts \(/);
    assert.match(repairMigration?.sql ?? "", /CREATE TABLE IF NOT EXISTS chat_thread_knowledge_attachments \(/);
  });

  it("repairs generated artifact provenance columns for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 18);

    assert.equal(repairMigration?.name, "generated_artifact_provenance_repairs");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE chat_generated_artifacts/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS source_block_index BIGINT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS content_hash TEXT/);
  });

  it("repairs generated artifact project scope for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 51);

    assert.equal(repairMigration?.name, "chat_generated_artifacts_project_scope");
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS project_id TEXT/);
    assert.match(repairMigration?.sql ?? "", /idx_chat_generated_artifacts_project_created/);
  });

  it("backfills generated artifact project scope for already-assigned chat sessions", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 52);

    assert.equal(repairMigration?.name, "chat_generated_artifacts_project_scope_backfill");
    assert.match(repairMigration?.sql ?? "", /UPDATE chat_generated_artifacts AS artifacts/);
    assert.match(repairMigration?.sql ?? "", /FROM chat_session_projects AS projects/);
    assert.match(repairMigration?.sql ?? "", /artifacts.project_id IS NULL/);
  });

  it("repairs the imported agent catalog table for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 19);

    assert.equal(repairMigration?.name, "imported_agent_catalog_schema_repairs");
    assert.match(repairMigration?.sql ?? "", /CREATE TABLE IF NOT EXISTS imported_agent_catalog \(/);
    assert.match(repairMigration?.sql ?? "", /CREATE INDEX IF NOT EXISTS idx_imported_agent_catalog_workspace/);
    assert.match(
      repairMigration?.sql ?? "",
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_agent_catalog_source_path/,
    );
  });

  it("repairs chat image route preference columns for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 20);

    assert.equal(repairMigration?.name, "chat_image_route_preference_repairs");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE chat_session_prefs/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS image_provider_id TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS image_model TEXT/);
  });

  it("adds chat operator control preferences for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 28);

    assert.equal(repairMigration?.name, "chat_operator_control_prefs");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE chat_session_prefs/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS speed_mode TEXT DEFAULT 'standard'/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS subagent_policy TEXT DEFAULT 'ask_when_useful'/);
  });

  it("repairs comms delivery runtime metadata for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 30);

    assert.equal(repairMigration?.name, "comms_delivery_runtime_metadata");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE comms_deliveries/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS payload_json TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS delivery_status TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS idempotency_key TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS next_attempt_at TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS stale_after_ms INTEGER/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS base_backoff_ms INTEGER/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS max_backoff_ms INTEGER/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS stale_reason TEXT/);
    assert.match(repairMigration?.sql ?? "", /CREATE UNIQUE INDEX IF NOT EXISTS idx_comms_deliveries_idempotency/);
    assert.match(repairMigration?.sql ?? "", /CREATE INDEX IF NOT EXISTS idx_comms_deliveries_due/);
  });

  it("repairs prompt-pack agentic diagnostic columns for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 21);

    assert.equal(repairMigration?.name, "prompt_pack_agentic_diagnostics_repairs");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE prompt_pack_tests/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS diagnostic_metadata_json TEXT/);
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE prompt_pack_runs/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS execution_style TEXT/);
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE prompt_pack_benchmark_runs/);
  });

  it("repairs prompt-pack score-facing response columns for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 61);

    assert.equal(repairMigration?.name, "prompt_pack_run_score_facing_response_fields");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE prompt_pack_runs/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS final_response_text TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS final_response_signals_json TEXT/);
  });

  it("repairs benchmark item uniqueness for older Postgres prompt-pack runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 22);

    assert.equal(repairMigration?.name, "prompt_pack_benchmark_item_unique_repairs");
    assert.match(repairMigration?.sql ?? "", /DELETE FROM prompt_pack_benchmark_items AS item/);
    assert.match(
      repairMigration?.sql ?? "",
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_unique/,
    );
    assert.match(repairMigration?.sql ?? "", /benchmark_run_id, provider_id, model, test_id/);
  });

  it("renders edge-case SQLite blueprint shapes into Postgres schema SQL", () => {
    const sql = buildPostgresRuntimeSchemaSqlFromBlueprint({
      tables: [
        table({
          name: "schema_migrations",
          columns: [
            {
              name: "version",
              type: "INTEGER",
              notNull: true,
              defaultValue: null,
              primaryKeyPosition: 1,
              autoIncrement: false,
            },
          ],
          seedRows: [{ version: 1 }],
        }),
        table({
          name: "parent",
          columns: [
            {
              name: "id",
              type: "INTEGER",
              notNull: true,
              defaultValue: null,
              primaryKeyPosition: 1,
              autoIncrement: true,
            },
            {
              name: "name",
              type: "TEXT",
              notNull: true,
              defaultValue: "'unknown'",
              primaryKeyPosition: 0,
              autoIncrement: false,
            },
            {
              name: "created_at",
              type: "TEXT",
              notNull: true,
              defaultValue: "current_timestamp",
              primaryKeyPosition: 0,
              autoIncrement: false,
            },
            {
              name: "score",
              type: "REAL",
              notNull: false,
              defaultValue: null,
              primaryKeyPosition: 0,
              autoIncrement: false,
            },
            {
              name: "payload",
              type: "BLOB",
              notNull: false,
              defaultValue: null,
              primaryKeyPosition: 0,
              autoIncrement: false,
            },
          ],
          indexes: [
            { name: "idx_parent_empty", unique: false, origin: "c", columns: [], where: null },
            { name: "sqlite_autoindex_parent_1", unique: true, origin: "pk", columns: ["id"], where: null },
            { name: "idx_parent_name", unique: true, origin: "c", columns: ["name"], where: null },
            {
              name: "idx_parent_active_name",
              unique: true,
              origin: "c",
              columns: ["name"],
              where: "score IS NOT NULL AND name <> 'unknown'",
            },
          ],
          seedRows: [
            {
              id: 1,
              name: "O'Hare",
              created_at: undefined,
              score: Number.POSITIVE_INFINITY,
              payload: null,
            },
          ],
        }),
        table({
          name: "child",
          columns: [
            {
              name: "parent_id",
              type: "INTEGER",
              notNull: true,
              defaultValue: null,
              primaryKeyPosition: 1,
              autoIncrement: false,
            },
            {
              name: "locale",
              type: "TEXT",
              notNull: true,
              defaultValue: null,
              primaryKeyPosition: 2,
              autoIncrement: false,
            },
          ],
          foreignKeys: [
            {
              id: 0,
              seq: 0,
              from: "parent_id",
              to: "id",
              referencedTable: "parent",
              onUpdate: "CASCADE",
              onDelete: "CASCADE",
            },
          ],
        }),
      ],
    });

    assert.doesNotMatch(sql, /schema_migrations/);
    assert.match(sql, /id BIGSERIAL PRIMARY KEY/);
    assert.match(sql, /created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    assert.match(sql, /score DOUBLE PRECISION/);
    assert.match(sql, /payload BYTEA/);
    assert.match(sql, /PRIMARY KEY \(parent_id, locale\)/);
    assert.match(sql, /FOREIGN KEY \(parent_id\) REFERENCES parent\(id\) ON DELETE CASCADE ON UPDATE CASCADE/);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_parent_name ON parent\(name\);/);
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_parent_active_name ON parent\(name\) WHERE score IS NOT NULL AND name <> 'unknown';/,
    );
    assert.doesNotMatch(sql, /idx_parent_empty/);
    assert.doesNotMatch(sql, /sqlite_autoindex_parent_1/);
    assert.match(
      sql,
      /INSERT INTO parent \(id, name, created_at, score, payload\) VALUES \(1, 'O''Hare', NULL, NULL, NULL\) ON CONFLICT \(id\) DO NOTHING;/,
    );
  });

  it("falls back to deterministic table ordering for circular foreign keys", () => {
    const sql = buildPostgresRuntimeSchemaSqlFromBlueprint({
      tables: [
        table({
          name: "cycle_b",
          columns: [
            {
              name: "id",
              type: "TEXT",
              notNull: true,
              defaultValue: null,
              primaryKeyPosition: 1,
              autoIncrement: false,
            },
          ],
          foreignKeys: [
            {
              id: 0,
              seq: 0,
              from: "id",
              to: "id",
              referencedTable: "cycle_a",
              onUpdate: "NO ACTION",
              onDelete: "NO ACTION",
            },
          ],
        }),
        table({
          name: "cycle_a",
          columns: [
            {
              name: "id",
              type: "TEXT",
              notNull: true,
              defaultValue: null,
              primaryKeyPosition: 1,
              autoIncrement: false,
            },
          ],
          foreignKeys: [
            {
              id: 0,
              seq: 0,
              from: "id",
              to: "id",
              referencedTable: "cycle_b",
              onUpdate: "NO ACTION",
              onDelete: "NO ACTION",
            },
          ],
        }),
      ],
    });

    assert.ok(sql.indexOf("CREATE TABLE IF NOT EXISTS cycle_a") < sql.indexOf("CREATE TABLE IF NOT EXISTS cycle_b"));
  });

  it("reports invalid internal render requests explicitly", () => {
    const sampleTable = table({
      name: "sample",
      columns: [
        {
          name: "id",
          type: "TEXT",
          notNull: true,
          defaultValue: null,
          primaryKeyPosition: 1,
          autoIncrement: false,
        },
      ],
    });

    assert.throws(() => renderColumn(sampleTable, "missing", ["id"]), /Unknown SQLite column missing on sample/);
    assert.throws(() => renderForeignKey([]), /Expected at least one foreign key/);
  });
});
