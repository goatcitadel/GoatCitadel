import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";
import { __sqliteInternals, createSqliteSchemaBlueprint } from "./sqlite.js";

describe("durable Chat secure configuration reservation schema parity", () => {
  it("keeps the current SQLite blueprint and generated Postgres schema secret-free and aligned", () => {
    const blueprint = createSqliteSchemaBlueprint();
    const reservation = blueprint.tables.find((table) => table.name === "chat_turn_secure_configuration_reservations");
    assert.ok(reservation);
    assert.deepEqual(
      reservation.columns.map((column) => column.name),
      [
        "reservation_id",
        "version",
        "admission_id",
        "session_incarnation_id",
        "workspace_id",
        "session_id",
        "turn_id",
        "durable_run_id",
        "prompt_id",
        "target_id",
        "responder_actor_id",
        "responder_auth_actor_source",
        "waiting_run_version",
        "reserved_run_version",
        "expires_at",
        "status",
        "provider",
        "configuration_revision",
        "scope_ref",
        "reserved_at",
        "reclaimed_at",
        "completed_at",
        "released_at",
        "expired_at",
        "reconciled_at",
        "reconciled_by_reservation_id",
      ],
    );
    assert.equal(
      reservation.columns.some((column) => /secret|credential|token|value|hash|digest/iu.test(column.name)),
      false,
    );
    assert.equal(
      reservation.indexes.find((index) => index.name === "idx_chat_turn_secure_configuration_one_reserved")?.where,
      "status = 'reserved'",
    );
    assert.equal(
      reservation.indexes.find((index) => index.name === "idx_chat_turn_secure_configuration_one_target_scope")?.where,
      "status = 'reserved'",
    );

    const postgres = buildPostgresRuntimeSchemaSql();
    assert.match(postgres, /CREATE TABLE IF NOT EXISTS chat_turn_secure_configuration_reservations/u);
    assert.match(postgres, /idx_chat_turn_secure_configuration_one_reserved/u);
    assert.match(postgres, /reserved_run_version BIGINT NOT NULL/u);
  });

  it("ships matching forward migrations for existing SQLite and Postgres runtimes", () => {
    const postgres = POSTGRES_MIGRATIONS.find((migration) => migration.version === 132);
    assert.equal(postgres?.name, "repair_durable_chat_secure_configuration_reservations");
    assert.match(postgres?.sql ?? "", /chat_turn_secure_configuration_reservations/u);
    assert.match(postgres?.sql ?? "", /expired_unreconciled/u);
    assert.equal(
      __sqliteInternals.getSchemaMigrationNameForTest(189),
      "repair_durable_chat_secure_configuration_reservations",
    );
  });
});
