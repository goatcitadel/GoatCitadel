import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildExternalSourcesLaneChecks,
  buildRowCompletionMatrix,
  deriveCheckStatus,
  deriveLaneStatus,
  deriveRowCompletionStatuses,
  parseNodeTestCounts,
  parseVitestCounts,
  scanForProductionProofGate,
} from "./external-sources-lane.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const EXPECTED_CHECK_IDS = [
  "external-sources.contracts",
  "external-sources.storage-core",
  "external-sources.gateway-services",
  "external-sources.routes-and-effects",
  "external-sources.integration",
  "external-sources.static-gate-scan",
  "external-sources.typecheck",
  "external-sources.live-postgres",
];

test("the lane check table is complete, uniquely named, and cites only test files that exist", () => {
  const checks = buildExternalSourcesLaneChecks();
  assert.deepEqual(
    checks.map((check) => check.id),
    EXPECTED_CHECK_IDS,
  );
  assert.equal(new Set(checks.map((check) => check.id)).size, checks.length);

  // Every vitest/node-test file-path filter must point at a real file — a
  // renamed suite would otherwise silently run zero tests (the count guard
  // would catch it at run time; this catches it at review time).
  const packageDirs = new Map([
    ["@goatcitadel/contracts", "packages/contracts"],
    ["@goatcitadel/storage", "packages/storage"],
    ["@goatcitadel/gateway", "apps/gateway"],
    ["@goatcitadel/mission-control-shared", "packages/mission-control-shared"],
  ]);
  for (const check of checks) {
    if (!check.args) continue;
    const filterIndex = check.args.indexOf("--filter");
    const packageName = check.args[filterIndex + 1];
    const packageDir = packageDirs.get(packageName);
    assert.ok(packageDir, `${check.id} filters a known package (${packageName})`);
    for (const arg of check.args) {
      if (!arg.startsWith("src/") || !/\.test\.(ts|tsx|mts)$/u.test(arg)) continue;
      const filePath = path.join(repoRoot, packageDir, arg);
      assert.ok(fs.existsSync(filePath), `${check.id} cites an existing suite: ${packageDir}/${arg}`);
    }
    if (check.count) {
      assert.ok(["vitest", "node-test"].includes(check.count), `${check.id} declares a known counter kind`);
    }
  }
  const livePostgres = checks.find((check) => check.id === "external-sources.live-postgres");
  assert.equal(livePostgres.kind, "live-postgres");
  assert.equal(livePostgres.requireAllExecuted, true, "the live-PG check may never self-skip inside the lane");
  assert.ok(
    fs.existsSync(path.join(repoRoot, "packages/storage/src/external-source-closure-repo.postgres.test.ts")),
    "the live-PG suite exists",
  );
});

test("the row-completion matrix covers the packet's four rows with exactly the two declared C4b skips", () => {
  const matrix = buildRowCompletionMatrix();
  assert.deepEqual(
    matrix.map((row) => row.row),
    [1, 2, 3, 4],
  );
  const knownChecks = new Set(EXPECTED_CHECK_IDS);
  for (const row of matrix) {
    for (const check of row.checks) {
      assert.ok(knownChecks.has(check), `row ${row.row} cites known check ${check}`);
    }
  }
  const skipRows = matrix.filter((row) => typeof row.skipReason === "string" && row.skipReason.length > 0);
  assert.deepEqual(
    skipRows.map((row) => row.row),
    [2, 3],
    "only the browser path (C4b) and visual coverage (C4b) rows carry skip reasons",
  );
  for (const row of skipRows) {
    assert.match(row.skipReason, /C4b/u, `row ${row.row} names the owning tranche`);
  }
  const laneRow = matrix.find((row) => row.row === 4);
  assert.deepEqual([...laneRow.checks].sort(), [...EXPECTED_CHECK_IDS].sort(), "row 4 requires every lane check");
});

