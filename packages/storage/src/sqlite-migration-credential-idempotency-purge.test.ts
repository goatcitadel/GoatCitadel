import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { __sqliteInternals } from "./sqlite.js";

const MIGRATION_VERSION = 253;
const MIGRATION_NAME = "purge_credential_route_idempotency_payload_hashes";
const SENTINEL = createHash("sha256").update("credential_route_historical_payload_hash_purged_v1").digest("hex");
const CREDENTIAL_ROUTES = ["/api/v1/secrets/providers/:providerId", "/api/v1/auth/settings"] as const;

interface IdempotencyRow {
  method: string;
  route_path: string;
  idempotency_key: string;
  actor_scope: string;
  payload_hash: string;
  status: string;
  created_at: string;
  updated_at: string;
  claim_token: string | null;
  claim_expires_at: string | null;
}

function createIdempotencyTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE mutation_idempotency (
      method TEXT NOT NULL,
      route_path TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      actor_scope TEXT NOT NULL DEFAULT '',
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claim_token TEXT,
      claim_expires_at TEXT,
      PRIMARY KEY (method, route_path, idempotency_key, actor_scope)
    );
  `);
}

function insertRow(db: DatabaseSync, row: IdempotencyRow): void {
  db.prepare(
    `INSERT INTO mutation_idempotency (
       method, route_path, idempotency_key, actor_scope, payload_hash, status,
       created_at, updated_at, claim_token, claim_expires_at
     ) VALUES (
       @method, @route_path, @idempotency_key, @actor_scope, @payload_hash, @status,
       @created_at, @updated_at, @claim_token, @claim_expires_at
     )`,
  ).run({ ...row });
}

function bodyHash(label: string): string {
  // Synthetic stand-in for a historical unsalted body hash; no real credential.
  return createHash("sha256").update(`synthetic-body-${label}`).digest("hex");
}

function row(
  overrides: Partial<IdempotencyRow> & Pick<IdempotencyRow, "route_path" | "idempotency_key">,
): IdempotencyRow {
  return {
    method: "PUT",
    actor_scope: "operator:test",
    payload_hash: bodyHash(overrides.idempotency_key),
    status: "completed",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    claim_token: null,
    claim_expires_at: null,
    ...overrides,
  };
}

function readRows(db: DatabaseSync): IdempotencyRow[] {
  return (
    db
      .prepare("SELECT * FROM mutation_idempotency ORDER BY route_path, idempotency_key")
      .all() as unknown as IdempotencyRow[]
  ).map((item) => ({ ...item }));
}

describe("sqlite credential-route idempotency payload hash purge", () => {
  it("is registered under the shared migration name", () => {
    assert.equal(__sqliteInternals.getSchemaMigrationNameForTest(MIGRATION_VERSION), MIGRATION_NAME);
  });

  it("replaces historical credential-route payload hashes with the fixed sentinel only", () => {
    const db = new DatabaseSync(":memory:");
    try {
      createIdempotencyTable(db);
      const credentialRows = [
        row({ route_path: CREDENTIAL_ROUTES[0], idempotency_key: "provider-key-1" }),
        row({
          route_path: CREDENTIAL_ROUTES[0],
          idempotency_key: "provider-key-2",
          status: "pending",
          claim_token: "claim-a",
          claim_expires_at: "2026-01-03T00:00:00.000Z",
        }),
        row({ route_path: CREDENTIAL_ROUTES[1], idempotency_key: "auth-key-1", method: "PATCH" }),
      ];
      const otherRows = [
        row({ route_path: "/api/v1/integrations/connections", idempotency_key: "other-1", method: "POST" }),
        row({ route_path: "/api/v1/secrets/providers", idempotency_key: "other-2", method: "POST" }),
        row({ route_path: "/api/v1/auth/settings/extra", idempotency_key: "other-3" }),
      ];
      for (const item of [...credentialRows, ...otherRows]) insertRow(db, item);
      const before = readRows(db);

      __sqliteInternals.applySchemaMigrationForTest(MIGRATION_VERSION, db);
      const after = readRows(db);

      assert.equal(after.length, before.length, "rows must never be deleted");
      for (const previous of before) {
        const current = after.find(
          (candidate) =>
            candidate.route_path === previous.route_path && candidate.idempotency_key === previous.idempotency_key,
        );
        assert.ok(current);
        if ((CREDENTIAL_ROUTES as readonly string[]).includes(previous.route_path)) {
          assert.equal(current.payload_hash, SENTINEL);
          assert.notEqual(previous.payload_hash, SENTINEL);
          assert.deepEqual({ ...current, payload_hash: previous.payload_hash }, previous);
        } else {
          assert.deepEqual(current, previous);
        }
      }
    } finally {
      db.close();
    }
  });

  it("is a no-op when the table is missing or empty and idempotent on re-run", () => {
    const missing = new DatabaseSync(":memory:");
    try {
      assert.doesNotThrow(() => __sqliteInternals.applySchemaMigrationForTest(MIGRATION_VERSION, missing));
    } finally {
      missing.close();
    }

    const db = new DatabaseSync(":memory:");
    try {
      createIdempotencyTable(db);
      __sqliteInternals.applySchemaMigrationForTest(MIGRATION_VERSION, db);
      assert.deepEqual(readRows(db), []);

      insertRow(db, row({ route_path: CREDENTIAL_ROUTES[1], idempotency_key: "auth-key-rerun" }));
      insertRow(db, row({ route_path: "/api/v1/tasks", idempotency_key: "tasks-rerun", method: "POST" }));
      __sqliteInternals.applySchemaMigrationForTest(MIGRATION_VERSION, db);
      const once = readRows(db);
      __sqliteInternals.applySchemaMigrationForTest(MIGRATION_VERSION, db);
      assert.deepEqual(readRows(db), once);
      assert.equal(once.find((item) => item.route_path === CREDENTIAL_ROUTES[1])?.payload_hash, SENTINEL);
      assert.equal(once.find((item) => item.route_path === "/api/v1/tasks")?.payload_hash, bodyHash("tasks-rerun"));
    } finally {
      db.close();
    }
  });
});
