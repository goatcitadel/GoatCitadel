import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  JOURNEY_PRODUCERS_FORMAT_TARGETS,
  buildJourneyProducersLaneChecks,
  buildJourneyProducersProofMatrix,
  deriveCheckStatus,
  deriveJourneyProducerRowStatuses,
  deriveJourneyProducersLaneStatus,
  parseNodeTestCounts,
  parseVitestCounts,
} from "./journey-producers-lane.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const EXPECTED_CHECK_IDS = [
  "journey-producers.contracts",
  // typecheck runs early on purpose: tsc -b also emits the workspace dist/
  // outputs the tsx-based storage checks resolve.
  "journey-producers.typecheck",
  "journey-producers.storage-owners",
  "journey-producers.memory-producer",
  "journey-producers.governed-domains",
  "journey-producers.knowledge-and-effects",
  "journey-producers.skill-learning",
  "journey-producers.skill-hub-lifecycle",
  "journey-producers.docs",
  "journey-producers.format",
  "journey-producers.diff",
  "journey-producers.live-postgres",
];

test("the lane check table is complete, uniquely named, and cites only test files that exist", () => {
  const checks = buildJourneyProducersLaneChecks();
  assert.deepEqual(
    checks.map((check) => check.id),
    EXPECTED_CHECK_IDS,
  );
  assert.equal(new Set(checks.map((check) => check.id)).size, checks.length);

  // Every vitest/node-test file-path filter must point at a real file — a
  // renamed suite would otherwise silently run zero tests (the count guard
  // catches it at run time; this catches it at review time).
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
      if (!arg.startsWith("src/") || !/\.test\.(ts|tsx|mts|mjs)$/u.test(arg)) continue;
      const filePath = path.join(repoRoot, packageDir, arg);
      assert.ok(fs.existsSync(filePath), `${check.id} cites an existing suite: ${packageDir}/${arg}`);
    }
    if (check.count) {
      assert.ok(["vitest", "node-test"].includes(check.count), `${check.id} declares a known counter kind`);
    }
  }

  // The two invoked named lanes reference real package.json scripts.
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  for (const check of checks.filter((candidate) => candidate.kind === "named-lane")) {
    assert.ok(pkg.scripts[check.script], `${check.id} invokes an existing script: ${check.script}`);
  }

  // The docs check runs the full docs:check composite (all 10 gates, including
  // check-memory-ownership over the HX-402 producers) as a real named script.
  const docs = checks.find((check) => check.id === "journey-producers.docs");
  assert.equal(docs.kind, "named-lane");
  assert.equal(docs.script, "docs:check");
  const rootManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.ok(
    typeof rootManifest.scripts?.["docs:check"] === "string",
    "the docs:check composite script exists in package.json",
  );

  // The live-PostgreSQL check may never self-skip, and its live suites exist.
  const livePostgres = checks.find((check) => check.id === "journey-producers.live-postgres");
  assert.equal(livePostgres.kind, "live-postgres");
  assert.equal(
    livePostgres.requireAllExecuted,
    true,
    "the live-PG schema-parity suite may never self-skip inside the lane",
  );
  assert.ok(
    fs.existsSync(path.join(repoRoot, "packages/storage/src/journey-producer-schema-parity.test.ts")),
    "the live-PG schema-parity suite exists",
  );
  assert.ok(
    fs.existsSync(path.join(repoRoot, "apps/gateway/src/services/memory-lifecycle-service.real-postgres.test.ts")),
    "the live-PG memory behavioural suite exists",
  );
});

test("the format row targets exactly the lane's own new artifacts and they exist", () => {
  const checks = buildJourneyProducersLaneChecks();
  assert.ok(checks.some((check) => check.id === "journey-producers.format" && check.kind === "format"));
  assert.ok(JOURNEY_PRODUCERS_FORMAT_TARGETS.length >= 3);
  for (const target of JOURNEY_PRODUCERS_FORMAT_TARGETS) {
    assert.ok(fs.existsSync(path.join(repoRoot, target)), `format target exists: ${target}`);
    assert.ok(target.startsWith("scripts/verification/"), `format target is a lane artifact: ${target}`);
  }
});