test("runner count parsers read vitest and node:test summaries", () => {
  assert.deepEqual(parseVitestCounts("Tests  24 passed (24)"), { failed: 0, passed: 24 });
  assert.deepEqual(parseVitestCounts("Tests  2 failed | 22 passed (24)"), { failed: 2, passed: 22 });
  assert.equal(parseVitestCounts("no summary here"), undefined);
  assert.deepEqual(parseNodeTestCounts("# pass 11\n# fail 0\n# skipped 0"), { failed: 0, passed: 11, skipped: 0 });
  assert.deepEqual(parseNodeTestCounts("ℹ pass 1\nℹ fail 0\nℹ skipped 1"), {
    failed: 0,
    passed: 1,
    skipped: 1,
  });
  assert.equal(parseNodeTestCounts("nothing"), undefined);
});

test("the zero-test honesty guard fails exit-0 runs that executed nothing and self-skipped live-PG runs", () => {
  assert.equal(
    deriveCheckStatus({ exitCode: 1, countKind: "vitest", counts: { failed: 0, passed: 3 } }).status,
    "failed",
  );
  assert.equal(deriveCheckStatus({ exitCode: 0, countKind: "vitest", counts: undefined }).status, "failed");
  assert.equal(
    deriveCheckStatus({ exitCode: 0, countKind: "vitest", counts: { failed: 0, passed: 0 } }).status,
    "failed",
  );
  assert.equal(
    deriveCheckStatus({ exitCode: 0, countKind: "vitest", counts: { failed: 1, passed: 9 } }).status,
    "failed",
  );
  assert.equal(
    deriveCheckStatus({ exitCode: 0, countKind: "node-test", counts: { failed: 0, passed: 5, skipped: 0 } }).status,
    "passed",
  );
  const selfSkipped = deriveCheckStatus({
    exitCode: 0,
    countKind: "node-test",
    counts: { failed: 0, passed: 1, skipped: 1 },
    requireAllExecuted: true,
  });
  assert.equal(selfSkipped.status, "failed");
  assert.match(selfSkipped.failureNote, /C4 HOLD/u);
  assert.equal(deriveCheckStatus({ exitCode: 0 }).status, "passed");
});

test("the static gate scan fails on production references and ignores tests and docs", () => {
  const gateLine = 'if (process.env.GOATCITADEL_INTERNAL_HX407_EXTERNAL_SOURCES_PROOF_ENABLED === "1") {';
  const dirty = scanForProductionProofGate([
    { path: "apps/gateway/src/app.ts", content: `x\n${gateLine}\n` },
    { path: "apps/gateway/src/external-sources.integration.test.ts", content: gateLine },
    { path: "docs/review/HX_407_CLOSURE_PACKET_2026-07-14.md", content: gateLine },
  ]);
  assert.equal(dirty.passed, false);
  assert.deepEqual(dirty.matches, [{ file: "apps/gateway/src/app.ts", line: 2, text: gateLine }]);
  const clean = scanForProductionProofGate([
    { path: "apps/gateway/src/app.ts", content: "await app.register(externalSourceRoutes, { service });" },
    { path: "apps/gateway/src/external-sources.integration.test.ts", content: gateLine },
  ]);
  assert.equal(clean.passed, true);
});

test("row statuses fold check results honestly and the lane status is fail-closed", () => {
  const matrix = buildRowCompletionMatrix();
  const allPassed = new Map(EXPECTED_CHECK_IDS.map((id) => [id, { id, status: "passed" }]));
  const rows = deriveRowCompletionStatuses(matrix, allPassed);
  assert.deepEqual(
    rows.map((row) => [row.row, row.status]),
    [
      [1, "executed"],
      [2, "executed_with_declared_c4b_skip"],
      [3, "skipped"],
      [4, "executed"],
    ],
  );
  assert.equal(deriveLaneStatus(allPassed, rows), "passed");

  const withFailure = new Map(allPassed);
  withFailure.set("external-sources.live-postgres", { id: "external-sources.live-postgres", status: "failed" });
  const failedRows = deriveRowCompletionStatuses(matrix, withFailure);
  assert.equal(failedRows.find((row) => row.row === 1).status, "failed");
  assert.deepEqual(failedRows.find((row) => row.row === 1).failedChecks, ["external-sources.live-postgres"]);
  assert.equal(deriveLaneStatus(withFailure, failedRows), "failed");
});
