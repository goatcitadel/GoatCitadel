import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createDatabase } from "./sqlite.js";

const db = createDatabase({ dbPath: ":memory:" });
const postgresSql = POSTGRES_MIGRATIONS.find((migration) => migration.version === 112)?.sql ?? "";

after(() => db.close());

const TABLE_COLUMNS = {
  remote_worker_bootstrap_requests: [
    "registry_workspace_id",
    "bootstrap_id",
    "worker_id",
    "node_id",
    "target_worker_generation",
    "worker_label",
    "platform",
    "architecture",
    "runtime_manifest_json",
    "runtime_manifest_sha256",
    "allowed_workspace_count",
    "workspace_ceiling_sha256",
    "capability_class_count",
    "capability_ceiling_sha256",
    "bootstrap_secret_sha256",
    "expires_at",
    "created_by_actor_id",
    "idempotency_key",
    "request_sha256",
    "created_at",
  ],
  remote_worker_bootstrap_allowed_workspaces: ["registry_workspace_id", "bootstrap_id", "allowed_workspace_id"],
  remote_worker_bootstrap_capability_classes: ["registry_workspace_id", "bootstrap_id", "capability_class"],
  remote_worker_generations: [
    "registry_workspace_id",
    "worker_id",
    "node_id",
    "worker_generation",
    "bootstrap_id",
    "public_key_spki_sha256",
    "client_certificate_sha256",
    "transport_identity_source",
    "transport_trust_anchor_sha256",
    "transport_verification_receipt_sha256",
    "proof_of_possession_receipt_sha256",
    "download_verification_receipt_sha256",
    "installed_tree_attestation_sha256",
    "installed_tree_verification_receipt_sha256",
    "runtime_manifest_sha256",
    "workspace_ceiling_sha256",
    "capability_ceiling_sha256",
    "exchange_idempotency_key",
    "exchange_request_sha256",
    "admitted_at",
  ],
  remote_worker_runtime_credentials: [
    "registry_workspace_id",
    "worker_id",
    "worker_generation",
    "credential_generation",
    "credential_id",
    "purpose",
    "token_sha256",
    "transport_verification_receipt_sha256",
    "proof_of_possession_receipt_sha256",
    "claims_json",
    "claims_sha256",
    "issuance_proof_sha256",
    "idempotency_key",
    "request_sha256",
    "issued_at",
    "expires_at",
  ],
  remote_worker_generation_controls: [
    "registry_workspace_id",
    "worker_id",
    "worker_generation",
    "control_revision",
    "action",
    "reason_code",
    "reason_sha256",
    "actor_id",
    "idempotency_key",
    "request_sha256",
    "created_at",
  ],
} as const;

