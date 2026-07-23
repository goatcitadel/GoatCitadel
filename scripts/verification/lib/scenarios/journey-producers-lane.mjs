// HX-402 P5 journey-producers proof lane library (remaining-producer audit
// docs/review/HX_402_REMAINING_PRODUCER_AUDIT_2026-07-14.md, section
// "### P5: shared wiring and release proof" + the non-negotiable invariants).
//
// This module owns the lane's DATA and pure logic — the numbered check table,
// the audit-P5 proof-matrix row table, the lane's own format targets, and the
// status derivations — so `journey-producers-lane.test.mjs` can prove the
// lane's shape and honesty without spawning processes. The executable
// entrypoint (`scripts/verification/journey-producers-proof.mjs`) injects real
// process spawning, the hermetic PostgreSQL lifecycle, prettier/diff/docs
// invocation, and artifact writing.
//
// Honesty rules (mirroring the external-sources / mesh-capability-publication /
// requester-scope lanes, whose count parsers and zero-test honesty guard this
// module re-uses verbatim):
//   * every vitest/node-test check parses the runner's reported counts and
//     FAILS when zero tests executed, even on exit code 0 (`deriveCheckStatus`
//     is re-used from the unit-proven external-sources lane library);
//   * a proof-matrix row with no passing checks and no declared skipReason is a
//     table bug and FAILS — no row can be silently dropped;
//   * the live-PostgreSQL check must EXECUTE (hermetically provisioned or via
//     GOATCITADEL_TEST_POSTGRES_URL): it runs the SQLite<->PostgreSQL 175/117
//     journey-producer schema-parity suite with `requireAllExecuted` so its
//     PostgreSQL tests may never self-skip inside the lane, plus the live memory
//     lifecycle governed-owner behavioural proof. The audit calls an
//     unexecuted live-PostgreSQL proof "not an optional release skip";
//   * NO row carries a skipReason today — the whole P5 producer matrix executes
//     — but the declared-skip row shape stays supported as lane machinery for
//     any future conditionally-blocked row.
//
// Scope note (audit P5): the lane's docs/formatting/diff rows invoke the REAL
// named tools scoped to the P5 change surface — `validate-governance-docs.mjs`
// (the governance-doc validator inside `docs:check`), `prettier --check` over
// the lane's own new artifacts, and `git diff --check`. The composite
// whole-repo `docs:check` and `format:check` remain the controller's close-out
// gates; the lane never re-implements a checker, it invokes the real tools.
import { deriveCheckStatus, parseNodeTestCounts, parseVitestCounts, stripAnsi } from "./external-sources-lane.mjs";

export { deriveCheckStatus, parseNodeTestCounts, parseVitestCounts, stripAnsi };

const gatewayVitest = (files) => [
  "--filter",
  "@goatcitadel/gateway",
  "exec",
  "vitest",
  "run",
  ...files.map((file) => `src/${file}`),
];

/**
 * The lane's own new artifacts, prettier-checked by the format row. Declared
 * here so the sibling unit test can assert the format row targets the files
 * this slice actually adds (and only those), keeping the formatting gate honest
 * about the P5 change without inheriting unrelated whole-repo base state.
 */
export const JOURNEY_PRODUCERS_FORMAT_TARGETS = [
  "scripts/verification/journey-producers-proof.mjs",
  "scripts/verification/lib/scenarios/journey-producers-lane.mjs",
  "scripts/verification/lib/scenarios/journey-producers-lane.test.mjs",
];

/**
 * The lane's numbered checks. `count` enables the zero-test honesty guard;
 * `kind` marks the non-vitest/non-node-test checks (invoked named lanes, the
 * governance-doc validator, the scoped formatting gate, the diff gate, and the
 * hermetic live-PostgreSQL proof).
 */
