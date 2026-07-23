// HX-407 external-sources proof lane library (closure packet
// docs/review/HX_407_CLOSURE_PACKET_2026-07-14.md, section "C4 - composition,
// production promotion, and proof" + the row-completion list).
//
// This module owns the lane's DATA and pure logic — the numbered check table,
// the row-completion matrix, the runner-output count parsers with the
// zero-test honesty guard, the static production-gate scan, and the final
// status derivation — so `external-sources-lane.test.mjs` can prove the lane's
// shape and honesty without spawning processes. The executable entrypoint
// (`scripts/verification/external-sources-proof.mjs`) injects real process
// spawning, the hermetic PostgreSQL lifecycle, and artifact writing.
//
// Honesty rules (mirroring the session-control / requester-scope lanes):
//   * every vitest/node-test check parses the runner's reported counts and
//     FAILS when zero tests executed, even on exit code 0;
//   * no scenario is faked: each row-completion row is executed by real
//     checks or carries an explicit skipReason (currently the two browser
//     rows, BLOCKED as described below);
//   * the browser-flow counter machinery (summary parser + all-combos +
//     >0-steps guard) ships here ready for the browser-flow check; that check
//     enters the table when the blocking gateway gap is fixed;
//   * the live-PostgreSQL check must EXECUTE (provisioned hermetically or via
//     GOATCITADEL_TEST_POSTGRES_URL). An unset URL with no local cluster is a
//     lane FAILURE — the closure packet calls it "an explicit C4 HOLD, not an
//     accepted skip".
//
// C4b BLOCKED NOTE (2026-07-22): C4b activated the C3 UI and built the full
// real-browser Library→Chat→approval-recovery flow spec
// (`external-sources-browser-flow.mjs`, standalone-runnable). Executing it end
// to end is BLOCKED on a discovered gateway composition gap OUTSIDE the C4b
// allowlist: `apps/gateway/src/routes/chat.messages.ts` line ~195 pins
// `contextRefs[].kind` to `z.enum(["attachment", "memory_item"])`, so the
// C1-frozen `external_attachment` refs the C3 composer sends are rejected 400
// at the route BEFORE the C4a-composed resolver can freeze them. The flow
// proves every step through attach/select live in all four viewport/scheme
// combos and fails honestly at the send. When the C4a owner widens the enum
// (+ route test), flip rows 2/3 to the executed browser-flow check (kind
// "browser-flow", count "browser-flow", requiredPassed 4) wired in
// `external-sources-proof.mjs`.

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_PATTERN, "");
}

// Vitest summary: "Tests  24 passed (24)" or "Tests  2 failed | 22 passed (24)".
export function parseVitestCounts(text) {
  const clean = stripAnsi(text);
  const match = clean.match(/Tests\s+(?:([0-9]+) failed \| )?([0-9]+) passed/);
  if (!match) return undefined;
  return { failed: match[1] ? Number(match[1]) : 0, passed: Number(match[2]) };
}

// Browser-flow summary printed by external-sources-browser-flow.mjs:
// "External-sources browser flow summary: combos 4 planned / 4 executed / 4 passed / 0 failed; steps 44".
export function parseBrowserFlowCounts(text) {
  const clean = stripAnsi(text);
  const match = clean.match(
    /External-sources browser flow summary: combos ([0-9]+) planned \/ ([0-9]+) executed \/ ([0-9]+) passed \/ ([0-9]+) failed; steps ([0-9]+)/u,
  );
  if (!match) return undefined;
  return {
    planned: Number(match[1]),
    executed: Number(match[2]),
    passed: Number(match[3]),
    failed: Number(match[4]),
    steps: Number(match[5]),
  };
}

// node:test / tsx --test counters ("# pass 24" / spec-reporter glyph lines).
export function parseNodeTestCounts(text) {
  const clean = stripAnsi(text);
  let passed;
  let failed;
  let skipped;
  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim();
    const passMatch = trimmed.match(/^\S{0,3}\s*pass ([0-9]+)$/);
    if (passMatch) passed = Number(passMatch[1]);
    const failMatch = trimmed.match(/^\S{0,3}\s*fail ([0-9]+)$/);
    if (failMatch) failed = Number(failMatch[1]);
    const skipMatch = trimmed.match(/^\S{0,3}\s*skipped ([0-9]+)$/);
    if (skipMatch) skipped = Number(skipMatch[1]);
  }
  if (passed === undefined || failed === undefined) return undefined;
  return { failed, passed, skipped: skipped ?? 0 };
}