describe("HX-501 remote worker admission schema parity", () => {
  it("keeps SQLite 170 and PostgreSQL 112 paired across exactly six production-dark tables", () => {
    assert.equal(
      postgresSql.match(/CREATE TABLE IF NOT EXISTS remote_worker_/gu)?.length,
      6,
      "PostgreSQL 112 must add exactly the frozen six tables",
    );
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      assert.match(postgresSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
      assert.deepEqual(tableColumns(db, table), [...columns], `${table} SQLite columns drifted`);
      for (const column of columns) {
        assert.match(postgresSql, new RegExp(`\\b${column}\\s+(?:TEXT|BIGINT)\\b`, "u"));
      }
      assert.equal(columns[0], "registry_workspace_id", `${table} must prefix identity with registry workspace`);
    }
  });

  it("pairs exact scope, TTL, manifest, credential-purpose, and control ceilings", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(sql, /allowed_workspace_count[^\n]*BETWEEN 1 AND 16/u);
      assert.match(sql, /capability_class_count[^\n]*BETWEEN 1 AND 9/u);
      assert.match(sql, /(?:BETWEEN 1 AND 600|BETWEEN 1\.0 AND 600\.0|BETWEEN 1000 AND 600000)/u);
      assert.match(sql, /(?:BETWEEN 1 AND 900|BETWEEN 1\.0 AND 900\.0|BETWEEN 1000 AND 900000)/u);
      assert.match(sql, /524288/u);
      assert.match(sql, /installedTreeFileCount/u);
      assert.match(sql, /BETWEEN 1 AND 10000/u);
      assert.match(sql, /purpose = 'worker_runtime'/u);
      assert.match(sql, /transport_identity_source IN \('native_mtls', 'trusted_terminator'\)/u);
      assert.match(sql, /action IN \('quarantine', 'revoke'\)/u);
      assert.match(sql, /length\(registry_workspace_id\) BETWEEN 1 AND 256/u);
      assert.match(sql, /length\(idempotency_key\) BETWEEN 1 AND 512/u);
      for (const capability of [
        "durable_compute",
        "gateway_inference",
        "governed_tool",
        "governed_code",
        "artifact_stage",
        "trusted_verification",
        "device_camera",
        "device_location",
        "device_notification",
      ]) {
        assert.match(sql, new RegExp(`'${capability}'`, "u"));
      }
    }
    assert.match(sqliteSql, /reason_code NOT GLOB '\*\[\^a-z0-9\._-\]\*'/u);
    assert.match(postgresSql, /reason_code ~ '\^\[a-z0-9\]/u);
    assert.match(sqliteSql, /COUNT\(DISTINCT root\.key\)[\s\S]*<> 5/u);
    assert.match(sqliteSql, /COUNT\(DISTINCT payload\.key\)[\s\S]*<> 10/u);
    assert.match(sqliteSql, /signatureBase64Url[\s\S]*NOT IN \('A', 'Q', 'g', 'w'\)/u);
    assert.match(postgresSql, /runtime_manifest_json::jsonb - ARRAY\[[\s\S]*signatureBase64Url[\s\S]*= '\{\}'::JSONB/u);
    assert.match(
      postgresSql,
      /runtime_manifest_json::jsonb -> 'payload'\) - ARRAY\[[\s\S]*architecture[\s\S]*= '\{\}'::JSONB/u,
    );
    assert.doesNotMatch(postgresSql, /jsonb_object_length/u);
    assert.match(postgresSql, /signatureBase64Url' ~ '\^\[A-Za-z0-9_-\]\{85\}\[AQgw\]\$'/u);
  });

  it("requires the registry workspace in every admitted workspace ceiling", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(sql, /registry_scope\.allowed_workspace_id = NEW\.registry_workspace_id/u);
      assert.match(sql, /registry_scope\.allowed_workspace_id = bootstrap\.registry_workspace_id/u);
    }
  });

  it("keeps every direct PostgreSQL mutation behind workspace-then-worker admission locks", () => {
    for (const functionName of [
      "gc_remote_worker_bootstrap_guard",
      "gc_remote_worker_bootstrap_scope_guard",
      "gc_remote_worker_generation_guard",
      "gc_remote_worker_credential_guard",
      "gc_remote_worker_control_guard",
    ]) {
      const body = postgresFunction(postgresSql, functionName);
      const workspaceLock = body.indexOf("NEW.registry_workspace_id, 501");
      const workerLock = body.indexOf("NEW.registry_workspace_id || ':' ||");
      assert.ok(workspaceLock >= 0, `${functionName} must take the workspace 501 lock`);
      assert.ok(workerLock > workspaceLock, `${functionName} must take worker 502 only after workspace 501`);
      assert.match(body, /, 502\)/u);
    }
  });

  it("keeps PostgreSQL JSON, claims, timestamp, and captured-clock guards exact", () => {
    assert.match(postgresSql, /jsonb_typeof\(runtime_manifest_json::jsonb\) = 'object'/u);
    assert.match(postgresSql, /jsonb_typeof\(runtime_manifest_json::jsonb -> 'payload'\) = 'object'/u);
    for (const field of [
      "schemaVersion",
      "protocolVersion",
      "bundleSha256",
      "dependencyLockSha256",
      "vendorTreeSha256",
      "launcherSha256",
      "installedTreeManifestSha256",
      "platform",
      "architecture",
    ]) {
      assert.match(
        postgresSql,
        new RegExp(`jsonb_typeof\\(runtime_manifest_json::jsonb #> '\\{payload,${field}\\}'\\) = 'string'`, "u"),
      );
    }
    assert.match(
      postgresSql,
      /jsonb_typeof\(runtime_manifest_json::jsonb #> '\{payload,installedTreeFileCount\}'\) = 'number'/u,
    );

    const bootstrapGuard = postgresFunction(postgresSql, "gc_remote_worker_bootstrap_guard");
    assert.match(bootstrapGuard, /COUNT\(\*\) FROM json_each\(NEW\.runtime_manifest_json::json\)\) <> 5/u);
    assert.match(bootstrapGuard, /COUNT\(DISTINCT entry\.key\)[\s\S]*<> 5/u);
    assert.match(
      bootstrapGuard,
      /COUNT\(\*\) FROM json_each\(\(NEW\.runtime_manifest_json::json -> 'payload'\)\)\) <> 10/u,
    );
    assert.match(bootstrapGuard, /COUNT\(DISTINCT entry\.key\)[\s\S]*<> 10/u);

    const credentialGuard = postgresFunction(postgresSql, "gc_remote_worker_credential_guard");
    assert.match(credentialGuard, /jsonb_typeof\(NEW\.claims_json::jsonb\) <> 'object'/u);
    assert.match(credentialGuard, /COUNT\(\*\) FROM json_each\(NEW\.claims_json::json\)\) <> 11/u);
    assert.match(credentialGuard, /COUNT\(DISTINCT claim\.key\)[\s\S]*<> 11/u);
    assert.match(credentialGuard, /jsonb_typeof\(NEW\.claims_json::jsonb -> 'allowedWorkspaceIds'\) <> 'array'/u);
    assert.match(credentialGuard, /jsonb_typeof\(NEW\.claims_json::jsonb -> 'capabilityClasses'\) <> 'array'/u);
    for (const arrayField of ["allowedWorkspaceIds", "capabilityClasses"]) {
      assert.match(
        credentialGuard,
        new RegExp(
          `jsonb_array_elements\\(NEW\\.claims_json::jsonb -> '${arrayField}'\\)[\\s\\S]*jsonb_typeof\\(element\\.value\\) <> 'string'`,
          "u",
        ),
      );
    }
    assert.match(credentialGuard, /prior\.claims_json = NEW\.claims_json/u);
    assert.match(credentialGuard, /prior\.claims_sha256 = NEW\.claims_sha256/u);
    for (const binding of [
      "generation.exchange_idempotency_key = NEW.idempotency_key",
      "generation.exchange_request_sha256 = NEW.request_sha256",
      "generation.transport_verification_receipt_sha256 = NEW.transport_verification_receipt_sha256",
      "generation.proof_of_possession_receipt_sha256 = NEW.proof_of_possession_receipt_sha256",
    ]) {
      assert.match(credentialGuard, new RegExp(binding.replaceAll(".", "\\."), "u"));
    }

    for (const [functionName, fields] of [
      ["gc_remote_worker_bootstrap_guard", ["created_at", "expires_at"]],
      ["gc_remote_worker_generation_guard", ["admitted_at"]],
      ["gc_remote_worker_credential_guard", ["issued_at", "expires_at"]],
      ["gc_remote_worker_control_guard", ["created_at"]],
    ] as const) {
      const body = postgresFunction(postgresSql, functionName);
      assert.equal(body.match(/clock_timestamp\(\)/gu)?.length, 1, `${functionName} must capture one clock instant`);
      assert.match(body, /DECLARE[\s\S]*TIMESTAMPTZ[\s\S]*clock_timestamp\(\)/u);
      for (const field of fields) {
        assert.match(body, new RegExp(`gc_try_parse_timestamptz\\(NEW\\.${field}\\) IS NULL`, "u"));
        assert.match(
          body,
          new RegExp(`to_char\\(gc_try_parse_timestamptz\\(NEW\\.${field}\\)[\\s\\S]*<> NEW\\.${field}`, "u"),
        );
      }
    }

    const sqliteSql = schemaSql(db);
    for (const field of ["created_at", "expires_at", "admitted_at", "issued_at"]) {
      assert.match(
        sqliteSql,
        new RegExp(`strftime\\('%Y-%m-%dT%H:%M:%fZ', (?:NEW\\.)?${field}(?:, '\\+0 days')?\\) IS NOT NULL`, "u"),
      );
    }
    for (const binding of [
      "generation.exchange_idempotency_key = NEW.idempotency_key",
      "generation.exchange_request_sha256 = NEW.request_sha256",
      "generation.transport_verification_receipt_sha256 = NEW.transport_verification_receipt_sha256",
      "generation.proof_of_possession_receipt_sha256 = NEW.proof_of_possession_receipt_sha256",
    ]) {
      assert.match(sqliteSql, new RegExp(binding.replaceAll(".", "\\."), "u"));
    }
  });

  it("keeps generations, credentials, controls, and all ceiling rows append-only", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      for (const marker of [
        "bootstraps_no_update",
        "bootstraps_no_delete",
        "allowed_workspaces_no_update",
        "allowed_workspaces_no_delete",
        "capability_classes_no_update",
        "capability_classes_no_delete",
        "generations_no_update",
        "generations_no_delete",
        "credentials_no_update",
        "credentials_no_delete",
        "controls_no_update",
        "controls_no_delete",
      ]) {
        assert.match(sql, new RegExp(marker, "u"));
      }
      assert.match(sql, /prior\.public_key_spki_sha256 = NEW\.public_key_spki_sha256/u);
      assert.match(sql, /prior\.client_certificate_sha256 = NEW\.client_certificate_sha256/u);
      assert.match(sql, /prior\.installed_tree_attestation_sha256 = NEW\.installed_tree_attestation_sha256/u);
    }
  });

  it("keeps PostgreSQL 112 additive and free of state-changing DML or runtime claims", () => {
    assert.doesNotMatch(postgresSql, /\b(?:INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/iu);
    assert.doesNotMatch(
      postgresSql,
      /(?:gateway_route|readiness|listener|forwarded.*certificate|mesh_capability_node_admissions)/iu,
    );
  });
});

function tableColumns(client: DatabaseClient, table: string): string[] {
  return (client.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name);
}

function schemaSql(client: DatabaseClient): string {
  return (
    client
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE (type = 'table' OR type = 'trigger') AND name LIKE '%remote_worker%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>
  )
    .map((row) => `${row.name}\n${row.sql}`)
    .join("\n");
}

function postgresFunction(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}()`);
  assert.ok(start >= 0, `missing PostgreSQL function ${name}`);
  const end = sql.indexOf("$$ LANGUAGE plpgsql;", start);
  assert.ok(end >= 0, `unterminated PostgreSQL function ${name}`);
  return sql.slice(start, end);
}
