import assert from "node:assert/strict";
import { after, test } from "node:test";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();
after(() => tempDbs.cleanup());

const legacySealed = JSON.stringify({ iv: "synthetic-iv", ciphertext: "synthetic-ciphertext", tag: "synthetic-tag" });
const now = "2026-10-19T00:00:00.000Z";

function insertKey(
  db: ReturnType<TempSqliteFiles["open"]>,
  input: { keyId: string; scopeKey: string; dekVersion: number; active: boolean },
) {
  db.prepare(
    `INSERT INTO citadel_vault_keys (key_id, citadel_id, chamber_id, scope_key, active_scope_key, dek_version,
      kek_version, wrapped_dek_json, created_at, updated_at)
    VALUES (@keyId, 'c1', NULLIF(@scopeKey, ''), @scopeKey, @active, @dekVersion, 1, '{}', @now, @now)`,
  ).run({ ...input, active: input.active ? input.scopeKey : null, now });
}

function insertRotation(db: ReturnType<TempSqliteFiles["open"]>, rotationId: string, open: boolean) {
  db.prepare(
    `INSERT INTO citadel_vault_rotations (rotation_id, citadel_id, open_citadel_id, target, phase, requested_by,
      reason, created_at, updated_at)
    VALUES (@rotationId, 'c1', @open, 'dek', 'awaiting_approval', 'operator', 'scheduled', @now, @now)`,
  ).run({ rotationId, open: open ? "c1" : null, now });
}

test("v269 preserves existing sealed rows as legacy envelopes with no key or scope", () => {
  const dbPath = tempDbs.path("gc-vault-key-schema-upgrade");
  const first = tempDbs.open({ dbPath });
  // Roll the fully migrated database back to the v268 shape, then seed a legacy secret.
  first.exec(`
    DROP TABLE citadel_vault_keys;
    DROP TABLE citadel_vault_key_state;
    DROP TABLE citadel_vault_rotations;
    DROP INDEX idx_citadel_vault_secrets_key;
    ALTER TABLE citadel_vault_secrets DROP COLUMN chamber_id;
    ALTER TABLE citadel_vault_secrets DROP COLUMN key_id;
    ALTER TABLE citadel_vault_secrets DROP COLUMN envelope_version;
    DELETE FROM schema_migrations WHERE version = 269;
  `);
  first
    .prepare(
      `INSERT INTO citadel_vault_secrets (secret_id, citadel_id, secret_name, sealed_value_json, created_at, updated_at)
    VALUES ('s1', 'c1', 'Legacy', @sealed, @now, @now)`,
    )
    .run({ sealed: legacySealed, now });
  first.close();

  const upgraded = tempDbs.open({ dbPath });
  const row = upgraded
    .prepare("SELECT * FROM citadel_vault_secrets WHERE secret_id = 's1'")
    .get<Record<string, unknown>>();
  assert.equal(row?.sealed_value_json, legacySealed);
  assert.equal(row?.envelope_version, 1);
  assert.equal(row?.key_id, null);
  assert.equal(row?.chamber_id, null);
  assert.equal(row?.created_at, now);
  assert.equal(row?.updated_at, now);
  assert.equal(upgraded.prepare("SELECT count(*) AS count FROM citadel_vault_keys").get<{ count: number }>()?.count, 0);
});

test("rejects a second active key for the same scope", () => {
  const db = tempDbs.open({ dbPath: tempDbs.path("gc-vault-key-schema-active") });
  insertKey(db, { keyId: "k1", scopeKey: "ch1", dekVersion: 1, active: true });
  assert.throws(() => insertKey(db, { keyId: "k2", scopeKey: "ch1", dekVersion: 2, active: true }), /UNIQUE/);
  insertKey(db, { keyId: "k3", scopeKey: "ch1", dekVersion: 3, active: false });
});

test("rejects a duplicate data key version for a scope", () => {
  const db = tempDbs.open({ dbPath: tempDbs.path("gc-vault-key-schema-version") });
  insertKey(db, { keyId: "k1", scopeKey: "ch1", dekVersion: 1, active: false });
  assert.throws(() => insertKey(db, { keyId: "k2", scopeKey: "ch1", dekVersion: 1, active: false }), /UNIQUE/);
});

test("allows a Citadel-scope and a Chamber-scope active key side by side", () => {
  const db = tempDbs.open({ dbPath: tempDbs.path("gc-vault-key-schema-scopes") });
  insertKey(db, { keyId: "k1", scopeKey: "", dekVersion: 1, active: true });
  insertKey(db, { keyId: "k2", scopeKey: "ch1", dekVersion: 1, active: true });
  const scopes = db
    .prepare("SELECT chamber_id FROM citadel_vault_keys ORDER BY key_id")
    .all<{ chamber_id: string | null }>();
  assert.deepEqual(
    scopes.map((row) => row.chamber_id),
    [null, "ch1"],
  );
});

test("rejects a second open rotation for a Citadel but keeps closed history", () => {
  const db = tempDbs.open({ dbPath: tempDbs.path("gc-vault-key-schema-rotation") });
  insertRotation(db, "r1", true);
  assert.throws(() => insertRotation(db, "r2", true), /UNIQUE/);
  insertRotation(db, "r3", false);
  insertRotation(db, "r4", false);
});
