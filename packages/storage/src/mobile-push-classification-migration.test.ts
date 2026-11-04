import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  MOBILE_PUSH_APPROVAL_RESOLVED_MIGRATION_NAME,
  MOBILE_PUSH_APPROVAL_RESOLVED_POSTGRES_SQL,
} from "./mobile-push-classification-migration.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createMobilePushSchema } from "./sqlite/mobile-push-schema.js";
import { Storage } from "./index.js";
import { __sqliteInternals } from "./sqlite.js";

const SQLITE_VERSION = 276;
const POSTGRES_VERSION = 225;
const NOW = "2026-11-02T00:00:00.000Z";

/** The v195 shape: the delivery table before the wider classification list. */
function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE auth_device_grants (grant_id TEXT PRIMARY KEY); INSERT INTO auth_device_grants VALUES ('grant-1');`,
  );
  createMobilePushSchema(db);
  db.prepare(
    `INSERT INTO mobile_push_registrations (
       registration_id, grant_id, provider, token_secret_ref, token_sha256, lifecycle_state, revision,
       registered_at, updated_at
     ) VALUES ('registration-1', 'grant-1', 'expo', 'keychain:goatcitadel:mobile-push:registration-1', ?, 'active', 1, ?, ?)`,
  ).run("a".repeat(64), NOW, NOW);
  insertDelivery(db, "delivery-skipped", "registration_revoked");
  return db;
}

function insertDelivery(db: DatabaseSync, deliveryId: string, classification: string): void {
  db.prepare(
    `INSERT INTO mobile_push_deliveries (
       delivery_id, registration_id, source_realtime_event_id, approval_id, event_kind, payload_json, payload_sha256,
       status, last_classification, created_at, updated_at, completed_at
     ) VALUES (?, 'registration-1', ?, ?, 'approval_refresh', '{}', ?, 'cancelled_revoked', ?, ?, ?, ?)`,
  ).run(deliveryId, `event-${deliveryId}`, `approval-${deliveryId}`, "b".repeat(64), classification, NOW, NOW, NOW);
}

function deliveryIndexes(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mobile_push_deliveries' AND sql IS NOT NULL ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("mobile push approval-already-resolved classification migration", () => {
  it("is registered under one shared name in both lineages", () => {
    assert.equal(
      __sqliteInternals.getSchemaMigrationNameForTest(SQLITE_VERSION),
      MOBILE_PUSH_APPROVAL_RESOLVED_MIGRATION_NAME,
    );
    const postgres = POSTGRES_MIGRATIONS.find((migration) => migration.version === POSTGRES_VERSION);
    assert.equal(postgres?.name, MOBILE_PUSH_APPROVAL_RESOLVED_MIGRATION_NAME);
    assert.equal(postgres?.sql, MOBILE_PUSH_APPROVAL_RESOLVED_POSTGRES_SQL);
    assert.equal(POSTGRES_MIGRATIONS.at(-1)?.version, 228);
    assert.match(MOBILE_PUSH_APPROVAL_RESOLVED_POSTGRES_SQL, /'approval_already_resolved'/u);
  });

  it("widens an upgraded SQLite table, keeps its rows and indexes, and still refuses unknown values", () => {
    const db = legacyDatabase();
    try {
      const indexesBefore = deliveryIndexes(db);
      assert.throws(() => insertDelivery(db, "delivery-before", "approval_already_resolved"), /CHECK constraint/u);

      __sqliteInternals.applySchemaMigrationForTest(SQLITE_VERSION, db);

      const kept = db
        .prepare(
          "SELECT status, last_classification FROM mobile_push_deliveries WHERE delivery_id = 'delivery-skipped'",
        )
        .get() as { status: string; last_classification: string };
      assert.deepEqual({ ...kept }, { status: "cancelled_revoked", last_classification: "registration_revoked" });
      insertDelivery(db, "delivery-answered", "approval_already_resolved");
      assert.throws(() => insertDelivery(db, "delivery-bogus", "approval_bogus"), /CHECK constraint/u);
      assert.deepEqual(deliveryIndexes(db), indexesBefore);
      assert.equal(indexesBefore.length, 4);

      // Running it again changes nothing.
      __sqliteInternals.applySchemaMigrationForTest(SQLITE_VERSION, db);
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM mobile_push_deliveries").get() as { count: number }).count,
        2,
      );
      assert.equal(
        db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%classification_new%'").get(),
        undefined,
      );
    } finally {
      db.close();
    }
  });

  it("gives a fresh SQLite install the wider list", () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
    try {
      const table = storage.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mobile_push_deliveries'")
        .get() as { sql: string };
      assert.match(table.sql, /'registration_revoked', 'approval_already_resolved'/u);
    } finally {
      storage.close();
    }
  });
});
