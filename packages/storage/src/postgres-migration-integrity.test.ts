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
});