export function buildJourneyProducersLaneChecks() {
  return [
    {
      id: "journey-producers.contracts",
      title:
        "Contracts: frozen governed-mutation lifecycle vocabulary + typed approval-effect/target kinds for every governed domain (memory/skill/capability/improvement + HX-407 knowledge)",
      args: [
        "--filter",
        "@goatcitadel/contracts",
        "exec",
        "vitest",
        "run",
        "src/governed-mutations.test.ts",
        "src/approvals.test.ts",
      ],
      count: "vitest",
    },
    {
      id: "journey-producers.typecheck",
      // Runs early on purpose: tsc -b also EMITS the workspace dist/ outputs the
      // tsx-based storage checks resolve, so a fresh clone/worktree
      // self-bootstraps instead of failing on missing builds. The producers
      // span contracts, storage, gateway, and the shared client.
      title: "Contracts, storage, gateway, and shared-client boundary typechecks (the packages the producers span)",
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
      id: "journey-producers.storage-owners",
      title:
        "Storage P0 owners (SQLite dialect): governed-lifecycle-event + improvement-lifecycle-operation + governance-journey immutability/replay/conflict, and SQLite<->PostgreSQL 175/117 journey-producer schema parity",
      args: [
        "--filter",
        "@goatcitadel/storage",
        "exec",
        "tsx",
        "--test",
        "src/governed-lifecycle-event-repo.test.ts",
        "src/improvement-lifecycle-operation-repo.test.ts",
        "src/governance-journey-event-repo.test.ts",
        "src/journey-producer-schema-parity.test.ts",
      ],
      count: "node-test",
    },
    {
      id: "journey-producers.memory-producer",
      title:
        "Memory producer matrix: approval-first (no mutation before approval), recovered memory.lifecycle effect execution, denial/expiry zero-delta, replay original IDs, both-dialect history immutability",
      args: gatewayVitest([
        "services/memory-lifecycle-service.test.ts",
        "services/memory-domain-journey-producer.test.ts",
        "services/memory-journey-producer.test.ts",
        "services/memory-lifecycle-service.postgres-dialect.test.ts",
        "services/memory-lifecycle-service.bulk-forget.test.ts",
      ]),
      count: "vitest",
    },
    {
      id: "journey-producers.governed-domains",
      title:
        "Skill/capability/improvement producer matrix: approval-first governed transitions, recovered skill/capability/improvement lifecycle effects, requester Journey-evidence recovery, PostgreSQL dialect, and the durable improvement five-boundary crash-recovery matrix",
      args: gatewayVitest([
        "services/skill-state-service.test.ts",
        "services/capability-system-service.test.ts",
        "services/skill-governance-journey-producer.test.ts",
        "services/improvement-service.test.ts",
        "services/improvement-lifecycle-journey-producer.test.ts",
        "services/improvement-service.postgres-dialect.test.ts",
      ]),
      count: "vitest",
    },
    {
      id: "journey-producers.knowledge-and-effects",
      title:
        "HX-407 knowledge producer + the shared approval-effect integration truth: every governed effect kind enqueued-on-approve, dispatched with the mesh-M2 terminal/defer split, and executed through its composed owner",
      args: gatewayVitest([
        "services/external-source-journey-producer.test.ts",
        "services/external-source-knowledge-effect-service.test.ts",
        "services/approval-resolution-effects-service.test.ts",
      ]),
      count: "vitest",
    },
    {
      id: "journey-producers.skill-learning",
      title: "Skill learning lane (verify:skill-learning): HX-401 evidence/candidate/proposal replay, poisoning, CAS",
      kind: "named-lane",
      script: "verify:skill-learning",
    },
    {
      id: "journey-producers.skill-hub-lifecycle",
      title: "Skill Hub lifecycle lane (verify:skill-hub:lifecycle): review/install/update/rollback/revoke settlement",
      kind: "named-lane",
      script: "verify:skill-hub:lifecycle",
    },
    {
      id: "journey-producers.docs",
      title:
        "Documentation gates (pnpm docs:check — the full 10-check composite, including check-memory-ownership over the HX-402 memory producers)",
      kind: "named-lane",
      script: "docs:check",
    },
    {
      id: "journey-producers.format",
      title: "Formatting: prettier --check over the lane's own new artifacts",
      kind: "format",
    },
    {
      id: "journey-producers.diff",
      title: "Diff hygiene: git diff --check (no whitespace errors or conflict markers)",
      kind: "diff",
    },
    {
      id: "journey-producers.live-postgres",
      title:
        "Hermetic live PostgreSQL: SQLite<->PostgreSQL journey-producer schema parity for BOTH governed owners (requireAllExecuted) + the live memory-lifecycle governed-owner behavioural proof (FOR UPDATE locking, atomic history+governed+Journey commit, trigger immutability); provisioned by the lane unless GOATCITADEL_TEST_POSTGRES_URL is provided, never an accepted skip",
      kind: "live-postgres",
      count: "node-test",
      requireAllExecuted: true,
    },
  ];
}

