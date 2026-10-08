import assert from "node:assert/strict";
import test from "node:test";

import { findTempSqliteViolations, isTestSource } from "./check-test-temp-sqlite.mjs";

// Built by concatenation so this file does not trip the checker it tests.
const TMPDIR = "os.tmp" + "dir()";

test("temp SQLite checker rejects a database placed directly in os.tmpdir()", () => {
  const violations = findTempSqliteViolations(
    "packages/storage/src/example-repo.test.ts",
    [
      "const dbPath = path.join(" + TMPDIR + ", `goatcitadel-example-${randomUUID()}.db`);",
      'const other = path.resolve(' + TMPDIR + ', "fixed.sqlite");',
    ].join("\n"),
  );

  assert.deepEqual(
    violations.map((violation) => violation.line),
    [1, 2],
  );
});

test("temp SQLite checker allows databases inside a mkdtemp directory", () => {
  const source = [
    "const dir = fs.mkdtempSync(path.join(" + TMPDIR + ', "goatcitadel-example-"));',
    'const dbPath = path.join(dir, "test.db");',
    "const dbPath2 = tempDbs.path(\"goatcitadel-example\");",
    "const root = path.join(" + TMPDIR + ", `goatcitadel-transcripts-${randomUUID()}`);",
  ].join("\n");

  assert.deepEqual(findTempSqliteViolations("packages/storage/src/example-repo.test.ts", source), []);
});

test("temp SQLite checker only scans test sources", () => {
  assert.equal(isTestSource("packages/storage/src/example-repo.test.ts"), true);
  assert.equal(isTestSource("packages/storage/src/temp-sqlite.test-support.ts"), true);
  assert.equal(isTestSource("scripts/example.test.mjs"), true);
  assert.equal(isTestSource("packages/storage/src/remote-worker-test-fixtures.ts"), true);
  assert.equal(isTestSource("packages/storage/src/sqlite.ts"), false);
});