/**
 * Derive one check's honest status from its exit code and (when a counter
 * kind is declared) the parsed runner counts. Zero executed tests on exit 0
 * is a FAIL, never a pass. `requireAllExecuted` additionally fails a
 * node-test check whose tests self-skipped (used by the live-PG check, whose
 * conditional skip is a C4 HOLD when it fires inside the lane).
 * `requiredPassed` demands an exact minimum pass count (the browser-flow
 * check uses it to require ALL declared viewport/scheme combos), and browser
 * counts carrying `steps` must have executed at least one step.
 */
export function deriveCheckStatus({ exitCode, countKind, counts, requireAllExecuted = false, requiredPassed }) {
  if (exitCode !== 0) {
    return { status: "failed", failureNote: `runner exited ${exitCode}` };
  }
  if (!countKind) return { status: "passed" };
  if (!counts) {
    return {
      status: "failed",
      failureNote: "test-count summary not found in runner output; cannot prove any test executed",
    };
  }
  if (counts.failed > 0 || counts.passed < 1) {
    return { status: "failed", failureNote: `runner reported ${counts.passed} passed / ${counts.failed} failed` };
  }
  if (requiredPassed !== undefined && counts.passed < requiredPassed) {
    return {
      status: "failed",
      failureNote: `runner reported ${counts.passed} passed but this check requires all ${requiredPassed}`,
    };
  }
  if (counts.steps !== undefined && counts.steps < 1) {
    return {
      status: "failed",
      failureNote: "runner reported zero executed steps; cannot prove the browser flow ran",
    };
  }
  if (requireAllExecuted && (counts.skipped ?? 0) > 0) {
    return {
      status: "failed",
      failureNote: `runner skipped ${counts.skipped} test(s); the closure packet treats this as a C4 HOLD, not an accepted skip`,
    };
  }
  return { status: "passed" };
}

/**
 * Static production-gate scan (pure): the removed proof-only environment gate
 * must not be referenced by any production source line. Test files and docs
 * may still narrate it; production code may not.
 */
export function scanForProductionProofGate(files) {
  const matches = [];
  for (const file of files) {
    const relPath = String(file.path).replaceAll("\\", "/");
    const isProduction =
      !/\.test\.[cm]?[jt]sx?$/u.test(relPath) && !relPath.includes("/docs/") && !relPath.startsWith("docs/");
    if (!isProduction) continue;
    const lines = String(file.content).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes("HX407_EXTERNAL_SOURCES_PROOF")) {
        matches.push({ file: relPath, line: index + 1, text: line.trim().slice(0, 200) });
      }
    });
  }
  return { passed: matches.length === 0, matches };
}

const gatewayVitest = (files) => [
  "--filter",
  "@goatcitadel/gateway",
  "exec",
  "vitest",
  "run",
  ...files.map((file) => `src/${file}`),
];

/**
 * The lane's numbered checks. `count` enables the zero-test honesty guard;
 * `kind` marks the two non-spawn checks (static scan, live PostgreSQL).
 */
