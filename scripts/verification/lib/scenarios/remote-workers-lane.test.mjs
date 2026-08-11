import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  REMOTE_WORKERS_LANE_ARTIFACTS,
  REMOTE_WORKERS_POSTGRES_AUTHORITY_ARTIFACTS,
  REMOTE_WORKER_LIVE_POSTGRES_SUITES,
  assertMigrationContiguity,
  buildRemoteWorkersLaneChecks,
  buildRemoteWorkersProofMatrix,
  chunkRemoteWorkerEslintTargets,
  deriveCheckStatus,
  deriveRemoteWorkersLaneStatus,
  deriveRemoteWorkersRowStatuses,
  extractRemoteWorkerCreateTableBlocks,
  parseNodeTestCounts,
  parseVitestCounts,
  runRemoteWorkerStaticScans,
  scanRemoteWorkerAccountingMutation,
  scanRemoteWorkerControlBytes,
  scanRemoteWorkerMigrationSecrets,
} from "./remote-workers-lane.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const EXPECTED_CHECK_IDS = [
  // typecheck runs early on purpose: tsc -b also emits the workspace dist/
  // outputs the tsx-based storage checks and UI packages resolve.
  "remote-workers.typecheck",
  "remote-workers.contracts",
  // Storage and gateway are each ONE consolidated spawn (all committed
  // remote-worker suites in a single tsx / vitest process) so the lane fits the
  // run budget; the proof-matrix rows still name the specific owner each
  // scenario proves, and the file-existence assertion below covers every suite.
  "remote-workers.storage",
  "remote-workers.gateway",
  // Scenario 12: spawns the real apps/remote-worker process against a composed
  // native TLS listener; requireAllExecuted so it can never self-skip.
  "remote-workers.connected-worker-e2e",
  "remote-workers.policy",
  "remote-workers.shared",
  "remote-workers.mc-next",
  "remote-workers.static-scans",
  "remote-workers.eslint",
  "remote-workers.diff",
  "remote-workers.live-postgres",
];

test("the lane check table is complete, uniquely named, and cites only test files that exist", () => {
  const checks = buildRemoteWorkersLaneChecks();
  assert.deepEqual(
    checks.map((check) => check.id),
    EXPECTED_CHECK_IDS,
  );
  assert.equal(new Set(checks.map((check) => check.id)).size, checks.length);

  // Every vitest/node-test file-path filter must point at a real file — a
  // renamed suite would otherwise silently run zero tests (the count guard
  // catches it at run time; this catches it at review time). A zero-match
  // EXECUTED scenario must FAIL, so each filter must resolve to a real suite.
  const packageDirs = new Map([
    ["@goatcitadel/contracts", "packages/contracts"],
    ["@goatcitadel/storage", "packages/storage"],
    ["@goatcitadel/gateway", "apps/gateway"],
    ["@goatcitadel/policy-engine", "packages/policy-engine"],
    ["@goatcitadel/mission-control-shared", "packages/mission-control-shared"],
    ["@goatcitadel/mission-control-next", "apps/mission-control-next"],
  ]);
  let citedSuiteCount = 0;
  for (const check of checks) {
    if (!check.args) continue;
    const filterIndex = check.args.indexOf("--filter");
    if (filterIndex === -1) continue;
    const packageName = check.args[filterIndex + 1];
    const packageDir = packageDirs.get(packageName);
    assert.ok(packageDir, `${check.id} filters a known package (${packageName})`);
    for (const arg of check.args) {
      if (!arg.startsWith("src/") || !/\.test\.(ts|tsx|mts|mjs)$/u.test(arg)) continue;
      citedSuiteCount += 1;
      const filePath = path.join(repoRoot, packageDir, arg);
      assert.ok(fs.existsSync(filePath), `${check.id} cites an existing suite: ${packageDir}/${arg}`);
    }
    if (check.count) {
      assert.ok(["vitest", "node-test"].includes(check.count), `${check.id} declares a known counter kind`);
    }
  }
  // Sanity: the lane actually cites a substantial suite set, not an empty table.
  assert.ok(citedSuiteCount >= 25, `the lane cites the committed remote-worker suites (${citedSuiteCount})`);

  // The live-PostgreSQL check may never self-skip, and its seven owner suites exist.
  const connectedWorkerCheck = checks.find((check) => check.id === "remote-workers.connected-worker-e2e");
  assert.equal(connectedWorkerCheck.count, "vitest");
  assert.equal(
    connectedWorkerCheck.requireAllExecuted,
    true,
    "the connected-worker end-to-end proof may never self-skip inside the lane",
  );

  const livePostgres = checks.find((check) => check.id === "remote-workers.live-postgres");
  assert.equal(livePostgres.kind, "live-postgres");
  assert.equal(livePostgres.requireAllExecuted, true, "the live-PG suites may never self-skip inside the lane");
  assert.equal(
    REMOTE_WORKER_LIVE_POSTGRES_SUITES.length,
    8,
    "the bootstrap bridge plus all seven generation-fenced owners run live",
  );
  for (const suite of REMOTE_WORKER_LIVE_POSTGRES_SUITES) {
    assert.match(suite, /\.postgres\.test\.ts$/u, `${suite} is a .postgres.test.ts suite`);
    assert.ok(
      fs.existsSync(path.join(repoRoot, "packages/storage/src", suite)),
      `the live-PG suite exists: packages/storage/src/${suite}`,
    );
  }

  // The static-scans, eslint, and diff rows are marked with their kinds.
  assert.equal(checks.find((check) => check.id === "remote-workers.static-scans").kind, "static-scans");
  assert.equal(checks.find((check) => check.id === "remote-workers.eslint").kind, "eslint");
  assert.equal(checks.find((check) => check.id === "remote-workers.diff").kind, "diff");
});

