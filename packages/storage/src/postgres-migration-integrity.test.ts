import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertPostgresMigrationIntegrity } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

describe("protected Postgres migration integrity", () => {
  it("recomputes every explicit digest from the generated migration statements", () => {
    const protectedMigrations = POSTGRES_MIGRATIONS.filter((migration) => migration.integritySha256 !== undefined);
    assert.ok(protectedMigrations.length > 0, "expected at least one integrity-protected migration");

    for (const migration of protectedMigrations) {
      assert.doesNotThrow(() => assertPostgresMigrationIntegrity(migration));
    }
  });

  it("fails when generated statement content drifts without a matching digest", () => {
    const migration = POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.integritySha256 !== undefined && candidate.batchedStatements,
    );
    const statements = migration?.batchedStatements;
    assert.ok(migration && statements);

    assert.throws(
      () =>
        assertPostgresMigrationIntegrity({
          ...migration,
          batchedStatements: [
            ...statements.slice(0, -1),
            {
              ...statements.at(-1)!,
              sql: `${statements.at(-1)!.sql}\n-- unintended drift`,
            },
          ],
        }),
      /integrity hash mismatch/,
    );
  });

  it("keeps migration 105 context-pressure recovery CHECK executable and balanced", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 105);
    assert.equal(migration?.name, "context_pressure_recovery_truth");
    const sql = migration?.sql ?? "";
    assert.match(
      sql,
      /transport_retry_reason = 'output_cap_recovery'\s*\)\s*AND \(\s*\(transport_retry_parent_event_id IS NULL[\s\S]*?\)\s*\)\);/u,
    );
    assert.doesNotMatch(sql, /transport_retry_reason = 'output_cap_recovery'\s*\)\s*\)\s*AND \(/u);
  });

  it("keeps HX-413 migration 107 as additive bounded DDL without a competing outbox", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 107);
    assert.equal(migration?.name, "skill_hub_lifecycle_foundation");
    assert.equal(migration?.batchedStatements, undefined);
    const sql = migration?.sql ?? "";
    assert.match(sql, /CREATE TABLE IF NOT EXISTS skill_hub_snapshot_artifacts/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS skill_hub_operation_intents/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS skill_hub_operation_settlements/);
    assert.doesNotMatch(sql, /CREATE TABLE[^;]*outbox|INSERT INTO|UPDATE\s+skill_hub|DELETE FROM|DROP TABLE/i);
  });

  it("keeps HX-407 migration 108 paired, additive, bounded, and content-free", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 108);
    assert.equal(migration?.name, "governed_external_sources_foundation");
    assert.equal(migration?.batchedStatements, undefined);
    const sql = migration?.sql ?? "";
    for (const table of [
      "external_source_configs",
      "external_source_scans",
      "external_source_catalog_items",
      "external_source_import_plans",
      "external_source_import_intents",
      "external_source_import_items",
      "external_source_import_settlements",
      "chat_external_source_attachments",
      "external_source_knowledge_links",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
    }
    assert.match(sql, /UNIQUE\(workspace_id, idempotency_key\)/u);
    assert.match(sql, /status = 'detached'[\s\S]*detached_by_actor_id IS NOT NULL/u);
    assert.doesNotMatch(sql, /\b(?:INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/iu);
    const catalogDefinition =
      sql.match(/CREATE TABLE IF NOT EXISTS external_source_catalog_items\s*\(([\s\S]*?)\n\s*\);/u)?.[1] ?? "";
    assert.doesNotMatch(
      catalogDefinition,
      /(?:transcript|prompt|response|tool_output|raw_bytes|content)\s+(?:TEXT|BYTEA)/iu,
    );
  });

  it("keeps HX-408 migration 110 additive, bounded, immutable, and database-clock fenced", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 110);
    assert.equal(migration?.name, "governed_mesh_capability_publication");
    assert.equal(migration?.batchedStatements, undefined);
    const sql = migration?.sql ?? "";
    for (const table of [
      "mesh_capability_publishers",
      "mesh_capability_publisher_health",
      "mesh_capability_manifests",
      "mesh_capability_manifest_entries",
      "mesh_capability_activations",
      "mesh_capability_activation_revocations",
      "mesh_capability_invocation_intents",
      "mesh_capability_invocation_settlements",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
    }
    assert.match(sql, /entry_count BETWEEN 1 AND 128/u);
    assert.match(sql, /publisher_count >= 16/u);
    assert.match(sql, /active_manifest_count >= 32/u);
    assert.match(sql, /active_count >= 256/u);
    assert.match(sql, /entry\.kind IN \('tool', 'mcp_server'\)/u);
    assert.match(sql, /MAX\(latest\.activation_revision\)/u);
    assert.match(sql, /activation\.capability_id <> NEW\.capability_id/u);
    assert.match(sql, /admission generation cannot regress/u);
    assert.match(sql, /OLD\.status IN \('offline', 'revoked'\)/u);
    assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\([\s\S]*NEW\.manifest_sha256/u);
    assert.match(sql, /resourceLimits,timeoutMs/u);
    assert.match(sql, /supersedesManifestSha256/u);
    assert.match(sql, /jsonb_build_array\(NEW\.canonical_json::jsonb\)/u);
    assert.match(sql, /clock_timestamp\(\)/u);
    assert.match(sql, /different|immutable|no_update/iu);
    assert.doesNotMatch(sql, /\b(?:INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/iu);
  });

  it("keeps HX-408 migration 111 additive, admission-authoritative, and concurrency fenced", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 111);
    assert.equal(migration?.name, "mesh_capability_node_admission_authority");
    assert.equal(migration?.batchedStatements, undefined);
    const sql = migration?.sql ?? "";
    for (const table of ["mesh_capability_node_admissions", "mesh_capability_node_admission_revocations"]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
    }
    assert.match(sql, /UNIQUE\(workspace_id, idempotency_key\)/u);
    assert.match(sql, /FOREIGN KEY\(join_token_sha256\) REFERENCES mesh_join_tokens\(token_hash\)/u);
    assert.match(sql, /used_at IS NOT NULL AND token\.used_by_node_id = NEW\.node_id/u);
    assert.match(sql, /NEW\.admission_generation <> prior_generation \+ 1/u);
    assert.match(sql, /prior node admission must be revoked before replacement/u);
    assert.match(sql, /active_count >= 16/u);
    assert.equal(sql.match(/pg_advisory_xact_lock\(hashtextextended\(NEW\.workspace_id, 411\)\)/gu)?.length, 3);
    assert.equal(
      sql.match(/pg_advisory_xact_lock\(hashtextextended\(NEW\.workspace_id \|\| ':' \|\| NEW\.node_id, 412\)\)/gu)
        ?.length,
      6,
    );
    assert.match(sql, /terminal publisher health/u);
    assert.match(sql, /CREATE OR REPLACE FUNCTION gc_mesh_capability_publishers_guard\(\)/u);
    assert.doesNotMatch(sql, /publisher_count/u);
    assert.match(sql, /publishers_admission_authority/u);
    assert.match(sql, /manifests_admission_authority/u);
    assert.match(sql, /activations_admission_authority/u);
    assert.match(sql, /intents_admission_authority/u);
    assert.match(sql, /node_admissions_no_update/u);
    assert.match(sql, /node_admission_revocations_no_delete/u);
    assert.doesNotMatch(sql, /mesh_capability_invocation_settlements/u);
    assert.doesNotMatch(sql, /\b(?:INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/iu);
  });

  it("keeps HX-501 migration 112 additive, hash-only, immutable, and production-dark", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 112);
    assert.equal(migration?.name, "remote_worker_admission_foundation");
    assert.equal(migration?.batchedStatements, undefined);
    const sql = migration?.sql ?? "";
    for (const table of [
      "remote_worker_bootstrap_requests",
      "remote_worker_bootstrap_allowed_workspaces",
      "remote_worker_bootstrap_capability_classes",
      "remote_worker_generations",
      "remote_worker_runtime_credentials",
      "remote_worker_generation_controls",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
    }
    assert.equal(sql.match(/CREATE TABLE IF NOT EXISTS remote_worker_/gu)?.length, 6);
    assert.match(sql, /bootstrap_secret_sha256 TEXT NOT NULL UNIQUE/u);
    assert.match(sql, /token_sha256 TEXT NOT NULL UNIQUE/u);
    assert.doesNotMatch(
      sql,
      /(?:bootstrap_secret|credential_token|runtime_token)_(?:plaintext|value)|approved_token_plaintext/iu,
    );
    assert.match(sql, /purpose TEXT NOT NULL CHECK\(purpose = 'worker_runtime'\)/u);
    assert.match(sql, /length\(registry_workspace_id\) BETWEEN 1 AND 256/u);
    assert.match(sql, /length\(idempotency_key\) BETWEEN 1 AND 512/u);
    assert.match(sql, /reason_code ~ '\^\[a-z0-9\]/u);
    assert.match(sql, /runtime_manifest_json::jsonb - ARRAY\[[\s\S]*signatureBase64Url[\s\S]*= '\{\}'::JSONB/u);
    assert.doesNotMatch(sql, /jsonb_object_length/u);
    assert.match(sql, /signatureBase64Url' ~ '\^\[A-Za-z0-9_-\]\{85\}\[AQgw\]\$'/u);
    assert.match(sql, /target_worker_generation/u);
    assert.match(sql, /prior\.installed_tree_attestation_sha256 = NEW\.installed_tree_attestation_sha256/u);
    assert.match(sql, /prior\.claims_sha256 = NEW\.claims_sha256/u);
    assert.match(sql, /registry_scope\.allowed_workspace_id = NEW\.registry_workspace_id/u);
    assert.match(sql, /registry_scope\.allowed_workspace_id = bootstrap\.registry_workspace_id/u);
    assert.match(sql, /prior_action <> 'quarantine' OR NEW\.action <> 'revoke'/u);
    assert.match(sql, /hashtextextended\(NEW\.registry_workspace_id, 501\)/u);
    assert.match(sql, /hashtextextended\(NEW\.registry_workspace_id \|\| ':' \|\| NEW\.worker_id, 502\)/u);
    assert.equal(sql.match(/database_now TIMESTAMPTZ := clock_timestamp\(\)/gu)?.length, 4);
    assert.match(sql, /gc_try_parse_timestamptz\(NEW\.expires_at\) <= database_now/u);
    assert.match(sql, /gc_try_parse_timestamptz\(prior\.expires_at\) > database_now/u);
    assert.match(sql, /bootstraps_no_update/u);
    assert.match(sql, /credentials_no_delete/u);
    assert.doesNotMatch(sql, /mesh_capability_node_admissions|gateway_route|readiness|listener/iu);
    assert.doesNotMatch(sql, /\b(?:INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/iu);
  });

  it("keeps HX-502/HX-504 migration 113 additive, append-only, parent-fenced, and production-dark", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 113);
    assert.equal(migration?.name, "remote_worker_assignment_foundation");
    assert.equal(migration?.batchedStatements, undefined);
    const sql = migration?.sql ?? "";
    for (const table of [
      "remote_worker_assignments",
      "remote_worker_assignment_generations",
      "remote_worker_assignment_leases",
      "remote_worker_assignment_controls",
      "remote_worker_assignment_events",
      "remote_worker_assignment_settlements",
      "remote_worker_assignment_materializations",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
      assert.match(sql, new RegExp(`${table}_no_update`, "u"));
      assert.match(sql, new RegExp(`${table}_no_delete`, "u"));
    }
    assert.equal(sql.match(/CREATE TABLE IF NOT EXISTS remote_worker_assignment/gu)?.length, 7);
    assert.match(sql, /parent_dispatch_authority_json/u);
    assert.match(sql, /gc_remote_worker_assignment_lock_parent_context/u);
    assert.match(sql, /durable_runs run WHERE run\.run_id = durable_run_key FOR UPDATE/u);
    assert.match(sql, /tasks task WHERE task\.task_id = task_key FOR SHARE/u);
    assert.match(sql, /chat_session_meta session WHERE session\.session_id = session_key FOR SHARE/u);
    assert.match(sql, /chat_turn_traces turn_trace WHERE turn_trace\.turn_id = turn_key FOR SHARE/u);
    assert.match(sql, /hashtextextended\(execution_workspace, 411\)/u);
    assert.match(sql, /hashtextextended\(execution_workspace \|\| ':' \|\| COALESCE\(assigned_node, ''\), 412\)/u);
    for (const lock of [501, 502, 503, 504]) assert.match(sql, new RegExp(`, ${lock}\\)`, "u"));
    assert.match(sql, /NEW\.outcome = 'cancelled'[\s\S]*control\.action = 'cancel_requested'/u);
    assert.match(sql, /WHERE source_kind = 'event'/u);
    assert.match(sql, /WHERE source_kind = 'settlement'/u);
    assert.match(sql, /octet_length\(manifest_json\) <= 32768/u);
    assert.match(sql, /octet_length\(payload_json\) <= 65536/u);
    assert.doesNotMatch(sql, /length\(octet_length/u);
    assert.doesNotMatch(
      sql,
      /\b(?:INSERT\s+INTO|UPDATE\s+durable_runs|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/iu,
    );
    assert.doesNotMatch(sql, /gateway_route|listener|chat_messages\s+SET|model_usage_events/iu);
  });

  it("keeps HX-411 migration 114 additive, hash-only, generation-fenced, and production-dark", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 114);
    assert.equal(migration?.name, "session_control_foundation");
    assert.equal(migration?.batchedStatements, undefined);
    const sql = migration?.sql ?? "";
    for (const table of [
      "chat_session_control_tokens",
      "chat_session_control_requests",
      "chat_session_control_grants",
      "chat_session_control_events",
      "chat_session_control_auth_revoke_receipts",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
    }
    assert.equal(sql.match(/CREATE TABLE IF NOT EXISTS chat_session_control_/gu)?.length, 5);
    assert.match(sql, /token_sha256 TEXT PRIMARY KEY CHECK\(token_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/u);
    assert.match(
      sql,
      /requested_capabilities_json TEXT NOT NULL CHECK\(requested_capabilities_json IN \('\["send"\]', '\["send","read"\]'\)\)/u,
    );
    assert.doesNotMatch(sql, /'\["read"\]'/u);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_session_control_grants_one_current/u);
    assert.match(sql, /NEW\.generation <> prior_generation \+ 1/u);
    assert.match(sql, /prior_workspace <> NEW\.workspace_id/u);
    assert.match(sql, /UNIQUE\(session_id, event_sequence\)/u);
    assert.match(sql, /events_no_update/u);
    assert.match(sql, /events_no_delete/u);
    assert.equal(sql.match(/pg_advisory_xact_lock\(hashtextextended\(NEW\.session_id, 411\)\)/gu)?.length, 2);
    assert.match(sql, /database_now TIMESTAMPTZ := clock_timestamp\(\)/u);
    assert.match(sql, /token_expires_at[\s\S]*900/u);
    assert.match(sql, /lease_expires_at[\s\S]*60/u);
    assert.match(sql, /reconnect_expires_at[\s\S]*300/u);
    assert.equal(sql.match(/^\s*\('chat_session_control_/gmu)?.length, 78);
    assert.match(sql, /gc_scr_capabilities/u);
    assert.match(sql, /gc_scr_capabilities_digest/u);
    assert.match(sql, /gc_scg_owner_shape/u);
    assert.match(sql, /gc_scg_requested_digest/u);
    assert.match(sql, /gc_scg_effective_digest/u);
    assert.match(sql, /gc_sce_reason_code/u);
    assert.match(sql, /ALTER TABLE auth_device_requests[\s\S]*principal_purpose/u);
    assert.match(sql, /ALTER TABLE auth_device_grants[\s\S]*principal_purpose/u);
    assert.match(sql, /ALTER TABLE companion_sessions[\s\S]*principal_purpose/u);
    assert.match(sql, /gc_adr_principal_purpose/u);
    assert.match(sql, /gc_adg_principal_purpose/u);
    assert.match(sql, /gc_cs_principal_purpose/u);
    assert.match(sql, /gc_auth_device_request_principal_purpose_guard/u);
    assert.match(sql, /gc_auth_device_grant_principal_purpose_guard/u);
    assert.match(sql, /gc_companion_session_principal_purpose_guard/u);
    assert.match(sql, /NEW\.request_id IS DISTINCT FROM OLD\.request_id/u);
    assert.match(sql, /NEW\.grant_id IS DISTINCT FROM OLD\.grant_id/u);
    assert.match(sql, /gc_session_control_token_insert_guard/u);
    assert.match(sql, /gc_session_control_request_insert_guard/u);
    assert.match(sql, /gc_session_control_event_insert_guard/u);
    assert.match(sql, /gc_session_control_auth_revoke_receipt_insert_guard/u);
    assert.match(sql, /auth_revoke_receipts_no_update/u);
    assert.match(sql, /auth_revoke_receipts_no_delete/u);
    assert.match(sql, /constraint_row\.conrelid = to_regclass\(check_spec\.table_name\)/u);
    assert.match(sql, /ALTER TABLE %I ADD CONSTRAINT %I CHECK \(%s\)/u);
    assert.match(sql, /INSERT INTO chat_session_control_grants[\s\S]*FROM chat_session_meta meta/u);
    assert.match(sql, /INSERT INTO chat_session_control_events[\s\S]*'session_initialized'/u);
    assert.match(sql, /session control backfill invariant violated/u);
    assert.doesNotMatch(sql, /FOREIGN KEY[^;]*REFERENCES chat_session_meta/iu);
    assert.doesNotMatch(sql, /TRIGGER[^;]*(?:INSERT|DELETE|UPDATE) ON chat_session_meta/iu);
    assert.doesNotMatch(sql, /\b(?:DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE|UPDATE\s+chat_session_meta)\b/iu);
    assert.doesNotMatch(
      sql,
      /chat_messages|chat_turn_traces|model_usage_events|durable_runs|gateway_route|listener|(?:plaintext|secret|value)_token/iu,
    );
  });
});
