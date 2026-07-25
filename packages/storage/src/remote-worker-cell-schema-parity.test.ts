import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createDatabase } from "./sqlite.js";

const db = createDatabase({ dbPath: ":memory:" });
const postgresSql = POSTGRES_MIGRATIONS.find((migration) => migration.version === 120)?.sql ?? "";

after(() => db.close());

const TABLE_COLUMNS = {
  remote_worker_cells: [
    "registry_workspace_id",
    "assignment_id",
    "assignment_generation",
    "cell_id",
    "worker_id",
    "worker_generation",
    "backend",
    "idempotency_key",
    "profile_sha256",
    "request_sha256",
    "logical_root_sha256",
    "assignment_manifest_sha256",
    "path_jail_sha256",
    "capability_profile_sha256",
    "context_snapshot_sha256",
    "tool_effect_posture_sha256",
    "runtime_attestation_sha256",
    "launcher_attestation_sha256",
    "logical_disk_bytes",
    "allocated_disk_bytes",
    "file_limit",
    "inode_limit",
    "process_limit",
    "cpu_limit_milli",
    "wall_limit_ms",
    "memory_limit_bytes",
    "raw_output_limit_bytes",
    "diagnostic_limit_bytes",
    "artifact_ceiling_bytes",
    "backup_staging_bytes",
    "backup_publication_bytes",
    "egress_posture",
    "egress_policy_sha256",
    "egress_dns_revision",
    "env_allowlist_sha256",
    "execution_state",
    "execution_revision",
    "cleanup_state",
    "cleanup_revision",
    "backup_state",
    "backup_revision",
    "provisioning_owner",
    "provisioning_lease_expires_at",
    "platform_identity_sha256",
    "container_name",
    "image_digest",
    "network_name",
    "peak_disk_bytes",
    "peak_memory_bytes",
    "peak_file_count",
    "peak_process_count",
    "raw_output_bytes",
    "retained_diagnostic_bytes",
    "failed_cleanup_retained_bytes",
    "quarantine_retained_bytes",
    "capacity_revision",
    "last_footprint_sha256",
    "exit_code",
    "terminated_by_signal",
    "diagnostic_capture_sha256",
    "created_at",
    "updated_at",
  ],
  remote_worker_cell_evidence: [
    "registry_workspace_id",
    "assignment_id",
    "assignment_generation",
    "cell_id",
    "evidence_sequence",
    "domain",
    "payload_json",
    "payload_sha256",
    "previous_evidence_sha256",
    "evidence_sha256",
    "recorded_at",
  ],
} as const;

describe("HX-505 remote worker cell schema parity", () => {
  it("keeps SQLite 178 and PostgreSQL 120 paired across exactly two cell/evidence tables", () => {
    assert.equal(
      postgresSql.match(/CREATE TABLE IF NOT EXISTS remote_worker_cell/gu)?.length,
      2,
      "PostgreSQL 120 must add exactly the cell and evidence tables",
    );
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      assert.match(postgresSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
      assert.deepEqual(tableColumns(db, table), [...columns], `${table} SQLite columns drifted`);
      for (const column of columns) {
        assert.match(
          postgresSql,
          new RegExp(`\\b${column}\\s+(?:TEXT|BIGINT)\\b`, "u"),
          `${table}.${column} missing in PostgreSQL`,
        );
      }
      assert.equal(columns[0], "registry_workspace_id", `${table} must prefix identity with registry workspace`);
    }
  });

  it("never stores a transcript, artifact payload, raw terminal output, or credential in either dialect", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.doesNotMatch(
        sql,
        /transcript|artifact_payload|raw_terminal|terminal_output|lease_token|credential|provider_credential|api_key|authorization|secret_material|bearer/iu,
      );
    }
  });

  it("binds the assignment-generation and cell authorities through complete composite foreign keys", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(
        sql,
        /FOREIGN KEY\(registry_workspace_id, assignment_id, assignment_generation\)[\s\S]*REFERENCES remote_worker_assignment_generations/u,
      );
      assert.match(
        sql,
        /FOREIGN KEY\(registry_workspace_id, assignment_id, assignment_generation\)[\s\S]*REFERENCES remote_worker_cells/u,
      );
    }
  });

  it("is purely additive: no frozen table is altered in either dialect", () => {
    assert.equal(schemaSql(db).match(/ALTER TABLE/gu) ?? null, null);
    assert.equal(postgresSql.match(/ALTER TABLE/gu) ?? null, null);
  });

  it("keeps the immutable profile, worst-case reservation, and pinned-image invariants paired", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(sql, /allocated_disk_bytes >= logical_disk_bytes/u);
      assert.match(sql, /backend = 'container'/u);
      assert.match(sql, /egress_posture IN \('deny_all', 'allowlisted'\)/u);
      assert.match(sql, /execution_state IN \('profiled', 'provisioning'\) OR platform_identity_sha256 IS NOT NULL/u);
    }
    assert.match(sqliteSql, /image_digest GLOB 'sha256:\*'/u);
    assert.match(postgresSql, /image_digest ~ '\^sha256:\[0-9a-f\]\{64\}\$'/u);
  });

  it("keeps immutability, CAS, high-water, deletion, and evidence append-only guards paired across dialects", () => {
    const sqliteSql = schemaSql(db);
    for (const trigger of [
      "trg_remote_worker_cells_profile_immutable",
      "trg_remote_worker_cells_revision_cas",
      "trg_remote_worker_cells_high_water_monotonic",
      "trg_remote_worker_cells_no_delete_unless_clean",
      "trg_remote_worker_cell_evidence_chain_guard",
      "trg_remote_worker_cell_evidence_no_update",
      "trg_remote_worker_cell_evidence_no_delete",
    ]) {
      assert.match(sqliteSql, new RegExp(trigger, "u"), `SQLite trigger ${trigger} missing`);
      assert.match(postgresSql, new RegExp(trigger, "u"), `PostgreSQL trigger ${trigger} missing`);
    }
  });

  it("keeps PostgreSQL 120 additive and free of state-changing DML or runtime claims", () => {
    assert.doesNotMatch(
      postgresSql,
      /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+remote_worker|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/iu,
    );
    assert.doesNotMatch(postgresSql, /gateway_route|readiness|\blistener\b|scheduler/iu);
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
         WHERE (type = 'table' OR type = 'trigger') AND name LIKE '%remote_worker_cell%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>
  )
    .map((row) => `${row.name}\n${row.sql}`)
    .join("\n");
}