test("the lane's own artifacts are the eslint anchors and exist on disk", () => {
  assert.equal(REMOTE_WORKERS_LANE_ARTIFACTS.length, 3);
  for (const target of REMOTE_WORKERS_LANE_ARTIFACTS) {
    assert.ok(target.startsWith("scripts/verification/"), `lane artifact is a scripts/verification file: ${target}`);
    assert.ok(fs.existsSync(path.join(repoRoot, target)), `lane artifact exists: ${target}`);
  }
  assert.ok(REMOTE_WORKERS_POSTGRES_AUTHORITY_ARTIFACTS.length >= 8);
  for (const target of REMOTE_WORKERS_POSTGRES_AUTHORITY_ARTIFACTS) {
    assert.match(target, /\.(?:ts|mjs)$/u, `PostgreSQL authority artifact is lintable: ${target}`);
    assert.ok(fs.existsSync(path.join(repoRoot, target)), `PostgreSQL authority artifact exists: ${target}`);
  }
});

test("eslint targets are chunked below the Windows command payload ceiling without reordering", () => {
  const targets = ["a".repeat(15), "b".repeat(15), "c".repeat(15), "d".repeat(15)];
  const chunks = chunkRemoteWorkerEslintTargets(targets, 40);
  assert.deepEqual(chunks, [targets.slice(0, 2), targets.slice(2, 4)]);
  assert.deepEqual(chunks.flat(), targets);
  assert.ok(chunks.every((chunk) => chunk.reduce((total, target) => total + target.length + 3, 0) <= 40));
  assert.throws(() => chunkRemoteWorkerEslintTargets(["x".repeat(40)], 40), /exceeds the command payload budget/u);
  assert.throws(() => chunkRemoteWorkerEslintTargets(["valid", ""], 40), /non-empty strings/u);
});