export function buildExternalSourcesLaneChecks() {
  return [
    {
      id: "external-sources.contracts",
      title:
        "Contracts: attach/list/detach/knowledge-request/apply validators, hash-smuggle rejection, approval vocabulary",
      args: [
        "--filter",
        "@goatcitadel/contracts",
        "exec",
        "vitest",
        "run",
        "src/external-sources.test.ts",
        "src/approvals.test.ts",
      ],
      count: "vitest",
    },
    {
      id: "external-sources.typecheck",
      // Runs FIRST after contracts: tsc -b also EMITS the workspace dist/
      // outputs the tsx-based storage checks resolve, so a fresh clone (or a
      // fresh worktree) self-bootstraps instead of failing on missing builds.
      title: "Contracts, storage, gateway, and shared-client boundary typechecks",
      args: [
        "--filter",
        "@goatcitadel/contracts",
        "--filter",
        "@goatcitadel/storage",
        "--filter",
        "@goatcitadel/gateway",
        "--filter",
        "@goatcitadel/mission-control-shared",
        "typecheck",
      ],
    },
    {
      id: "external-sources.storage-core",
      title:
        "Storage owners: import/attachment/knowledge-link repositories with Journey coupling, atomic materialization, external snapshot-entry verification",
      // NOTE: src/external-source-schema-parity.test.ts is deliberately NOT
      // cited: one of its five tests (sparse-database repair backfill) is
      // inherited base-RED from the HX-411 migration-guard change, its owners
      // sit outside the C4 allowlist, and the C1 report already flagged it for
      // a dedicated repair slice. Live schema truth is executed instead by
      // external-sources.live-postgres, which runs the FULL migration ledger
      // against a real cluster before the replay/concurrency proof.
      args: [
        "--filter",
        "@goatcitadel/storage",
        "exec",
        "tsx",
        "--test",
        "src/external-source-import-attachment-repo.test.ts",
        "src/routed-context-snapshot-repo.test.ts",
      ],
      count: "node-test",
    },
    {
      id: "external-sources.gateway-services",
      title:
        "Gateway services: C1 attachment adversarial matrix, C2 recovered-knowledge effect, Journey producers, HX-307 routed-context freeze, C4 route-service composition + ward deny-wins",
      args: gatewayVitest([
        "services/external-source-attachment-service.test.ts",
        "services/external-source-knowledge-effect-service.test.ts",
        "services/external-source-journey-producer.test.ts",
        "services/chat-routed-context-service.test.ts",
        "services/chat-turn-prep-service.routed-context.test.ts",
        "services/external-source-route-service.test.ts",
      ]),
      count: "vitest",
    },
    {
      id: "external-sources.routes-and-effects",
      title:
        "Routes + resolution effects: operator auth classes, exact C3 paths/bodies, no-store, error mapping, approved knowledge-snapshot effect enqueue/execution/convergence",
      args: gatewayVitest(["routes/external-sources.test.ts", "services/approval-resolution-effects-service.test.ts"]),
      count: "vitest",
    },
    {
      id: "external-sources.integration",
      title:
        "Integration: production composition without the proof gate + full register→scan→plan→apply→attach→approval→recovered-snapshot closure over buildApp",
      args: gatewayVitest(["external-sources.integration.test.ts", "external-sources-closure.integration.test.ts"]),
      count: "vitest",
    },
    // The browser-flow check (kind "browser-flow", count "browser-flow",
    // requiredPassed 4 — running external-sources-browser-flow.mjs headlessly)
    // is built and entrypoint-wired but NOT declared yet: see the C4b BLOCKED
    // NOTE above. Adding this row is the one-table-line flip once
    // chat.messages.ts accepts external_attachment contextRefs.
    {
      id: "external-sources.static-gate-scan",
      title:
        "Static scan: GOATCITADEL_INTERNAL_HX407_EXTERNAL_SOURCES_PROOF_ENABLED absent from production code; migration heads recorded (no C4 migration)",
      kind: "static-gate-scan",
    },
    {
      id: "external-sources.live-postgres",
      title:
        "Live PostgreSQL: isolated-schema replay + racing-applies proof (hermetic cluster provisioned by the lane unless GOATCITADEL_TEST_POSTGRES_URL is provided; never an accepted skip)",
      kind: "live-postgres",
      count: "node-test",
      requireAllExecuted: true,
    },
  ];
}

/**
 * Closure-packet C4 row-completion matrix mapped to lane checks. Rows 2 and 3
 * carry explicit skip reasons for their BROWSER half: C4b built and proved the
 * flow up to the send, where a frozen-gateway contextRefs enum gap (see the
 * C4b BLOCKED NOTE) rejects the C1 external_attachment refs — the rows flip to
 * the executed browser-flow check when that gap is fixed. No row is silently
 * dropped or faked.
 */
