import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SKILL_HUB_OPERATION_KINDS } from "@goatcitadel/contracts";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import {
  SKILL_HUB_REMOVE_OPERATION_MIGRATION_NAME,
  SKILL_HUB_REMOVE_OPERATION_POSTGRES_SQL,
  upgradeSkillHubOperationKindsSqlite,
} from "./skill-hub-remove-operation-migration.js";
import { SkillAggregateRevisionRepository } from "./skill-aggregate-revision-repo.js";
import { SkillLifecycleRepository } from "./skill-lifecycle-repo.js";
import { __sqliteInternals } from "./sqlite.js";
import { SystemSettingsRepository } from "./system-settings-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const SQLITE_VERSION = 281;
const POSTGRES_VERSION = 233;
const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

describe("Skill Hub remove operation kind", () => {
  it("is a contract operation kind and is registered under one name in both lineages", () => {
    assert.ok((SKILL_HUB_OPERATION_KINDS as readonly string[]).includes("remove"));
    assert.equal(
      __sqliteInternals.getSchemaMigrationNameForTest(SQLITE_VERSION),
      SKILL_HUB_REMOVE_OPERATION_MIGRATION_NAME,
    );
    const postgres = POSTGRES_MIGRATIONS.find((migration) => migration.version === POSTGRES_VERSION);
    assert.equal(postgres?.name, SKILL_HUB_REMOVE_OPERATION_MIGRATION_NAME);
    assert.equal(postgres?.sql, SKILL_HUB_REMOVE_OPERATION_POSTGRES_SQL);
    assert.match(SKILL_HUB_REMOVE_OPERATION_POSTGRES_SQL, /'revoke', 'remove'/u);
  });

  it("a fresh SQLite install carries both widened checks", () => {
    const db = tempDbs.open({ dbPath: tempDbs.path("goatcitadel-skill-hub-remove-fresh") });
    const table = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'skill_hub_operation_intents'")
      .get() as { sql: string };
    assert.match(table.sql, /'activate', 'revoke', 'remove'/u);
    assert.match(table.sql, /operation_kind IN \('revoke', 'remove'\)/u);
  });

  it("widens an old-shape table once, keeps its indexes and triggers, and is idempotent", () => {
    const legacy = legacyIntentsDatabase();
    try {
      const before = schemaObjects(legacy);
      assert.throws(() => insertIntent(legacy, "operation-remove", "remove"), /CHECK constraint/u);

      upgradeSkillHubOperationKindsSqlite(legacy);

      insertIntent(legacy, "operation-remove", "remove");
      assert.throws(() => insertIntent(legacy, "operation-bogus", "bogus"), /CHECK constraint/u);
      assert.throws(
        () => insertIntent(legacy, "operation-bad-remove", "remove", { expected_runtime_absent: 1 }),
        /CHECK constraint/u,
      );
      assert.deepEqual(schemaObjects(legacy), before);
      assert.equal(count(legacy, "skill_hub_operation_intents"), 2);
      assert.equal(legacy.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_remove_new'").get(), undefined);

      upgradeSkillHubOperationKindsSqlite(legacy);
      assert.equal(count(legacy, "skill_hub_operation_intents"), 2);
    } finally {
      legacy.close();
    }
  });

  it("refuses to rebuild when another table could cascade into the intents", () => {
    const legacy = legacyIntentsDatabase();
    try {
      legacy.exec(
        `CREATE TABLE cascading (id TEXT PRIMARY KEY, op TEXT REFERENCES skill_hub_operation_intents(operation_id) ON DELETE CASCADE);`,
      );
      assert.throws(() => upgradeSkillHubOperationKindsSqlite(legacy), /refuses a mutating reference/u);
    } finally {
      legacy.close();
    }
  });
});

describe("runtime skill record deletion", () => {
  it("delete and deleteFence remove exactly the runtime record", () => {
    const db = tempDbs.open({ dbPath: tempDbs.path("goatcitadel-skill-remove-records") });
    const lifecycle = new SkillLifecycleRepository(db);
    const revisions = new SkillAggregateRevisionRepository(db);
    const now = "2026-11-15T00:00:00.000Z";
    for (const skillId of ["extra:meeting-notes", "extra:other"]) {
      lifecycle.upsert({
        skillId,
        category: "community_imported",
        lifecycleState: "revoked",
        trustLabel: "Revoked",
        createdAt: now,
        updatedAt: now,
      });
      revisions.ensure("runtime_skill", skillId, now);
    }
    revisions.advanceExpectedRevision("runtime_skill", "extra:meeting-notes", 1, now);

    assert.equal(lifecycle.delete("extra:meeting-notes"), true);
    assert.equal(lifecycle.delete("extra:meeting-notes"), false);
    assert.equal(lifecycle.find("extra:meeting-notes"), undefined);
    assert.ok(lifecycle.find("extra:other"));

    assert.throws(
      () => revisions.deleteFence("runtime_skill", "extra:meeting-notes", 99),
      /changed since revision 99/u,
    );
    assert.equal(revisions.get("runtime_skill", "extra:meeting-notes")?.revision, 2);
    revisions.deleteFence("runtime_skill", "extra:meeting-notes", 2);
    assert.equal(revisions.get("runtime_skill", "extra:meeting-notes"), undefined);
    assert.equal(revisions.get("runtime_skill", "extra:other")?.revision, 1);
    assert.throws(() => revisions.deleteFence("runtime_skill", "extra:meeting-notes", 2));
  });

  it("deleteSavedState and a setting's delete remove exactly one skill's saved state", () => {
    const db = tempDbs.open({ dbPath: tempDbs.path("goatcitadel-skill-remove-state") });
    const lifecycle = new SkillLifecycleRepository(db);
    const settings = new SystemSettingsRepository(db);
    const now = "2026-11-15T00:00:00.000Z";
    for (const skillId of ["extra:meeting-notes", "extra:other"]) {
      db.prepare("INSERT INTO skill_state (skill_id, state, note, updated_at) VALUES (?, 'sleep', 'kept', ?)").run(
        skillId,
        now,
      );
    }
    settings.set("curator_idle_skill_snapshot_v1:extra:meeting-notes", { skillId: "extra:meeting-notes" }, now);
    settings.set("curator_idle_skill_snapshot_v1:extra:other", { skillId: "extra:other" }, now);

    assert.equal(lifecycle.deleteSavedState("extra:meeting-notes"), true);
    assert.equal(lifecycle.deleteSavedState("extra:meeting-notes"), false);
    const left = db.prepare("SELECT skill_id AS skillId FROM skill_state ORDER BY skill_id").all() as Array<{
      skillId: string;
    }>;
    assert.deepEqual(
      left.map((row) => row.skillId),
      ["extra:other"],
    );

    assert.equal(settings.delete("curator_idle_skill_snapshot_v1:extra:meeting-notes"), true);
    assert.equal(settings.delete("curator_idle_skill_snapshot_v1:extra:meeting-notes"), false);
    assert.equal(settings.get("curator_idle_skill_snapshot_v1:extra:meeting-notes"), undefined);
    assert.ok(settings.get("curator_idle_skill_snapshot_v1:extra:other"));
  });
});

/** The intent table as the previous version created it, with its three kinds of dependents. */
function legacyIntentsDatabase(): DatabaseSync {
  const fresh = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  const created = tempDbs.open({ dbPath: tempDbs.path("goatcitadel-skill-hub-remove-legacy") });
  const objects = created
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'skill_hub_operation_intents' AND sql IS NOT NULL ORDER BY type DESC, name",
    )
    .all() as Array<{ type: string; name: string; sql: string }>;
  for (const object of objects) {
    if (object.type === "trigger") continue;
    fresh.exec(
      object.sql
        .replace("'activate', 'revoke', 'remove'", "'activate', 'revoke'")
        .replace("operation_kind IN ('revoke', 'remove')", "operation_kind = 'revoke'"),
    );
  }
  fresh.exec(
    `CREATE TRIGGER trg_skill_hub_operation_intents_immutable BEFORE UPDATE ON skill_hub_operation_intents
     BEGIN SELECT RAISE(ABORT, 'operation intents are immutable'); END;`,
  );
  insertIntent(fresh, "operation-revoke", "revoke");
  return fresh;
}

function insertIntent(
  db: DatabaseSync,
  operationId: string,
  kind: string,
  overrides: Record<string, number> = {},
): void {
  db.prepare(
    `INSERT INTO skill_hub_operation_intents (
       operation_id, idempotency_key, workspace_id, operation_kind, approval_id, snapshot_id, content_tree_sha256,
       skill_id, target_candidate_id, target_version_id, expected_candidate_revision, expected_runtime_revision,
       expected_candidate_absent, expected_runtime_absent, actor_id, request_sha256, created_at
     ) VALUES (?, ?, 'workspace-1', ?, ?, 'snapshot-1', ?, 'extra:demo', 'candidate-1', 'version-1', 1, 1, 0, ?, 'operator-1', ?, '2026-11-15T00:00:00.000Z')`,
  ).run(
    operationId,
    `key:${operationId}`,
    kind,
    `approval:${operationId}`,
    "a".repeat(64),
    overrides.expected_runtime_absent ?? 0,
    "b".repeat(64),
  );
}

function schemaObjects(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT type, name FROM sqlite_master WHERE tbl_name = 'skill_hub_operation_intents' ORDER BY type, name",
      )
      .all() as Array<{ type: string; name: string }>
  ).map((row) => `${row.type}:${row.name}`);
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}