test("the proof matrix covers 12 scenarios, cites known checks, and declares exactly one conditional skip (11)", () => {
  const matrix = buildRemoteWorkersProofMatrix();
  assert.deepEqual(
    matrix.map((row) => row.row),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  const knownChecks = new Set(EXPECTED_CHECK_IDS);
  for (const row of matrix) {
    for (const check of row.checks) {
      assert.ok(knownChecks.has(check), `scenario ${row.row} cites known check ${check}`);
    }
    if (row.row === 11) {
      // The packet's own two-machine mTLS HOLD: a declared conditional skip
      // with a printed reason, NOT faked execution. Scenario 12 is no longer
      // one of these — the connected-worker journey now executes for real.
      assert.equal(row.checks.length, 0, `scenario ${row.row} runs no check (it is a declared skip)`);
      assert.ok(
        typeof row.skipReason === "string" && row.skipReason.length > 0,
        `scenario ${row.row} carries a printed skip reason`,
      );
      assert.match(row.skipReason, /^SKIP:/u, `scenario ${row.row} reason is explicitly a skip`);
    } else {
      assert.equal(row.skipReason, undefined, `executed scenario ${row.row} carries no skip reason`);
      assert.ok(row.checks.length > 0, `executed scenario ${row.row} runs at least one real check`);
      assert.ok(row.suites.length > 0, `executed scenario ${row.row} names its executing suites`);
    }
  }
  // Scenario 11 is the only remaining HOLD: genuinely two-machine mTLS.
  assert.equal(
    matrix.filter((row) => typeof row.skipReason === "string").map((row) => row.row).length,
    1,
    "exactly one conditional skip remains",
  );
  assert.match(matrix.find((row) => row.row === 11).skipReason, /two physical machines|mTLS/u);
  // Scenario 12 EXECUTES the connected-worker journey and must say, in its own
  // note, what it does not execute — routes 11-12 remain uncomposed.
  const connectedWorker = matrix.find((row) => row.row === 12);
  assert.deepEqual(connectedWorker.checks, ["remote-workers.connected-worker-e2e"]);
  assert.equal(connectedWorker.skipReason, undefined);
  assert.match(connectedWorker.note, /routes 11-12/u);
  // Every executed scenario that proves a live-DB owner cites the live-postgres check.
  for (const rowNumber of [1, 2, 3, 4, 5, 6, 8]) {
    assert.ok(
      matrix.find((row) => row.row === rowNumber).checks.includes("remote-workers.live-postgres"),
      `scenario ${rowNumber} executes live PostgreSQL`,
    );
  }
  // Scenario 9 executes the static scans; scenario 10 executes typecheck/eslint/diff.
  assert.deepEqual(matrix.find((row) => row.row === 9).checks, ["remote-workers.static-scans"]);
  assert.deepEqual(matrix.find((row) => row.row === 10).checks, [
    "remote-workers.typecheck",
    "remote-workers.eslint",
    "remote-workers.diff",
  ]);
});

test("re-exported runner count parsers and the zero-test honesty guard stay wired", () => {
  assert.deepEqual(parseVitestCounts("Tests  42 passed (42)"), { failed: 0, passed: 42 });
  assert.deepEqual(parseNodeTestCounts("# pass 9\n# fail 0\n# skipped 0"), { failed: 0, passed: 9, skipped: 0 });
  // Crash guard: exit 0 with no parsable summary can never pass.
  const crashed = deriveCheckStatus({ exitCode: 0, countKind: "vitest", counts: undefined });
  assert.equal(crashed.status, "failed");
  assert.match(crashed.failureNote, /cannot prove any test executed/u);
  // Zero-test guard: an exit-0 run that executed nothing fails (a zero-match
  // EXECUTED scenario IS a failure).
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
      counts: { failed: 0, passed: 7, skipped: 0 },
      requireAllExecuted: true,
    }).status,
    "passed",
  );
});

test("scan A flags a raw secret column in a remote_worker table but not hash/id/timestamp/ceiling columns", () => {
  const cleanTable = {
    path: "packages/storage/src/sqlite.ts",
    content: [
      "CREATE TABLE IF NOT EXISTS remote_worker_runtime_credentials (",
      "  credential_id TEXT NOT NULL,",
      "  credential_generation INTEGER NOT NULL,",
      "  nonce_sha256 TEXT NOT NULL,",
      "  dispatch_lease_expires_at INTEGER NOT NULL,",
      "  governance_output_token_ceiling INTEGER NOT NULL",
      ");",
    ].join("\n"),
  };
  const clean = scanRemoteWorkerMigrationSecrets([cleanTable]);
  assert.equal(clean.passed, true, "hashed/id/timestamp/ceiling columns are not raw secrets");
  assert.equal(clean.blocksScanned, 1);

  const dirtyTable = {
    path: "packages/storage/src/postgres/migrations.ts",
    content: [
      "CREATE TABLE remote_worker_bootstrap_requests (",
      "  bootstrap_secret TEXT NOT NULL,",
      "  nonce BYTEA NOT NULL",
      ");",
    ].join("\n"),
  };
  const dirty = scanRemoteWorkerMigrationSecrets([dirtyTable]);
  assert.equal(dirty.passed, false, "a raw bootstrap_secret / nonce column is flagged");
  assert.ok(dirty.matches.length >= 1);
  assert.equal(dirty.matches[0].file, "packages/storage/src/postgres/migrations.ts");

  // A non-remote_worker table with a raw secret column is out of scope (the
  // scan only extracts remote_worker CREATE TABLE blocks).
  const foreign = scanRemoteWorkerMigrationSecrets([
    { path: "x", content: "CREATE TABLE other_table (\n  secret TEXT NOT NULL\n);" },
  ]);
  assert.equal(foreign.passed, true);
  assert.equal(foreign.blocksScanned, 0);
});

