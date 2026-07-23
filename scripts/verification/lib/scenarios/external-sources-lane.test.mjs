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
  parseBrowserFlowCounts,
  parseNodeTestCounts,
  parseVitestCounts,
  scanForProductionProofGate,
} from "./external-sources-lane.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const EXPECTED_CHECK_IDS = [
  "external-sources.contracts",
  // typecheck runs early on purpose: tsc -b also emits the workspace dist/
  // outputs the tsx-based storage checks resolve (fresh-clone bootstrap).
  "external-sources.typecheck",
  "external-sources.storage-core",
  "external-sources.gateway-services",
  "external-sources.routes-and-effects",
  "external-sources.integration",
  // NOTE: "external-sources.browser-flow" (built by C4b) enters this list
  // when the chat.messages.ts contextRefs enum gap is fixed — see the lane's
  // C4b BLOCKED NOTE.
  "external-sources.static-gate-scan",
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
      assert.ok(
        ["vitest", "node-test", "browser-flow"].includes(check.count),
        `${check.id} declares a known counter kind`,
      );
    }
  }
  const livePostgres = checks.find((check) => check.id === "external-sources.live-postgres");
  assert.equal(livePostgres.kind, "live-postgres");
  assert.equal(livePostgres.requireAllExecuted, true, "the live-PG check may never self-skip inside the lane");
  assert.ok(
    fs.existsSync(path.join(repoRoot, "packages/storage/src/external-source-closure-repo.postgres.test.ts")),
    "the live-PG suite exists",
  );
  // The built (blocked) browser flow spec must exist: the matrix cites it and
  // the unblock flips it into this table.
  assert.ok(
    fs.existsSync(path.join(repoRoot, "scripts/verification/lib/scenarios/external-sources-browser-flow.mjs")),
    "the browser flow spec exists",
  );
});

test("the row-completion matrix covers the packet's four rows with exactly the two BLOCKED browser skips", () => {
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
    "only the browser path and viewport/scheme rows carry skip reasons",
  );
  for (const row of skipRows) {
    // The skip must name the EXACT blocking gap so the lane output is
    // actionable, never a vague deferral.
    assert.match(row.skipReason, /BLOCKED/u, `row ${row.row} states it is blocked`);
    assert.match(row.skipReason, /chat\.messages\.ts/u, `row ${row.row} names the blocking file`);
  }
  for (const row of matrix.slice(0, 3)) {
    assert.ok(typeof row.note === "string" && row.note.length > 0, `row ${row.row} carries an explanatory note`);
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

test("the browser-flow parser reads the printed combo summary and its guard demands all combos plus real steps", () => {
  assert.deepEqual(
    parseBrowserFlowCounts(
      "noise\nExternal-sources browser flow summary: combos 4 planned / 4 executed / 4 passed / 0 failed; steps 44\n",
    ),
    { planned: 4, executed: 4, passed: 4, failed: 0, steps: 44 },
  );
  assert.equal(parseBrowserFlowCounts("the flow crashed before printing"), undefined);

  const allPassed = deriveCheckStatus({
    exitCode: 0,
    countKind: "browser-flow",
    counts: { planned: 4, executed: 4, passed: 4, failed: 0, steps: 44 },
    requiredPassed: 4,
  });
  assert.equal(allPassed.status, "passed");
  // A crash before the summary printed can never pass.
  assert.equal(
    deriveCheckStatus({ exitCode: 0, countKind: "browser-flow", counts: undefined, requiredPassed: 4 }).status,
    "failed",
  );
  // A dropped combo (3/4) fails even with zero reported failures.
  const dropped = deriveCheckStatus({
    exitCode: 0,
    countKind: "browser-flow",
    counts: { planned: 4, executed: 3, passed: 3, failed: 0, steps: 30 },
    requiredPassed: 4,
  });
  assert.equal(dropped.status, "failed");
  assert.match(dropped.failureNote, /requires all 4/u);
  // A failed combo fails.
  assert.equal(
    deriveCheckStatus({
      exitCode: 0,
      countKind: "browser-flow",
      counts: { planned: 4, executed: 4, passed: 3, failed: 1, steps: 40 },
      requiredPassed: 4,
    }).status,
    "failed",
  );
  // Zero executed steps can never pass (the browser >0 honesty guard).
  const zeroSteps = deriveCheckStatus({
    exitCode: 0,
    countKind: "browser-flow",
    counts: { planned: 4, executed: 4, passed: 4, failed: 0, steps: 0 },
    requiredPassed: 4,
  });
  assert.equal(zeroSteps.status, "failed");
  assert.match(zeroSteps.failureNote, /zero executed steps/u);
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
    "the two BLOCKED browser rows report their declared skips honestly, never plain executed",
  );
  assert.equal(deriveLaneStatus(allPassed, rows), "passed");

  const withFailure = new Map(allPassed);
  withFailure.set("external-sources.live-postgres", { id: "external-sources.live-postgres", status: "failed" });
  const failedRows = deriveRowCompletionStatuses(matrix, withFailure);
  assert.equal(failedRows.find((row) => row.row === 1).status, "failed");
  assert.deepEqual(failedRows.find((row) => row.row === 1).failedChecks, ["external-sources.live-postgres"]);
  assert.equal(deriveLaneStatus(withFailure, failedRows), "failed");
});
