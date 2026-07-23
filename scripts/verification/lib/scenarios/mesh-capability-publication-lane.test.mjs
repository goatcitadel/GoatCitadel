import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildMeshCapabilityLaneChecks,
  buildMeshCapabilityProofMatrix,
  deriveCheckStatus,
  deriveMeshLaneStatus,
  deriveMeshProofRowStatuses,
  parseNodeTestCounts,
  parseVitestCounts,
  runMeshCapabilityStaticScans,
} from "./mesh-capability-publication-lane.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const EXPECTED_CHECK_IDS = [
  "mesh-publication.contracts",
  // typecheck runs early on purpose: tsc -b also emits the workspace dist/
  // outputs the tsx-based storage checks and UI packages resolve.
  "mesh-publication.typecheck",
  "mesh-publication.storage-owners",
  "mesh-publication.gateway-owners",
  "mesh-publication.routes",
  "mesh-publication.catalog-profile-gates",
  "mesh-publication.ops-client",
  "mesh-publication.ops-panel",
  "mesh-publication.static-scans",
  "mesh-publication.live-postgres",
];

test("the lane check table is complete, uniquely named, and cites only test files that exist", () => {
  const checks = buildMeshCapabilityLaneChecks();
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
    ["@goatcitadel/mission-control-next", "apps/mission-control-next"],
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
  const livePostgres = checks.find((check) => check.id === "mesh-publication.live-postgres");
  assert.equal(livePostgres.kind, "live-postgres");
  assert.equal(livePostgres.requireAllExecuted, true, "the live-PG suite may never self-skip inside the lane");
  assert.ok(
    fs.existsSync(path.join(repoRoot, "packages/storage/src/mesh-capability-publication-repo.postgres.test.ts")),
    "the live-PG parity suite exists",
  );
  const staticScans = checks.find((check) => check.id === "mesh-publication.static-scans");
  assert.equal(staticScans.kind, "static-scans");
});

test("the proof matrix covers the packet's ten rows, cites known checks, and declares exactly one conditional skip", () => {
  const matrix = buildMeshCapabilityProofMatrix();
  assert.deepEqual(
    matrix.map((row) => row.row),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  const knownChecks = new Set(EXPECTED_CHECK_IDS);
  for (const row of matrix) {
    for (const check of row.checks) {
      assert.ok(knownChecks.has(check), `row ${row.row} cites known check ${check}`);
    }
    if (row.row === 10) {
      // The packet's own conditional: the live two-node proof runs only when
      // an mTLS test environment is configured. The row must say so and cite
      // the independent security-review dispositions.
      assert.match(row.skipReason, /mTLS test environment/u);
      assert.match(row.note, /security review/iu);
      assert.match(row.note, /3a933a4e2/u, "row 10 cites the reviewed M3 span");
    } else {
      assert.equal(row.skipReason, undefined, `row ${row.row} carries no skip reason`);
      assert.ok(row.checks.length > 0, `row ${row.row} executes at least one real check`);
    }
  }
  // The Ops row executes the panel, client, and static-scan checks.
  const opsRow = matrix.find((row) => row.row === 9);
  for (const id of ["mesh-publication.ops-panel", "mesh-publication.ops-client", "mesh-publication.static-scans"]) {
    assert.ok(opsRow.checks.includes(id), `row 9 executes ${id}`);
  }
  // The parity row executes live PostgreSQL.
  assert.ok(matrix.find((row) => row.row === 1).checks.includes("mesh-publication.live-postgres"));
  // Every executed row cites at least one concrete suite.
  for (const row of matrix.filter((candidate) => candidate.row !== 10)) {
    assert.ok(row.suites.length > 0, `row ${row.row} names its executing suites`);
  }
});

test("re-exported runner count parsers and the zero-test honesty guard stay wired", () => {
  assert.deepEqual(parseVitestCounts("Tests  17 passed (17)"), { failed: 0, passed: 17 });
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
      counts: { failed: 0, passed: 1, skipped: 0 },
      requireAllExecuted: true,
    }).status,
    "passed",
  );
});

