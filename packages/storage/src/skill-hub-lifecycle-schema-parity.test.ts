import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createDatabase, createSqliteSchemaBlueprint } from "./sqlite.js";

describe("Skill Hub lifecycle foundation schema parity", () => {
  it("pairs additive SQLite 165 with PostgreSQL 107", () => {
    const sqlite = createSqliteSchemaBlueprint();
    const expectedTables: Record<string, string[]> = {
      skill_hub_snapshot_artifacts: [
        "artifact_id",
        "workspace_id",
        "snapshot_id",
        "content_tree_sha256",
        "bundle_rel_path",
        "manifest_version",
        "manifest_json",
        "manifest_sha256",
        "file_count",
        "total_bytes",
        "created_at",
      ],
      skill_hub_operation_intents: [
        "operation_id",
        "idempotency_key",
        "workspace_id",
        "operation_kind",
        "approval_id",
        "snapshot_id",
        "content_tree_sha256",
        "skill_id",
        "target_candidate_id",
        "target_version_id",
        "supersedes_version_id",
        "expected_candidate_revision",
        "expected_runtime_revision",
        "expected_candidate_absent",
        "expected_runtime_absent",
        "actor_id",
        "session_id",
        "turn_id",
        "request_sha256",
        "created_at",
      ],
      skill_hub_operation_settlements: [
        "settlement_id",
        "operation_id",
        "workspace_id",
        "approval_id",
        "content_tree_sha256",
        "disposition",
        "observed_tree_sha256",
        "candidate_version_id",
        "runtime_skill_id",
        "candidate_revision",
        "runtime_revision",
        "evidence_envelope_id",
        "journey_event_id",
        "result_json",
        "result_sha256",
        "settled_at",
      ],
    };
    for (const [tableName, columns] of Object.entries(expectedTables)) {
      const table = sqlite.tables.find((candidate) => candidate.name === tableName);
      assert.ok(table, `missing SQLite ${tableName}`);
      for (const column of columns) {
        assert.ok(
          table.columns.some((candidate) => candidate.name === column),
          `missing ${tableName}.${column}`,
        );
      }
    }

    const postgres = POSTGRES_MIGRATIONS.find((migration) => migration.version === 107);
    assert.equal(postgres?.name, "skill_hub_lifecycle_foundation");
    const sql = postgres?.sql ?? "";
    for (const tableName of Object.keys(expectedTables)) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}`, "u"));
    }
    assert.match(sql, /UNIQUE\(workspace_id, snapshot_id, content_tree_sha256\)/u);
    assert.match(
      sql,
      /FOREIGN KEY\(workspace_id, snapshot_id, content_tree_sha256\)[\s\S]*REFERENCES skill_hub_snapshots/u,
    );
    assert.match(
      sql,
      /FOREIGN KEY\(workspace_id, snapshot_id, content_tree_sha256\)[\s\S]*REFERENCES skill_hub_snapshot_artifacts/u,
    );
    assert.match(
      sql,
      /FOREIGN KEY\(operation_id, workspace_id, approval_id, content_tree_sha256\)[\s\S]*REFERENCES skill_hub_operation_intents/u,
    );
    assert.match(sql, /REFERENCES runtime_evidence_envelopes\(envelope_id, workspace_id, approval_id\)/u);
    assert.match(sql, /REFERENCES governance_journey_events\(event_id, workspace_id, approval_id\)/u);
    assert.match(
      sql,
      /operation_kind IN \('stage_update_candidate', 'stage_rollback_candidate'\)[\s\S]*expected_candidate_absent = 0/u,
    );
    assert.match(sql, /trg_skill_hub_operation_intents_approval_binding/u);
    assert.match(sql, /approval\.payload_json::jsonb = jsonb_build_object/u);
    assert.match(sql, /approval\.linkage_json::jsonb = jsonb_strip_nulls\(jsonb_build_object/u);
    assert.match(sql, /trg_skill_hub_operation_settlements_semantic_binding/u);
    assert.match(sql, /approval_id TEXT NOT NULL UNIQUE/u);
    assert.match(sql, /idempotency_key TEXT NOT NULL UNIQUE/u);
    assert.match(sql, /octet_length\(manifest_json\) <= 262144/u);
    assert.match(sql, /octet_length\(result_json\) <= 16384/u);
    assert.equal((sql.match(/BEFORE UPDATE OR DELETE ON skill_hub_/gu) ?? []).length, 3);
    assert.doesNotMatch(sql, /CREATE TABLE[^;]*outbox|INSERT INTO|UPDATE\s+skill_hub|DELETE FROM|DROP TABLE/iu);
  });

  it("installs the paired SQLite migration with composite lineage and immutable tables", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-hx413-schema-${randomUUID()}.db`);
    const db = createDatabase({ dbPath });
    try {
      const lifecycleMigration = db.prepare("SELECT version, name FROM schema_migrations WHERE version = 165").get<{
        version: number;
        name: string;
      }>();
      assert.equal(lifecycleMigration?.version, 165);
      assert.equal(lifecycleMigration?.name, "skill_hub_lifecycle_foundation");
      const head = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get<{ version: number }>();
      assert.ok((head?.version ?? 0) >= 165);

      const artifactForeignKeys = db.prepare("PRAGMA foreign_key_list(skill_hub_snapshot_artifacts)").all() as Array<{
        table: string;
        from: string;
        to: string;
      }>;
      assert.equal(artifactForeignKeys.filter((item) => item.table === "skill_hub_snapshots").length, 3);
      assert.deepEqual(
        new Set(artifactForeignKeys.filter((item) => item.table === "skill_hub_snapshots").map((item) => item.from)),
        new Set(["workspace_id", "snapshot_id", "content_tree_sha256"]),
      );

      const intentForeignKeys = db.prepare("PRAGMA foreign_key_list(skill_hub_operation_intents)").all() as Array<{
        table: string;
        from: string;
        to: string;
      }>;
      assert.equal(intentForeignKeys.filter((item) => item.table === "skill_hub_snapshot_artifacts").length, 3);
      assert.equal(intentForeignKeys.filter((item) => item.table === "approvals").length, 1);

      const settlementForeignKeys = db
        .prepare("PRAGMA foreign_key_list(skill_hub_operation_settlements)")
        .all() as Array<{ table: string; from: string; to: string }>;
      assert.equal(settlementForeignKeys.filter((item) => item.table === "skill_hub_operation_intents").length, 4);
      assert.equal(settlementForeignKeys.filter((item) => item.table === "runtime_evidence_envelopes").length, 3);
      assert.equal(settlementForeignKeys.filter((item) => item.table === "governance_journey_events").length, 3);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'skill_hub_%'")
        .all() as Array<{ name: string }>;
      assert.equal(
        tables.some((item) => item.name.includes("outbox")),
        false,
      );

      const triggers = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_skill_hub_%_no_%'")
        .all() as Array<{ name: string }>;
      assert.equal(triggers.filter((item) => item.name.includes("snapshot_artifacts")).length, 2);
      assert.equal(triggers.filter((item) => item.name.includes("operation_intents")).length, 2);
      assert.equal(triggers.filter((item) => item.name.includes("operation_settlements")).length, 2);
    } finally {
      db.close();
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    }
  });
});
