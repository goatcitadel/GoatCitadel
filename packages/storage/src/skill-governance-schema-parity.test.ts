import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createDatabase, createSqliteSchemaBlueprint } from "./sqlite.js";

describe("skill governance and Journey schema parity", () => {
  it("pairs forward-only SQLite 161 with PostgreSQL 103", () => {
    const sqlite = createSqliteSchemaBlueprint();
    const expectedTables: Record<string, string[]> = {
      skill_hub_audit_floors: [
        "workspace_id",
        "canonical_source_key",
        "floor_json",
        "floor_sha256",
        "updated_by_snapshot_id",
        "created_at",
        "updated_at",
      ],
      skill_hub_version_claims: [
        "workspace_id",
        "canonical_source_key",
        "version_kind",
        "version_value",
        "first_tree_sha256",
        "first_snapshot_id",
        "created_at",
      ],
      skill_hub_snapshots: [
        "snapshot_id",
        "workspace_id",
        "canonical_source_key",
        "declared_version",
        "resolved_version",
        "content_tree_sha256",
        "audit_json",
        "audit_sha256",
        "audit_floor_json",
        "audit_floor_sha256",
        "permission_envelope_json",
        "permission_envelope_sha256",
        "permission_diff_json",
        "blocker_codes_json",
      ],
      skill_learning_evidence: [
        "evidence_id",
        "idempotency_key",
        "workspace_id",
        "target_key",
        "fingerprint",
        "source_session_id",
        "source_turn_id",
        "source_message_id",
        "provenance_json",
        "poisoning_status",
      ],
      candidate_skill_evidence_links: ["version_id", "evidence_id", "linked_at"],
      governance_journey_events: [
        "schema_version",
        "event_id",
        "idempotency_key",
        "scope_kind",
        "workspace_id",
        "event_type",
        "subject_kind",
        "subject_id",
        "fingerprint",
        "evidence_refs_json",
        "provenance_json",
        "summary_json",
        "recorded_at",
      ],
    };
    for (const [tableName, columns] of Object.entries(expectedTables)) {
      const table = sqlite.tables.find((candidate) => candidate.name === tableName);
      assert.ok(table, `missing SQLite ${tableName}`);
      for (const column of columns) {
        assert.ok(
          table.columns.some((candidate) => candidate.name === column),
          `missing SQLite ${tableName}.${column}`,
        );
      }
    }
    const candidate = sqlite.tables.find((table) => table.name === "candidate_skill_versions");
    assert.ok(candidate);
    for (const column of [
      "workspace_id",
      "source_fingerprint",
      "upstream_snapshot_id",
      "supersedes_version_id",
      "created_by_actor_id",
    ]) {
      assert.ok(
        candidate.columns.some((item) => item.name === column),
        `missing SQLite candidate ${column}`,
      );
    }

    const postgres = POSTGRES_MIGRATIONS.find((migration) => migration.version === 103);
    assert.equal(postgres?.name, "skill_governance_journey_foundation");
    const sql = postgres?.sql ?? "";
    for (const column of [
      "workspace_id",
      "source_fingerprint",
      "upstream_snapshot_id",
      "supersedes_version_id",
      "created_by_actor_id",
    ]) {
      assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} TEXT`, "u"));
    }
    for (const tableName of Object.keys(expectedTables)) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}`, "u"));
    }
    assert.match(sql, /PRIMARY KEY \(workspace_id, canonical_source_key, version_kind, version_value\)/u);
    assert.match(sql, /gc_guard_candidate_skill_version_mutation/u);
    assert.match(sql, /gc_reject_skill_governance_immutable_mutation/u);
    assert.match(sql, /gc_guard_skill_hub_audit_floor_mutation/u);
    assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE ON candidate_skill_versions/u);
    assert.match(sql, /BEFORE UPDATE OR DELETE ON skill_hub_version_claims/u);
    assert.match(sql, /BEFORE UPDATE OR DELETE ON skill_hub_audit_floors/u);
    assert.match(sql, /effectiveBlockerCodes/u);
    assert.match(sql, /coverageIds/u);
    assert.match(sql, /scope_kind IN \('workspace', 'global'\)/u);
    assert.match(sql, /poisoning_status IN \('clean', 'blocked', 'quarantined', 'conflicting'\)/u);
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|UPDATE candidate_skill_versions SET/u);
  });

  it("enforces SQLite inactive candidates and immutable version claims at the database boundary", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-skill-governance-parity-${randomUUID()}.db`);
    const db = createDatabase({ dbPath });
    try {
      const migration = db.prepare("SELECT name FROM schema_migrations WHERE version = 161").get<{ name: string }>();
      assert.equal(migration?.name, "skill_governance_journey_foundation");

      const candidateInsert = db.prepare(`
        INSERT INTO candidate_skill_versions (
          candidate_id, version_id, source_kind, title, summary, bundle_root, originating_run_id,
          wrapper_manifest_hash, lifecycle_state, manifest_artifact_json, instruction_artifact_json,
          proof_artifact_json, program_artifact_json, schema_artifact_json, created_at, updated_at,
          last_successful_execution_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      assert.throws(
        () =>
          candidateInsert.run(
            "candidate-1",
            "version-rejected",
            "manual",
            "Rejected",
            null,
            "skills/rejected",
            null,
            null,
            "approved",
            "{}",
            "{}",
            "{}",
            null,
            null,
            "2026-07-13T12:00:00.000Z",
            "2026-07-13T12:00:00.000Z",
            null,
          ),
        /must be inserted inactive/,
      );
      candidateInsert.run(
        "candidate-1",
        "version-1",
        "manual",
        "Candidate",
        null,
        "skills/candidate",
        null,
        null,
        "candidate",
        "{}",
        "{}",
        "{}",
        null,
        null,
        "2026-07-13T12:00:00.000Z",
        "2026-07-13T12:00:00.000Z",
        null,
      );
      db.prepare("UPDATE candidate_skill_versions SET lifecycle_state = ?, updated_at = ? WHERE version_id = ?").run(
        "approved",
        "2026-07-13T12:01:00.000Z",
        "version-1",
      );
      assert.throws(
        () =>
          db.prepare("UPDATE candidate_skill_versions SET title = ? WHERE version_id = ?").run("Changed", "version-1"),
        /content and provenance are immutable/,
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE candidate_skill_versions SET source_fingerprint = ? WHERE version_id = ?")
            .run("a".repeat(64), "version-1"),
        /content and provenance are immutable/,
      );

      db.prepare(
        `
        INSERT INTO skill_hub_version_claims (
          workspace_id, canonical_source_key, version_kind, version_value,
          first_tree_sha256, first_snapshot_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        "workspace-1",
        "github:owner/repo:skill/demo",
        "resolved",
        "1".repeat(40),
        "a".repeat(64),
        "snapshot-1",
        "2026-07-13T12:00:00.000Z",
      );
      assert.throws(
        () => db.prepare("UPDATE skill_hub_version_claims SET first_tree_sha256 = ?").run("b".repeat(64)),
        /version claims are immutable/,
      );
      assert.throws(() => db.prepare("DELETE FROM skill_hub_version_claims").run(), /version claims are immutable/);

      const floor = {
        version: "goatcitadel.skill-upstream-audit-floor.v1",
        policyId: "skill-import",
        policyVersion: "10.0.0",
        policyRevision: 10,
        scanners: [
          { scannerId: "static", scannerVersion: "10.0.0", revision: 10, coverageIds: ["scripts", "secrets"] },
        ],
        effectiveBlockerCodes: ["AUDIT_DOWNGRADE"],
      };
      db.prepare(
        `
        INSERT INTO skill_hub_audit_floors (
          workspace_id, canonical_source_key, floor_json, floor_sha256,
          updated_by_snapshot_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        "workspace-1",
        "github:owner/repo:skill/demo",
        JSON.stringify(floor),
        "c".repeat(64),
        "snapshot-10",
        "2026-07-13T12:10:00.000Z",
        "2026-07-13T12:10:00.000Z",
      );
      assert.throws(
        () =>
          db.prepare("UPDATE skill_hub_audit_floors SET floor_json = ?").run(
            JSON.stringify({
              ...floor,
              policyVersion: "6.0.0",
              policyRevision: 6,
              scanners: [{ scannerId: "static", scannerVersion: "6.0.0", revision: 6, coverageIds: ["scripts"] }],
              effectiveBlockerCodes: [],
            }),
          ),
        /audit floors are monotonic/,
      );
      assert.throws(() => db.prepare("DELETE FROM skill_hub_audit_floors").run(), /audit floors cannot be deleted/);
    } finally {
      db.close();
      try {
        fs.rmSync(dbPath, { force: true });
        fs.rmSync(`${dbPath}-wal`, { force: true });
        fs.rmSync(`${dbPath}-shm`, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
  });
});
