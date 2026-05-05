import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractMigrationNames,
  extractMigrationRecords,
  findMigrationParityErrors,
  findPostgresMigrationImmutabilityErrors,
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