/**
 * Audit-P5 proof-matrix rows mapped to the checks that execute them. Titles
 * abbreviate the audit text; the audit's "### P5" section and the ten
 * non-negotiable invariants remain the authoritative wording. Every row is
 * executed by real checks; no row carries a skipReason (the declared-skip row
 * shape stays supported as lane machinery for any future blocked row).
 */
export function buildJourneyProducersProofMatrix() {
  return [
    {
      row: 1,
      title:
        "Both-dialect immutability/replay/conflict of the governed-lifecycle and improvement owners, including hermetic live PostgreSQL",
      checks: ["journey-producers.contracts", "journey-producers.storage-owners", "journey-producers.live-postgres"],
      suites: [
        "packages/contracts/src/governed-mutations.test.ts (frozen governed-mutation lifecycle contract + approval-effect vocabulary)",
        "packages/storage/src/governed-lifecycle-event-repo.test.ts + improvement-lifecycle-operation-repo.test.ts (no-update/no-delete guards, exact replay vs same-ID/different-material conflict)",
        "packages/storage/src/journey-producer-schema-parity.test.ts (SQLite 175 <-> PostgreSQL 117 DDL parity for both owners; live PostgreSQL side under the hermetic cluster)",
        "apps/gateway/src/services/memory-lifecycle-service.real-postgres.test.ts (live-cluster FOR UPDATE locking, atomic history+governed+Journey commit, trigger immutability)",
      ],
      note: "The live-PostgreSQL check provisions a hermetic initdb/pg_ctl cluster (or honours GOATCITADEL_TEST_POSTGRES_URL); its schema-parity sub-run uses requireAllExecuted so the PostgreSQL DDL parity for BOTH governed owners can never self-skip, and the memory-lifecycle real-PostgreSQL sub-run proves the governed P0 owner's behaviour on a real cluster.",
    },
    {
      row: 2,
      title:
        "Complete producer matrix: each domain's approval-first no-mutation-before-approval plus recovered-effect execution (memory/skill/capability/improvement) and the HX-407 producers",
      checks: [
        "journey-producers.memory-producer",
        "journey-producers.governed-domains",
        "journey-producers.knowledge-and-effects",
        "journey-producers.storage-owners",
      ],
      suites: [
        "apps/gateway/src/services/memory-lifecycle-service.test.ts + memory-domain-journey-producer.test.ts + memory-journey-producer.test.ts (approved memory.lifecycle producer + recovered effect)",
        "apps/gateway/src/services/skill-state-service.test.ts + capability-system-service.test.ts + skill-governance-journey-producer.test.ts (governed skill/capability transitions)",
        "apps/gateway/src/services/improvement-service.test.ts + improvement-lifecycle-journey-producer.test.ts (durable improvement owner)",
        "apps/gateway/src/services/external-source-journey-producer.test.ts + external-source-knowledge-effect-service.test.ts (HX-407 config/scan/attachment/knowledge producers + recovered knowledge effect)",
      ],
    },
    {
      row: 3,
      title:
        "Approval recovery: denial/expiry zero-delta, exact replay returns the original event IDs, and requester recovery from immutable request Journey evidence",
      checks: [
        "journey-producers.memory-producer",
        "journey-producers.governed-domains",
        "journey-producers.knowledge-and-effects",
      ],
      suites: [
        "apps/gateway/src/services/memory-lifecycle-service.test.ts + memory-lifecycle-service.bulk-forget.test.ts (denial/expiry zero-delta, replay original IDs, material-drift conflict)",
        "apps/gateway/src/services/skill-state-service.test.ts + capability-system-service.test.ts + improvement-lifecycle-journey-producer.test.ts (requester recovered from request Journey evidence, byte-verified requestSha256)",
        "apps/gateway/src/services/approval-resolution-effects-service.test.ts (recovered effect convergence: replayed resolution converges instead of double-mutating)",
      ],
    },
    {
      row: 4,
      title:
        "Durable improvement recovery: the five-boundary crash matrix converges without duplicate external callbacks",
      checks: ["journey-producers.governed-domains", "journey-producers.storage-owners"],
      suites: [
        "apps/gateway/src/services/improvement-service.test.ts (crash injection before/after callback, after inspection, before signal, before Journey; recovery resumes from the durable intent, callback runs exactly once)",
        "packages/storage/src/improvement-lifecycle-operation-repo.test.ts (durable intent claim/lease fencing, immutable settlement)",
      ],
    },
    {
      row: 5,
      title:
        "Shared approval-effect wiring: all five governed effect kinds enqueued-on-approve, dispatched by the worker with the mesh-M2 terminal/defer split, and executed through the composition-supplied owner",
      checks: ["journey-producers.knowledge-and-effects", "journey-producers.contracts"],
      suites: [
        "apps/gateway/src/services/approval-resolution-effects-service.test.ts (THE integration truth: memory/skill/capability/improvement/knowledge enqueue + dispatch + fail-closed executor guard + terminal-vs-defer governance split)",
        "packages/contracts/src/approvals.test.ts (ApprovalEffectKind + ApprovalEffectTargetKind carry every governed kind)",
      ],
      note: "P5 verification confirmed every governed effect kind is enqueued (enqueueResolutionEffects), dispatched (executeClaimedEffect), handled fail-closed, and executor-supplied by the gateway composition seam; no admitted-but-unwired gap remained to fill.",
    },
    {
      row: 6,
      title: "Skill learning and Skill Hub lifecycle named lanes",
      checks: ["journey-producers.skill-learning", "journey-producers.skill-hub-lifecycle"],
      suites: [
        "pnpm verify:skill-learning (HX-401 learning evidence/candidate/proposal replay, poisoning, CAS)",
        "pnpm verify:skill-hub:lifecycle (HX-413 review/install/update/rollback/revoke immutable settlement)",
      ],
    },
    {
      row: 7,
      title: "Release hygiene: producer-spanning typechecks, governance docs, formatting, and diff checks",
      checks: [
        "journey-producers.typecheck",
        "journey-producers.docs",
        "journey-producers.format",
        "journey-producers.diff",
      ],
      suites: [
        "pnpm --filter contracts/storage/gateway/mission-control-shared typecheck",
        "pnpm docs:check (full 10-check composite, including check-memory-ownership over the HX-402 memory producers)",
        "prettier --check over the lane's own new artifacts; git diff --check",
      ],
      note: "The docs row runs the whole-repo `pnpm docs:check` composite so a memory/skill/capability ownership regression in an HX-402 producer fails the lane. The format row stays scoped to the lane's own artifacts because whole-repo `format:check` carries pre-existing base-red in unrelated `.design-sync` files; that composite remains the controller's close-out gate.",
    },
    {
      row: 8,
      title: "pnpm verify:journey:producers green with every row executed",
      checks: [
        "journey-producers.contracts",
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
      ],
      suites: ["this lane"],
    },
  ];
}