test("the static scans flag raw-JSON rendering in the panel and transport/skill writers in mesh owners", () => {
  const clean = runMeshCapabilityStaticScans({
    opsPanelFiles: [{ path: "apps/mission-control-next/src/x/Panel.tsx", content: "<code>{digest}</code>" }],
    opsClientFiles: [
      {
        path: "packages/mission-control-shared/src/api/mesh-capabilities.ts",
        // Request bodies may stringify OUTBOUND payloads; that is not DOM raw-JSON rendering.
        content: 'await request("/api", { method: "POST", body: JSON.stringify({ workspaceId }) });',
      },
    ],
    meshOwnerFiles: [{ path: "apps/gateway/src/services/mesh-capability-invocation-service.ts", content: "dispatch" }],
  });
  assert.equal(clean.passed, true);

  const dirtyPanel = runMeshCapabilityStaticScans({
    opsPanelFiles: [
      { path: "apps/mission-control-next/src/x/Panel.tsx", content: "<pre>{JSON.stringify(manifest, null, 2)}</pre>" },
    ],
    opsClientFiles: [],
    meshOwnerFiles: [],
  });
  assert.equal(dirtyPanel.passed, false);
  assert.ok(dirtyPanel.detail.opsSurface.matches.length >= 1);

  const dirtyClient = runMeshCapabilityStaticScans({
    opsPanelFiles: [],
    opsClientFiles: [
      { path: "packages/mission-control-shared/src/api/mesh-capabilities.ts", content: "entry.descriptor.inputSchema" },
    ],
    meshOwnerFiles: [],
  });
  assert.equal(dirtyClient.passed, false);

  const dirtyOwner = runMeshCapabilityStaticScans({
    opsPanelFiles: [],
    opsClientFiles: [],
    meshOwnerFiles: [
      {
        path: "apps/gateway/src/services/mesh-capability-invocation-service.ts",
        content: 'await invokeMcpTool("files.read", args);',
      },
    ],
  });
  assert.equal(dirtyOwner.passed, false);
  assert.deepEqual(dirtyOwner.detail.meshOwners.matches[0].line, 1);
});

test("row statuses fold check results honestly, the declared skip never reports executed, and dropped rows fail", () => {
  const matrix = buildMeshCapabilityProofMatrix();
  const allPassed = new Map(EXPECTED_CHECK_IDS.map((id) => [id, { id, status: "passed" }]));
  const rows = deriveMeshProofRowStatuses(matrix, allPassed);
  for (const row of rows) {
    if (row.row === 10) {
      assert.equal(row.status, "skipped_with_reason", "the two-node row reports its declared conditional skip");
    } else {
      assert.equal(row.status, "executed", `row ${row.row} executes for real`);
    }
  }
  assert.equal(deriveMeshLaneStatus(allPassed, rows), "passed");

  // A failing live-PG check fails every row that cites it AND the lane.
  const withFailure = new Map(allPassed);
  withFailure.set("mesh-publication.live-postgres", { id: "mesh-publication.live-postgres", status: "failed" });
  const failedRows = deriveMeshProofRowStatuses(matrix, withFailure);
  assert.equal(failedRows.find((row) => row.row === 1).status, "failed");
  assert.deepEqual(failedRows.find((row) => row.row === 1).failedChecks, ["mesh-publication.live-postgres"]);
  assert.equal(deriveMeshLaneStatus(withFailure, failedRows), "failed");

  // Dropped-row guard: a row citing no checks and declaring no skip is a
  // table bug and can never pass.
  const syntheticRows = deriveMeshProofRowStatuses(
    [
      { row: 98, title: "dropped row", checks: [], suites: [] },
      { row: 99, title: "declared-skip row with checks", checks: ["mesh-publication.contracts"], suites: [], skipReason: "declared" },
    ],
    allPassed,
  );
  assert.equal(syntheticRows[0].status, "failed");
  assert.equal(syntheticRows[1].status, "executed_with_declared_skip");
  assert.equal(deriveMeshLaneStatus(allPassed, syntheticRows), "failed");

  // Unknown check ids resolve to no results and therefore fail, never pass.
  const unknownRows = deriveMeshProofRowStatuses(
    [{ row: 97, title: "row citing an unknown check", checks: ["mesh-publication.никто"], suites: [] }],
    allPassed,
  );
  assert.equal(unknownRows[0].status, "failed");
});