export function buildRowCompletionMatrix() {
  return [
    {
      row: 1,
      title: "Isolated-schema live PostgreSQL replay and concurrency proof",
      checks: ["external-sources.live-postgres", "external-sources.storage-core"],
      suites: [
        "packages/storage/src/external-source-closure-repo.postgres.test.ts (live replay + racing applies after the FULL migration ledger runs on a real cluster)",
        "packages/storage/src/external-source-import-attachment-repo.test.ts (atomic materialization + Journey coupling)",
      ],
      note:
        "src/external-source-schema-parity.test.ts is inherited base-RED (HX-411 migration-guard, owners outside the C4 allowlist, " +
        "flagged for its own repair slice) and is not cited until repaired; live schema truth executes in external-sources.live-postgres.",
    },
    {
      row: 2,
      title: "Complete Library-to-Chat selection/send/approval-recovery browser path",
      checks: ["external-sources.integration"],
      suites: [
        "apps/gateway/src/external-sources-closure.integration.test.ts (API-level Library→Chat→approval→recovery closure)",
        "scripts/verification/lib/scenarios/external-sources-browser-flow.mjs (built C4b real-browser flow, standalone-runnable)",
      ],
      note:
        "C4b activated the C3 UI (list-carried sessionIncarnationId) and the browser flow proves register→scan→plan→apply→attach→select " +
        "live in a real browser; the send leg is BLOCKED by the frozen-gateway contextRefs enum gap (C4b BLOCKED NOTE).",
      skipReason:
        "BROWSER half BLOCKED outside the C4b allowlist: apps/gateway/src/routes/chat.messages.ts pins contextRefs[].kind to " +
        '["attachment","memory_item"], 400-rejecting the C1 external_attachment refs the C3 composer sends before the C4a-composed ' +
        "resolver runs. The full API-level path executes here via the closure integration suite; flip this row to the browser-flow " +
        "check once the C4a owner widens the enum (+ route test).",
    },
    {
      row: 3,
      title: "Light/dark desktop and mobile coverage",
      checks: [],
      suites: [
        "scripts/verification/lib/scenarios/external-sources-browser-flow.mjs (viewport/scheme parametrization: 1440x1024 + 390x844 × light + dark)",
      ],
      note:
        "The built flow parametrizes the full path across all four viewport/scheme combos (no pixel baselines on this host; pixel VR " +
        "stays CI-gated via visual-rebaseline.yml) and executed through attach/select in every combo before the blocked send.",
      skipReason:
        "BLOCKED on the same send leg as row 2 (chat.messages.ts contextRefs enum). Declared, never faked; flips to the executed " +
        "browser-flow check (requiredPassed 4) with the row-2 unblock.",
    },
    {
      row: 4,
      title: "pnpm verify:external-sources green",
      checks: [
        "external-sources.contracts",
        "external-sources.storage-core",
        "external-sources.gateway-services",
        "external-sources.routes-and-effects",
        "external-sources.integration",
        "external-sources.static-gate-scan",
        "external-sources.typecheck",
        "external-sources.live-postgres",
      ],
      suites: ["this lane"],
    },
  ];
}

/**
 * Fold executed check results into the row-completion matrix.
 *   * any failing check fails the row;
 *   * a row with a declared skipReason (currently the two BLOCKED browser
 *     rows) NEVER reports plain "executed": with passing checks it reports
 *     "executed_with_declared_c4b_skip", with none it reports "skipped" —
 *     both visibly honest;
 *   * a row with neither passing checks nor a skipReason is a table bug and
 *     fails.
 */
export function deriveRowCompletionStatuses(matrix, checkResults) {
  return matrix.map((row) => {
    const rows = row.checks.map((id) => checkResults.get(id)).filter(Boolean);
    const failed = rows.filter((result) => result.status === "failed");
    const executed = rows.filter((result) => result.status === "passed");
    let status;
    if (failed.length > 0) status = "failed";
    else if (row.skipReason) status = executed.length > 0 ? "executed_with_declared_c4b_skip" : "skipped";
    else status = executed.length > 0 ? "executed" : "failed";
    return {
      ...row,
      status,
      ...(failed.length > 0 ? { failedChecks: failed.map((result) => result.id) } : {}),
    };
  });
}

/** Overall lane status: every check passed and no row failed. */
export function deriveLaneStatus(checkResults, rowStatuses) {
  const failedChecks = [...checkResults.values()].filter((result) => result.status === "failed");
  const failedRows = rowStatuses.filter((row) => row.status === "failed");
  return failedChecks.length === 0 && failedRows.length === 0 ? "passed" : "failed";
}