test("the block extractor captures column lines and does not close on inner CHECK parens", () => {
  const blocks = extractRemoteWorkerCreateTableBlocks(
    [
      "CREATE TABLE remote_worker_generation_controls (",
      "  status TEXT NOT NULL CHECK (status IN ('live', 'revoked')),",
      "  credential_token_sha256 TEXT NOT NULL",
      ");",
    ].join("\n"),
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lines.length, 4, "the whole body including the inner-paren CHECK line is captured");
});

test("scan B flags an HX-306 accounting mutation but not a comment naming the table", () => {
  const comment = scanRemoteWorkerAccountingMutation([
    {
      path: "apps/gateway/src/services/remote-worker-effect-settlement-service.ts",
      content: "// This service never extends external_side_effect_runs, accepts no worker-supplied cost.",
    },
  ]);
  assert.equal(comment.passed, true, "a comment naming the table carries no mutation keyword");

  for (const table of ["external_side_effect_runs", "model_usage_events", "cost_ledger"]) {
    const insert = scanRemoteWorkerAccountingMutation([
      {
        path: "apps/gateway/src/services/remote-worker-effect-settlement-service.ts",
        content: `INSERT INTO ${table} (id) VALUES (?)`,
      },
    ]);
    assert.equal(insert.passed, false, `INSERT INTO ${table} is flagged`);
    const update = scanRemoteWorkerAccountingMutation([
      { path: "x", content: `  db.run("UPDATE ${table} SET x = 1");` },
    ]);
    assert.equal(update.passed, false, `UPDATE ${table} is flagged`);
  }
});

test("scan C flags a control byte in remote-worker source but allows tab/newline/CR", () => {
  const clean = scanRemoteWorkerControlBytes([
    {
      path: "packages/storage/src/remote-worker-nonce-repo.ts",
      bytes: Buffer.from("const x = 1;\n\tconst y = 2;\r\n"),
    },
  ]);
  assert.equal(clean.passed, true);

  const withNul = scanRemoteWorkerControlBytes([
    { path: "packages/storage/src/remote-worker-nonce-repo.ts", bytes: Buffer.from([0x63, 0x00, 0x64]) },
  ]);
  assert.equal(withNul.passed, false, "a NUL byte is flagged");
  assert.equal(withNul.matches[0].byte, 0x00);
  assert.equal(withNul.matches[0].offset, 1);

  const withDel = scanRemoteWorkerControlBytes([{ path: "x", bytes: Buffer.from([0x61, 0x7f]) }]);
  assert.equal(withDel.passed, false, "DEL (0x7f) is flagged");
});

test("scan D fails on a gap, a duplicate, or a missing required version", () => {
  const linear = assertMigrationContiguity({
    sqliteSource: Array.from({ length: 179 }, (_v, i) => `version: ${i + 1}`).join("\n"),
    postgresSource: Array.from({ length: 121 }, (_v, i) => `version: ${i + 1}`).join("\n"),
    requiredSqlite: [176, 177, 178, 179],
    requiredPostgres: [118, 119, 120, 121],
  });
  assert.equal(linear.passed, true);
  assert.equal(linear.sqlite.head, 179);
  assert.equal(linear.postgres.head, 121);

  const gap = assertMigrationContiguity({
    sqliteSource: "version: 1\nversion: 2\nversion: 4",
    postgresSource: "version: 1\nversion: 2",
    requiredSqlite: [],
    requiredPostgres: [],
  });
  assert.equal(gap.passed, false, "a missing version 3 is a gap");
  assert.deepEqual(gap.sqlite.gaps, [3]);

  const duplicate = assertMigrationContiguity({
    sqliteSource: "version: 1\nversion: 2\nversion: 2",
    postgresSource: "version: 1",
    requiredSqlite: [],
    requiredPostgres: [],
  });
  assert.equal(duplicate.passed, false, "a duplicate version fails");
  assert.equal(duplicate.sqlite.duplicate, true);

  const missing = assertMigrationContiguity({
    sqliteSource: "version: 1\nversion: 2",
    postgresSource: "version: 1\nversion: 2",
    requiredSqlite: [176],
    requiredPostgres: [],
  });
  assert.equal(missing.passed, false, "a missing required remote-worker version fails");
  assert.deepEqual(missing.sqlite.missingRequired, [176]);
});

