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
});
