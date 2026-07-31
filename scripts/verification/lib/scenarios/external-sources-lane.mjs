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
//     checks (a declared-skipReason row shape remains lane machinery for any
//     future blocked row, but NO row carries one today);
//   * the browser-flow check parses the flow's printed combo summary with the
//     all-combos (requiredPassed 4) + >0-steps honesty guard, so a flow that
//     crashes before printing, drops a combo, or executes nothing can never
//     pass;
//   * the live-PostgreSQL check must EXECUTE against the lane-provisioned
//     hermetic cluster. Inherited database URLs are deliberately scrubbed so
//     personal or shared runtime data can never satisfy this proof. Failure to
//     provision the isolated cluster is a lane FAILURE — the closure packet
//     calls it "an explicit C4 HOLD, not an accepted skip".
//
// C4c NOTE (2026-07-22): the C4b BLOCKED state is resolved. C4c widened the
// chat.messages.ts contextRefs kind gate to the full C1 contract
// (`external_attachment` included, identifiers-only unchanged), repaired the
// routed-context durable-admission identity seam it exposed, and the browser
// flow now executes ALL steps — register→scan→plan→apply→attach→select→SEND
// (frozen refs consumed; stub reply lands)→knowledge-request→approve→
// recovered-snapshot provenance — in all four viewport/scheme combos. Rows
// 2/3 execute the browser-flow check below.

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
        "Storage owners: paired schema parity plus import/attachment/knowledge-link repositories with Journey coupling, atomic materialization, external snapshot-entry verification",
      args: [
        "--filter",
        "@goatcitadel/storage",
        "exec",
        "tsx",
        "--test",
        "src/external-source-schema-parity.test.ts",
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
    {
      id: "external-sources.browser-flow",
      title:
        "Real-browser closure flow: Library register→scan→plan→apply → Chat attach→select→send (frozen external refs) → knowledge approval → recovered snapshot with provenance, at desktop+mobile × light+dark (4 combos)",
      kind: "browser-flow",
      count: "browser-flow",
      requiredPassed: 4,
    },
    {
      id: "external-sources.static-gate-scan",
      title:
        "Static scan: GOATCITADEL_INTERNAL_HX407_EXTERNAL_SOURCES_PROOF_ENABLED absent from production code; migration heads recorded (no C4 migration)",
      kind: "static-gate-scan",
    },
    {
      id: "external-sources.live-postgres",
      title:
        "Live PostgreSQL: isolated-schema replay + racing-applies proof on the lane-provisioned hermetic cluster; inherited database URLs are ignored and failure is never an accepted skip",
      kind: "live-postgres",
      count: "node-test",
      requireAllExecuted: true,
    },
  ];
}

/**
 * Closure-packet C4 row-completion matrix mapped to lane checks. Every row is
 * executed by real checks; no row carries a skipReason (the declared-skip row
 * shape stays supported as lane machinery for any future blocked row). No row
 * is silently dropped or faked.
 */
export function buildRowCompletionMatrix() {
  return [
    {
      row: 1,
      title: "Isolated-schema live PostgreSQL replay and concurrency proof",
      checks: ["external-sources.live-postgres", "external-sources.storage-core"],
      suites: [
        "packages/storage/src/external-source-closure-repo.postgres.test.ts (live replay + racing applies after the FULL migration ledger runs on a real cluster)",
        "packages/storage/src/external-source-schema-parity.test.ts (paired SQLite/PostgreSQL DDL, caps, foreign keys, and sparse-repair behavior)",
        "packages/storage/src/external-source-import-attachment-repo.test.ts (atomic materialization + Journey coupling)",
      ],
      note: "Static paired schema parity and the full-ledger live PostgreSQL replay/concurrency proof both execute; neither is substituted or skipped.",
    },
    {
      row: 2,
      title: "Complete Library-to-Chat selection/send/approval-recovery browser path",
      checks: ["external-sources.integration", "external-sources.browser-flow"],
      suites: [
        "apps/gateway/src/external-sources-closure.integration.test.ts (API-level Library→Chat→send→approval→recovery closure incl. the HX-307 snapshot external entry)",
        "scripts/verification/lib/scenarios/external-sources-browser-flow.mjs (real-browser flow, standalone-runnable)",
      ],
      note:
        "C4c completed the C4b flow: the chat.messages contextRefs gate now admits the full C1 kind contract (identifiers only), and " +
        "the browser flow executes register→scan→plan→apply→attach→select→send (frozen refs consumed, stub reply lands)→" +
        "knowledge-request→approve→recovered-snapshot provenance end to end.",
    },
    {
      row: 3,
      title: "Light/dark desktop and mobile coverage",
      checks: ["external-sources.browser-flow"],
      suites: [
        "scripts/verification/lib/scenarios/external-sources-browser-flow.mjs (viewport/scheme parametrization: 1440x1024 + 390x844 × light + dark)",
      ],
      note:
        "The flow executes the FULL path across all four viewport/scheme combos (no pixel baselines on this host; pixel VR stays " +
        "CI-gated via visual-rebaseline.yml); the check requires all 4 combos to pass with >0 steps.",
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
        "external-sources.browser-flow",
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
 *   * a row with a declared skipReason (none today; the shape stays supported
 *     for any future blocked row) NEVER reports plain "executed": with
 *     passing checks it reports "executed_with_declared_c4b_skip", with none
 *     it reports "skipped" — both visibly honest;
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