/**
 * Fold executed check results into the audit-P5 proof-matrix rows.
 *   * any failing cited check fails the row;
 *   * a row with a declared skipReason (none today; the shape stays supported
 *     for any future blocked row) NEVER reports plain "executed": with passing
 *     checks it reports "executed_with_declared_skip", with none it reports
 *     "skipped_with_reason" — both visibly honest;
 *   * a row with neither passing checks nor a skipReason is a table bug and
 *     FAILS (the dropped-row guard).
 */
export function deriveJourneyProducerRowStatuses(matrix, checkResults) {
  return matrix.map((row) => {
    const rows = row.checks.map((id) => checkResults.get(id)).filter(Boolean);
    const failed = rows.filter((result) => result.status === "failed");
    const executed = rows.filter((result) => result.status === "passed");
    let status;
    if (failed.length > 0) status = "failed";
    else if (row.skipReason) status = executed.length > 0 ? "executed_with_declared_skip" : "skipped_with_reason";
    else status = executed.length > 0 ? "executed" : "failed";
    return {
      ...row,
      status,
      ...(failed.length > 0 ? { failedChecks: failed.map((result) => result.id) } : {}),
    };
  });
}

/** Overall lane status: every check passed and no proof-matrix row failed. */
export function deriveJourneyProducersLaneStatus(checkResults, rowStatuses) {
  const failedChecks = [...checkResults.values()].filter((result) => result.status === "failed");
  const failedRows = rowStatuses.filter((row) => row.status === "failed");
  return failedChecks.length === 0 && failedRows.length === 0 ? "passed" : "failed";
}