test("the proof matrix covers the audit's eight rows, cites known checks, and declares no skip today", () => {
  const matrix = buildJourneyProducersProofMatrix();
  assert.deepEqual(
    matrix.map((row) => row.row),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  const knownChecks = new Set(EXPECTED_CHECK_IDS);
  for (const row of matrix) {
    for (const check of row.checks) {
      assert.ok(knownChecks.has(check), `row ${row.row} cites known check ${check}`);
    }
    assert.equal(row.skipReason, undefined, `row ${row.row} carries no skip reason`);
    assert.ok(row.checks.length > 0, `row ${row.row} executes at least one real check`);
    assert.ok(row.suites.length > 0, `row ${row.row} names its executing suites`);
  }
  // Row 1 (both-dialect + hermetic live PG) executes the live-postgres check.
  assert.ok(matrix.find((row) => row.row === 1).checks.includes("journey-producers.live-postgres"));
  // Row 4 (durable improvement recovery) executes the governed-domains crash matrix.
  assert.ok(matrix.find((row) => row.row === 4).checks.includes("journey-producers.governed-domains"));
  // Row 5 (shared effect wiring) executes the effects-service integration truth.
  assert.ok(matrix.find((row) => row.row === 5).checks.includes("journey-producers.knowledge-and-effects"));
  // Row 6 (named lanes) executes both invoked lanes.
  const row6 = matrix.find((row) => row.row === 6);
  assert.ok(row6.checks.includes("journey-producers.skill-learning"));
  assert.ok(row6.checks.includes("journey-producers.skill-hub-lifecycle"));
});

test("re-exported runner count parsers and the zero-test honesty guard stay wired", () => {
  assert.deepEqual(parseVitestCounts("Tests  323 passed (323)"), { failed: 0, passed: 323 });
  assert.deepEqual(parseNodeTestCounts("# pass 9\n# fail 0\n# skipped 0"), { failed: 0, passed: 9, skipped: 0 });
  // Crash guard: exit 0 with no parsable summary can never pass.
  const crashed = deriveCheckStatus({ exitCode: 0, countKind: "vitest", counts: undefined });
  assert.equal(crashed.status, "failed");
  assert.match(crashed.failureNote, /cannot prove any test executed/u);
  // Zero-test guard: an exit-0 run that executed nothing fails.
  assert.equal(
    deriveCheckStatus({ exitCode: 0, countKind: "vitest", counts: { failed: 0, passed: 0 } }).status,
    "failed",
  );
  // Self-skipped live-PG tests fail the lane's live-postgres check.
  assert.equal(
    deriveCheckStatus({
      exitCode: 0,
      countKind: "node-test",
      counts: { failed: 0, passed: 0, skipped: 1 },
      requireAllExecuted: true,
    }).status,
    "failed",
  );
  assert.equal(
    deriveCheckStatus({
      exitCode: 0,
      countKind: "node-test",
      counts: { failed: 0, passed: 4, skipped: 0 },
      requireAllExecuted: true,
    }).status,
    "passed",
  );
});

test("row statuses fold check results honestly, and dropped rows fail", () => {
  const matrix = buildJourneyProducersProofMatrix();
  const allPassed = new Map(EXPECTED_CHECK_IDS.map((id) => [id, { id, status: "passed" }]));
  const rows = deriveJourneyProducerRowStatuses(matrix, allPassed);
  for (const row of rows) {
    assert.equal(row.status, "executed", `row ${row.row} executes for real`);
  }
  assert.equal(deriveJourneyProducersLaneStatus(allPassed, rows), "passed");

  // A failing live-PG check fails every row that cites it AND the lane.
  const withFailure = new Map(allPassed);
  withFailure.set("journey-producers.live-postgres", { id: "journey-producers.live-postgres", status: "failed" });
  const failedRows = deriveJourneyProducerRowStatuses(matrix, withFailure);
  assert.equal(failedRows.find((row) => row.row === 1).status, "failed");
  assert.deepEqual(failedRows.find((row) => row.row === 1).failedChecks, ["journey-producers.live-postgres"]);
  assert.equal(deriveJourneyProducersLaneStatus(withFailure, failedRows), "failed");

  // Dropped-row guard: a row citing no checks and declaring no skip is a table
  // bug and can never pass; a declared-skip row with checks is visibly honest.
  const syntheticRows = deriveJourneyProducerRowStatuses(
    [
      { row: 98, title: "dropped row", checks: [], suites: [] },
      {
        row: 99,
        title: "declared-skip row with checks",
        checks: ["journey-producers.contracts"],
        suites: [],
        skipReason: "declared",
      },
    ],
    allPassed,
  );
  assert.equal(syntheticRows[0].status, "failed");
  assert.equal(syntheticRows[1].status, "executed_with_declared_skip");
  assert.equal(deriveJourneyProducersLaneStatus(allPassed, syntheticRows), "failed");

  // Unknown check ids resolve to no results and therefore fail, never pass.
  const unknownRows = deriveJourneyProducerRowStatuses(
    [{ row: 97, title: "row citing an unknown check", checks: ["journey-producers.nobody"], suites: [] }],
    allPassed,
  );
  assert.equal(unknownRows[0].status, "failed");
});
