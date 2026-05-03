import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMigrationNames, findMigrationParityErrors } from "./verify-storage-migration-parity.mjs";

test("extracts migration names from TypeScript migration arrays", () => {
  assert.deepEqual(
    extractMigrationNames('const migrations = [{ version: 1, name: "one" }, { version: 2, name: "two_parity" }];'),
    ["one", "two_parity"],
  );
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