test("runRemoteWorkerStaticScans combines the four scans and fails if any sub-scan fails", () => {
  const cleanInputs = {
    migrationFiles: [{ path: "sqlite.ts", content: "CREATE TABLE remote_worker_x (\n  nonce_sha256 TEXT\n);" }],
    ownerFiles: [{ path: "owner.ts", content: "const x = 1;" }],
    byteFiles: [{ path: "owner.ts", bytes: Buffer.from("const x = 1;\n") }],
    sqliteSource: "version: 1\nversion: 2",
    postgresSource: "version: 1\nversion: 2",
    requiredSqlite: [2],
    requiredPostgres: [2],
  };
  assert.equal(runRemoteWorkerStaticScans(cleanInputs).passed, true);

  const dirtyBytes = { ...cleanInputs, byteFiles: [{ path: "owner.ts", bytes: Buffer.from([0x00]) }] };
  assert.equal(runRemoteWorkerStaticScans(dirtyBytes).passed, false);

  const dirtySecret = {
    ...cleanInputs,
    migrationFiles: [{ path: "sqlite.ts", content: "CREATE TABLE remote_worker_x (\n  credential_token TEXT\n);" }],
  };
  assert.equal(runRemoteWorkerStaticScans(dirtySecret).passed, false);
});

test("row statuses fold check results honestly; declared skips never report executed, and dropped rows fail", () => {
  const matrix = buildRemoteWorkersProofMatrix();
  const allPassed = new Map(EXPECTED_CHECK_IDS.map((id) => [id, { id, status: "passed" }]));
  const rows = deriveRemoteWorkersRowStatuses(matrix, allPassed);
  for (const row of rows) {
    if (row.row === 11) {
      assert.equal(row.status, "skipped_with_reason", `scenario ${row.row} reports its declared conditional skip`);
    } else {
      assert.equal(row.status, "executed", `scenario ${row.row} executes for real`);
    }
  }
  assert.equal(deriveRemoteWorkersLaneStatus(allPassed, rows), "passed");

  // A failing live-PG check fails every executed row that cites it AND the lane.
  const withFailure = new Map(allPassed);
  withFailure.set("remote-workers.live-postgres", { id: "remote-workers.live-postgres", status: "failed" });
  const failedRows = deriveRemoteWorkersRowStatuses(matrix, withFailure);
  assert.equal(failedRows.find((row) => row.row === 8).status, "failed");
  assert.deepEqual(failedRows.find((row) => row.row === 8).failedChecks, ["remote-workers.live-postgres"]);
  assert.equal(deriveRemoteWorkersLaneStatus(withFailure, failedRows), "failed");

  // A self-skip of an executed scenario's check (e.g. the whole live-PG side
  // reporting "failed" for zero executed) can never masquerade as a skip: an
  // executed scenario has no skipReason, so with no passing check it FAILS.
  const noPass = new Map(EXPECTED_CHECK_IDS.map((id) => [id, { id, status: "failed" }]));
  const noPassRows = deriveRemoteWorkersRowStatuses(matrix, noPass);
  assert.equal(noPassRows.find((row) => row.row === 1).status, "failed");

  // Dropped-row guard: a row citing no checks and declaring no skip is a table
  // bug and can never pass; a declared-skip row with passing checks is honest.
  const syntheticRows = deriveRemoteWorkersRowStatuses(
    [
      { row: 98, title: "dropped row", checks: [], suites: [] },
      {
        row: 99,
        title: "declared-skip row with checks",
        checks: ["remote-workers.contracts"],
        suites: [],
        skipReason: "SKIP: declared",
      },
    ],
    allPassed,
  );
  assert.equal(syntheticRows[0].status, "failed");
  assert.equal(syntheticRows[1].status, "executed_with_declared_skip");
  assert.equal(deriveRemoteWorkersLaneStatus(allPassed, syntheticRows), "failed");

  // Unknown check ids resolve to no results and therefore fail, never pass.
  const unknownRows = deriveRemoteWorkersRowStatuses(
    [{ row: 97, title: "row citing an unknown check", checks: ["remote-workers.nobody"], suites: [] }],
    allPassed,
  );
  assert.equal(unknownRows[0].status, "failed");
});
