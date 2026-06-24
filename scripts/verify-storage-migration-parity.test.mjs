import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import {
  extractMigrationNames,
  extractMigrationRecords,
  findMigrationParityErrors,
  findPostgresMigrationImmutabilityErrors,
  findRuntimeSchemaSemanticGuardErrors,
} from "./verify-storage-migration-parity.mjs";

test("extracts migration names from TypeScript migration arrays", () => {
  assert.deepEqual(
    extractMigrationNames('const migrations = [{ version: 1, name: "one" }, { version: 2, name: "two_parity" }];'),
    ["one", "two_parity"],
  );
});

test("extracts migration records with SQL hashes where available", () => {
  const records = extractMigrationRecords(
    'const migrations = [{ version: 1, name: "one", sql: `SELECT 1;` }, { version: 2, name: "two", sql: buildSql() }];',
  );

  assert.equal(records[0]?.version, 1);
  assert.equal(records[0]?.name, "one");
  assert.match(records[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(records[1]?.sha256, null);
});

test("extracts migration record hashes after resolving frozen string constants", () => {
  const records = extractMigrationRecords(`
    const FROZEN_SQL = "SELECT 2;\\nSELECT 3;";
    const migrations = [{ version: 1, name: "frozen", sql: \`\${FROZEN_SQL}\` }];
  `);

  const expectedHash = crypto.createHash("sha256").update("SELECT 2;\nSELECT 3;").digest("hex");
  assert.equal(records[0]?.sha256, expectedHash);
});

test("requires parity-bearing migrations on both storage backends", () => {
  assert.deepEqual(findMigrationParityErrors(["first", "foo_parity"], ["first"]), [
    "SQLite parity migration missing from Postgres: foo_parity",
  ]);
  assert.deepEqual(findMigrationParityErrors(["first"], ["first", "foo_parity"]), [
    "Postgres parity migration missing from SQLite: foo_parity",
  ]);
});

test("requires shared parity migration ordering to match", () => {
  assert.deepEqual(findMigrationParityErrors(["a_parity", "b_parity"], ["b_parity", "a_parity"]), [
    "SQLite/Postgres parity migration ordering diverges.",
  ]);
  assert.deepEqual(findMigrationParityErrors(["a_parity", "b_parity"], ["a_parity", "b_parity"]), []);
});

test("locks protected Postgres migration versions, names, and SQL hashes", () => {
  const protectedRecords = [{ version: 21, name: "prompt_pack_agentic_diagnostics_repairs", sha256: "abc" }];

  assert.deepEqual(
    findPostgresMigrationImmutabilityErrors(
      [{ version: 21, name: "chat_operator_control_prefs", sha256: "abc" }],
      protectedRecords,
    ),
    [
      "Protected Postgres migration v21 was renamed: expected prompt_pack_agentic_diagnostics_repairs, found chat_operator_control_prefs",
    ],
  );
  assert.deepEqual(
    findPostgresMigrationImmutabilityErrors(
      [{ version: 21, name: "prompt_pack_agentic_diagnostics_repairs", sha256: "def" }],
      protectedRecords,
    ),
    ["Protected Postgres migration v21 SQL hash changed: prompt_pack_agentic_diagnostics_repairs"],
  );
});

test("requires Postgres runtime schema to stay generated from the SQLite blueprint", () => {
  const errors = findRuntimeSchemaSemanticGuardErrors({
    postgresMigrationsSource: `
      export const postgresMigrations = [
        { version: 2, name: "canonical_runtime_schema", sql: buildPostgresRuntimeSchemaSql() },
        { version: 7, name: "canonical_runtime_schema_repairs", sql: \`${"${buildPostgresRuntimeSchemaSql()}"}\` },
      ];
    `,
    runtimeSchemaSource: `
      import { createSqliteSchemaBlueprint } from "../sqlite.js";
      export function buildPostgresRuntimeSchemaSql() {
        return buildPostgresRuntimeSchemaSqlFromBlueprint(createSqliteSchemaBlueprint());
      }
    `,
    runtimeSchemaInternalSource: `
      table.columns;
      table.indexes;
      table.foreignKeys;
      table.seedRows;
    `,
  });

  assert.deepEqual(errors, []);
});

test("allows frozen v7 runtime schema repairs after the historical SQL is embedded", () => {
  const errors = findRuntimeSchemaSemanticGuardErrors({
    postgresMigrationsSource: `
      const POSTGRES_V7_FROZEN_SCHEMA_SQL = "CREATE TABLE sessions ();";
      export const postgresMigrations = [
        { version: 2, name: "canonical_runtime_schema", sql: buildPostgresRuntimeSchemaSql() },
        { version: 7, name: "canonical_runtime_schema_repairs", sql: \`\${POSTGRES_V7_FROZEN_SCHEMA_SQL}\` },
      ];
    `,
    runtimeSchemaSource: `
      import { createSqliteSchemaBlueprint } from "../sqlite.js";
      export function buildPostgresRuntimeSchemaSql() {
        return buildPostgresRuntimeSchemaSqlFromBlueprint(createSqliteSchemaBlueprint());
      }
    `,
    runtimeSchemaInternalSource: `
      table.columns;
      table.indexes;
      table.foreignKeys;
      table.seedRows;
    `,
  });

  assert.deepEqual(errors, []);
});

test("fails when Postgres runtime schema stops consuming the SQLite blueprint end state", () => {
  const errors = findRuntimeSchemaSemanticGuardErrors({
    postgresMigrationsSource: `
      export const postgresMigrations = [
        { version: 2, name: "canonical_runtime_schema", sql: "CREATE TABLE sessions();" },
        { version: 7, name: "canonical_runtime_schema_repairs", sql: "ALTER TABLE sessions ADD COLUMN title TEXT;" },
      ];
    `,
    runtimeSchemaSource: `
      export function buildPostgresRuntimeSchemaSql() {
        return "CREATE TABLE sessions();";
      }
    `,
    runtimeSchemaInternalSource: `
      table.columns;
    `,
  });

  assert.deepEqual(errors, [
    "Postgres canonical runtime schema migration must be generated from the SQLite schema blueprint.",
    "Postgres runtime schema repair migration must replay the generated SQLite schema blueprint.",
    "Postgres runtime schema generator must import createSqliteSchemaBlueprint from SQLite storage.",
    "Postgres runtime schema generator must render from createSqliteSchemaBlueprint().",
    "Postgres runtime schema renderer must consume SQLite blueprint field: table.indexes",
    "Postgres runtime schema renderer must consume SQLite blueprint field: table.foreignKeys",
    "Postgres runtime schema renderer must consume SQLite blueprint field: table.seedRows",
  ]);
});
