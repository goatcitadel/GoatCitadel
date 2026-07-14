import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createDatabase } from "./sqlite.js";

const db = createDatabase({ dbPath: ":memory:" });
const postgresSql = POSTGRES_MIGRATIONS.find((migration) => migration.version === 110)?.sql ?? "";

after(() => db.close());

const TABLE_COLUMNS = {
  mesh_capability_publishers: [
    "workspace_id",
    "node_id",
    "admission_generation",
    "publisher_generation",
    "mtls_required",
    "tls_fingerprint",
    "publication_lease_key",
    "publication_lease_fencing_token",
    "publication_lease_expires_at",
    "idempotency_key",
    "request_sha256",
    "created_at",
  ],
  mesh_capability_publisher_health: [
    "workspace_id",
    "node_id",
    "publisher_generation",
    "health_generation",
    "status",
    "publication_lease_fencing_token",
    "publication_lease_expires_at",
    "tls_fingerprint",
    "updated_at",
  ],
  mesh_capability_manifests: [
    "workspace_id",
    "node_id",
    "admission_generation",
    "publisher_generation",
    "publication_key",
    "publication_lease_fencing_token",
    "manifest_sha256",
    "supersedes_manifest_sha256",
    "schema_version",
    "entry_count",
    "canonical_json",
    "request_sha256",
    "created_at",
  ],
  mesh_capability_manifest_entries: [
    "workspace_id",
    "node_id",
    "publisher_generation",
    "manifest_sha256",
    "capability_id",
    "local_id",
    "kind",
    "descriptor_sha256",
    "permission_envelope_sha256",
    "entry_sha256",
    "effect_posture",
    "canonical_json",
  ],
  mesh_capability_activations: [
    "workspace_id",
    "activation_id",
    "activation_revision",
    "capability_id",
    "node_id",
    "publisher_generation",
    "health_generation",
    "publication_lease_fencing_token",
    "manifest_sha256",
    "entry_sha256",
    "descriptor_sha256",
    "permission_envelope_sha256",
    "effect_posture",
    "permission_diff_json",
    "effect_diff_json",
    "approval_id",
    "actor_id",
    "session_id",
    "turn_id",
    "idempotency_key",
    "request_sha256",
    "created_at",
  ],
  mesh_capability_activation_revocations: [
    "workspace_id",
    "activation_id",
    "reason",
    "actor_id",
    "idempotency_key",
    "request_sha256",
    "revoked_at",
  ],
  mesh_capability_invocation_intents: [
    "workspace_id",
    "invocation_id",
    "activation_id",
    "activation_revision",
    "capability_id",
    "node_id",
    "publisher_generation",
    "health_generation",
    "publication_lease_fencing_token",
    "manifest_sha256",
    "entry_sha256",
    "descriptor_sha256",
    "permission_envelope_sha256",
    "execution_profile_sha256",
    "input_sha256",
    "session_id",
    "turn_id",
    "run_id",
    "approval_id",
    "deadline_at",
    "idempotency_key",
    "request_sha256",
    "created_at",
  ],
  mesh_capability_invocation_settlements: [
    "workspace_id",
    "invocation_id",
    "disposition",
    "output_sha256",
    "error_code",
    "settlement_sha256",
    "effective_cost_attribution_sha256",
    "publisher_generation",
    "publication_lease_fencing_token",
    "idempotency_key",
    "request_sha256",
    "settled_at",
  ],
} as const;

describe("HX-408 mesh capability publication schema parity", () => {
  it("keeps the SQLite 168 and Postgres 110 table/column contracts paired", () => {
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      assert.match(postgresSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
      const sqliteColumns = tableColumns(db, table);
      assert.deepEqual(sqliteColumns, [...columns], `${table} SQLite columns drifted`);
      for (const column of columns) {
        assert.match(
          postgresSql,
          new RegExp(`\\b${column}\\s+(?:TEXT|BIGINT)\\b`, "u"),
          `${table}.${column} missing in Postgres 110`,
        );
      }
    }
  });

  it("keeps both dialects fail-closed for immutable records, caps, skills, and database-clock leases", () => {
    const sqliteTriggers = (
      db
        .prepare(
          `
      SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'trg_mesh_capability_%'
      ORDER BY name
    `,
        )
        .all() as Array<{ name: string; sql: string }>
    )
      .map((row) => `${row.name}\n${row.sql}`)
      .join("\n");
    for (const token of [
      "publishers_no_update",
      "manifests_no_update",
      "entries_no_update",
      "intents_no_update",
      "settlements_no_update",
    ]) {
      assert.match(sqliteTriggers, new RegExp(token, "u"));
      assert.match(postgresSql, new RegExp(token, "u"));
    }
    for (const sql of [sqliteTriggers, postgresSql]) {
      assert.match(sql, /(?:>= 16|publisher_count >= 16)/u);
      assert.match(sql, /(?:>= 32|active_manifest_count >= 32)/u);
      assert.match(sql, /(?:>= 256|active_count >= 256)/u);
      assert.match(sql, /kind IN \('tool', 'mcp_server'\)/u);
      assert.match(sql, /(?:strftime\(|clock_timestamp\(\))/u);
      assert.match(sql, /activation_revision\s*=\s*\(\s*SELECT MAX\(latest\.activation_revision\)/u);
      assert.match(sql, /activation\.capability_id\s*<>\s*NEW\.capability_id/u);
      assert.match(sql, /admission_generation\s*>\s*NEW\.admission_generation/u);
      assert.match(sql, /OLD\.status IN \('offline', 'revoked'\)/u);
      assert.match(sql, /resourceLimits[\s\S]*timeoutMs/u);
      assert.match(sql, /supersedesManifestSha256/u);
      assert.match(sql, /descriptor[\s\S]*effectPosture/u);
    }
    assert.match(sqliteTriggers, /json_each\(manifest\.canonical_json, '\$\.entries'\)/u);
    assert.match(postgresSql, /jsonb_build_array\(NEW\.canonical_json::jsonb\)/u);
    assert.match(postgresSql, /pg_advisory_xact_lock\(hashtextextended\([\s\S]*NEW\.manifest_sha256/u);
  });
});

function tableColumns(client: DatabaseClient, table: string): string[] {
  return (client.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name);
}
