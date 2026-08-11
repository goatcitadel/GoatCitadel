// verify:remote-workers integrated Phase-5 proof lane library — the release
// gate named across the HX-500/501B/503/505/506/507 packets
// (docs/OPENCLAW_HERMES_PARITY_PROGRAM.md rows HX-501..HX-507). It RUNS the
// already-committed, already-security-reviewed remote-worker owner proofs as
// numbered scenarios and declares the genuinely two-machine/live-worker
// scenarios as documented conditional skips (exactly the posture HX-408's
// two-node mTLS row and the HX-411 session-control live-PG row use). This lane
// builds NO product code.
//
// This module owns the lane's DATA and pure logic — the numbered check table,
// the 12-scenario proof-matrix, the four static scans, and the status
// derivations — so `remote-workers-lane.test.mjs` can prove the lane's shape
// and honesty without spawning processes. The executable entrypoint
// (`scripts/verification/remote-workers-proof.mjs`) injects real process
// spawning, the hermetic PostgreSQL lifecycle, filesystem reads, and artifact
// writing.
//
// Honesty rules (mirroring the external-sources / mesh-capability-publication /
// journey-producers lanes, whose count parsers and zero-test honesty guard this
// module re-uses verbatim):
//   * every vitest/node-test check parses the runner's reported counts and
//     FAILS when zero tests executed, even on exit code 0 (`deriveCheckStatus`
//     is re-used from the unit-proven external-sources lane library) — a
//     zero-match EXECUTED scenario can never pass;
//   * a proof-matrix row with no passing checks and no declared skipReason is a
//     table bug and FAILS — no row can be silently dropped;
//   * the live-PostgreSQL check must EXECUTE (hermetically provisioned or via
//     GOATCITADEL_TEST_POSTGRES_URL) with `requireAllExecuted` so its bootstrap bridge plus seven
//     `.postgres.test.ts` suites may never self-skip inside the lane;
//   * the ONLY declared skips are scenarios 11 and 12 — the packets' own
//     two-machine mTLS and live connected-worker end-to-end HOLDs — each
//     reported with its printed reason; nothing is faked.
import { deriveCheckStatus, parseNodeTestCounts, parseVitestCounts, stripAnsi } from "./external-sources-lane.mjs";

export { deriveCheckStatus, parseNodeTestCounts, parseVitestCounts, stripAnsi };

const storageTsx = (files) => [
  "--filter",
  "@goatcitadel/storage",
  "exec",
  "tsx",
  "--test",
  ...files.map((f) => `src/${f}`),
];
const gatewayVitest = (files) => [
  "--filter",
  "@goatcitadel/gateway",
  "exec",
  "vitest",
  "run",
  ...files.map((file) => `src/${file}`),
];

/**
 * The remote-worker `.postgres.test.ts` suites the live-PostgreSQL check runs
 * against ONE hermetic cluster (scenario 8): every generation-fenced storage
 * owner (nonce, admission, assignment, inference, cell, artifact, effect).
 * Exported so the entrypoint drives them and the sibling test asserts they
 * exist.
 */
export const REMOTE_WORKER_LIVE_POSTGRES_SUITES = [
  "postgres-bootstrap-bridge.postgres.test.ts",
  "remote-worker-nonce-repo.postgres.test.ts",
  "remote-worker-admission-repo.postgres.test.ts",
  "remote-worker-assignment-repo.postgres.test.ts",
  "remote-worker-inference-repo.postgres.test.ts",
  "remote-worker-cell-repo.postgres.test.ts",
  "remote-worker-artifact-repo.postgres.test.ts",
  "remote-worker-effect-repo.postgres.test.ts",
];

/**
 * The lane's own new artifacts, eslint-checked (and prettier-clean) by the
 * release-hygiene row. Declared here so the sibling unit test can assert the
 * eslint row targets the files this slice actually adds.
 */
export const REMOTE_WORKERS_LANE_ARTIFACTS = [
  "scripts/verification/remote-workers-proof.mjs",
  "scripts/verification/lib/scenarios/remote-workers-lane.mjs",
  "scripts/verification/lib/scenarios/remote-workers-lane.test.mjs",
];

/**
 * PostgreSQL catalog-authority files that scenario 8 relies on in addition to
 * the filename-selected remote-worker span. Keeping them explicit prevents a
 * bridge or canonical-manifest correction from escaping the lane's lint gate.
 */
export const REMOTE_WORKERS_POSTGRES_AUTHORITY_ARTIFACTS = [
  "packages/storage/src/postgres-bootstrap-bridge.postgres.test.ts",
  "packages/storage/src/postgres-migration-integrity.test.ts",
  "packages/storage/src/postgres-migrator.test.ts",
  "packages/storage/src/postgres/migrations.ts",
  "packages/storage/src/postgres/migrator.ts",
  "packages/storage/src/postgres/schema-shape.ts",
  "packages/storage/src/postgres/v140-canonical-index-authority.ts",
  "scripts/verify-storage-migration-parity.test.mjs",
];

/**
 * Split the Windows-sensitive eslint target list without changing target
 * order. `pnpm.cmd` is launched through cmd.exe, whose command-line ceiling is
 * materially lower than CreateProcess; keeping each target payload below four
 * thousand characters leaves bounded room for the executable and fixed args.
 */
export function chunkRemoteWorkerEslintTargets(targets, maxTargetChars = 4_000) {
  if (!Number.isSafeInteger(maxTargetChars) || maxTargetChars <= 0) {
    throw new Error("maxTargetChars must be a positive safe integer");
  }
  const chunks = [];
  let current = [];
  let currentChars = 0;
  for (const target of targets) {
    if (typeof target !== "string" || target.length === 0) {
      throw new Error("eslint targets must be non-empty strings");
    }
    // Include one separator/quoting allowance per argument. Repository paths
    // currently contain no spaces, but the allowance keeps the bound honest.
    const targetChars = target.length + 3;
    if (targetChars > maxTargetChars) {
      throw new Error(`eslint target exceeds the command payload budget: ${target}`);
    }
    if (current.length > 0 && currentChars + targetChars > maxTargetChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(target);
    currentChars += targetChars;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * The lane's numbered checks. `count` enables the zero-test honesty guard;
 * `kind` marks the non-vitest/non-node-test checks (static scans, hermetic
 * live PostgreSQL, eslint, diff). Every vitest/node-test check runs real
 * committed suites via file-path filters (never `-t` name filters).
 */
export function buildRemoteWorkersLaneChecks() {
  return [
    {
      id: "remote-workers.typecheck",
      // Runs FIRST on purpose: tsc -b also EMITS the workspace dist/ outputs the
      // tsx-based storage checks and the UI packages resolve, so a fresh clone
      // (or a fresh worktree) self-bootstraps instead of failing on missing
      // builds. The remote-worker owners span all six packages below.
      title:
        "Release hygiene: contracts, storage, gateway, policy-engine, shared-client, mission-control-next, and the connected-worker runtime (apps/remote-worker) boundary typechecks over the remote-worker span",
      args: [
        "--filter",
        "@goatcitadel/contracts",
        "--filter",
        "@goatcitadel/storage",
        "--filter",
        "@goatcitadel/gateway",
        "--filter",
        "@goatcitadel/policy-engine",
        "--filter",
        "@goatcitadel/mission-control-shared",
        "--filter",
        "@goatcitadel/mission-control-next",
        "--filter",
        "@goatcitadel/remote-worker",
        "typecheck",
      ],
    },
    {
      id: "remote-workers.contracts",
      title:
        "Contracts: admission/assignment/inference/cell/settlement/ops envelope canonicalization, hash-only credential/nonce persistence intent, ceiling and boundary validators, unknown-field and smuggling rejection",
      args: [
        "--filter",
        "@goatcitadel/contracts",
        "exec",
        "vitest",
        "run",
        "src/remote-worker-admission.test.ts",
        "src/remote-worker-assignment.test.ts",
        "src/remote-worker-inference.test.ts",
        "src/remote-worker-cell.test.ts",
        "src/remote-worker-settlement.test.ts",
        "src/remote-worker-ops.test.ts",
      ],
      count: "vitest",
    },
    {
      id: "remote-workers.storage",
      // All committed remote-worker SQLite storage owners + their static
      // SQLite<->PostgreSQL schema-parity suites in ONE tsx --test process. Kept
      // as one node-test check (not six spawns) so the lane fits well within the
      // 10-minute run budget; the sibling test verifies every cited file exists,
      // and each scenario's proof-matrix row names the specific owner it proves.
      title:
        "Storage owners (SQLite): HX-501B1 single-use nonce (176), HX-501 hash-only admission (170), HX-502/HX-504 generation-lease + ordered-event/materialization (171), HX-503 immutable inference request/outbox (177), HX-505 cell state/evidence (178), HX-506 insert-only settlement (179) — no-update/no-delete guards, revision CAS, exactly-once, and every SQLite<->PostgreSQL schema-parity suite",
      args: storageTsx([
        "remote-worker-nonce-repo.test.ts",
        "remote-worker-nonce-schema-parity.test.ts",
        "remote-worker-admission-repo.test.ts",
        "remote-worker-admission-schema-parity.test.ts",
        "remote-worker-assignment-repo.test.ts",
        "remote-worker-assignment-schema-parity.test.ts",
        "remote-worker-inference-repo.test.ts",
        "remote-worker-inference-schema-parity.test.ts",
        "remote-worker-cell-repo.test.ts",
        "remote-worker-cell-schema-parity.test.ts",
        "remote-worker-artifact-repo.test.ts",
        "remote-worker-effect-repo.test.ts",
        "remote-worker-settlement-schema-parity.test.ts",
      ]),
      count: "node-test",
    },
    {
      id: "remote-workers.gateway",
      // All committed remote-worker Gateway owners in ONE vitest process (~9s
      // warm for 16 suites vs five cold spawns): HX-501/501B1 protocol, HX-503
      // inference proxy + llm-adapter, HX-505 execution cell (service +
      // filesystem/terminal/platform/container/backup security), HX-506
      // settlement (artifact store/settlement, verification, effect settlement,
      // integration), and HX-507 visibility route service + routes.
      title:
        "Gateway owners: HX-501/501B1 protocol (durable nonce, transport/PoP evidence, secret-free diagnostics); native-listener composition (routes 2-6 + 8-10 mux registration, fail-closed admission composition, flag-gated assignment-runtime composition); HX-503 inference proxy (one effective route, secret isolation, atomic-budget recheck, no redispatch after ambiguous acceptance, HX-306 accounting); HX-505 execution cell (server-owned profiles, capacity, deny-by-default egress, bounded capture, container-only, hash-bound backup/restore); HX-506 settlement (CAS store, Gateway-trusted verification, generation-fenced artifact/effect settlement, worker-claim non-authority, integration); HX-507 visibility (authority labels, bounded redacted events, stable cursors, idempotent controls, access-class isolation, no-store)",
      args: gatewayVitest([
        "services/remote-worker-protocol.test.ts",
        "services/remote-worker-native-handler-mux.test.ts",
        "services/remote-worker-admission-composition.test.ts",
        "services/remote-worker-assignment-runtime-composition.test.ts",
        "services/remote-worker-inference-service.test.ts",
        "services/remote-worker-inference-llm-adapter.test.ts",
        "services/remote-worker-cell-service.test.ts",
        "services/remote-worker-cell-filesystem.security.test.ts",
        "services/remote-worker-cell-terminal-capture.test.ts",
        "services/remote-worker-cell-platform.test.ts",
        "services/remote-worker-cell-container-adapter.security.test.ts",
        "services/remote-worker-cell-backup-port.test.ts",
        "services/remote-worker-artifact-store.test.ts",
        "services/remote-worker-artifact-settlement-service.test.ts",
        "services/remote-worker-verification-service.test.ts",
        "services/remote-worker-effect-settlement-service.test.ts",
        "services/remote-worker-settlement.integration.test.ts",
        "services/remote-workers-route-service.test.ts",
        "routes/remote-workers.test.ts",
      ]),
      count: "vitest",
    },
    {
      id: "remote-workers.policy",
      title:
        "HX-505 policy engine: worker-cell egress proxy deny-by-default, allowlist enforcement, DNS-rebinding and redirect containment, no-bypass canary",
      args: [
        "--filter",
        "@goatcitadel/policy-engine",
        "exec",
        "vitest",
        "run",
        "src/worker-cell-egress-proxy.security.test.ts",
      ],
      count: "vitest",
    },
    {
      id: "remote-workers.shared",
      title:
        "HX-507 shared client: remote-workers api bounded parsers (smuggle rejection), useRemoteWorkerRegistry hook, and realtime-derived registry projection (retained events invalidate/refetch, honest unavailable states)",
      args: [
        "--filter",
        "@goatcitadel/mission-control-shared",
        "exec",
        "vitest",
        "run",
        "src/api/remote-workers.test.ts",
        "src/hooks/useRemoteWorkerRegistry.test.ts",
        "src/state/realtime-derived.test.ts",
      ],
      count: "vitest",
    },
    {
      id: "remote-workers.mc-next",
      title:
        "HX-507 operator UI: Ops RemoteWorkersRoutePage (semantic rendering, drill-in, accessible destructive actions), Chat inline RemoteWorkerInlineActivity + hook, and app remote-worker realtime projection",
      args: [
        "--filter",
        "@goatcitadel/mission-control-next",
        "exec",
        "vitest",
        "run",
        "src/features/native-routes/ops/RemoteWorkersRoutePage.test.tsx",
        "src/features/threaded-surface/RemoteWorkerInlineActivity.test.tsx",
        "src/features/threaded-surface/useRemoteWorkerInlineActivity.test.ts",
        "src/app/remote-worker-realtime.test.ts",
      ],
      count: "vitest",
    },
    {
      id: "remote-workers.static-scans",
      title:
        "Static scans: no raw lease/credential/nonce/secret column across the remote-worker migration SQL (both dialects); no HX-306 accounting mutation (external_side_effect_runs/model_usage_events/cost_ledger) from any remote-worker owner; no control bytes in remote-worker .ts source; migration heads linear with 176-179 / 118-121 registered both dialects",
      kind: "static-scans",
    },
    {
      id: "remote-workers.eslint",
      title: "Release hygiene: eslint over the lane's own new artifacts and the remote-worker source span",
      kind: "eslint",
    },
    {
      id: "remote-workers.diff",
      title: "Release hygiene: git diff --check (no whitespace errors or conflict markers)",
      kind: "diff",
    },
    {
      id: "remote-workers.live-postgres",
      title:
        "Hermetic live PostgreSQL (scenario 8): every remote-worker generation-fenced owner (nonce, admission, assignment, inference, cell, artifact, effect) .postgres.test.ts run against ONE self-provisioned native cluster with requireAllExecuted; never an accepted skip",
      kind: "live-postgres",
      count: "node-test",
      requireAllExecuted: true,
    },
  ];
}

/**
 * The integrated Phase-5 proof matrix: 12 numbered scenarios named across the
 * HX-500/501B/503/505/506/507 packets. Scenarios 1-10 are EXECUTED by real
 * committed checks; scenarios 11-12 are the packets' own two-machine /
 * live-connected-worker HOLDs, declared here as conditional skips with printed
 * reasons (a skip is NOT a failure; a zero-test executed scenario IS). Titles
 * abbreviate the packet text; the parity-program rows and the individual
 * HX-5xx packets remain the authoritative wording.
 */
export function buildRemoteWorkersProofMatrix() {
  return [
    {
      row: 1,
      title:
        "HX-501B1 durable request-nonce owner: single-use bootstrap/credential nonce consumption, contracts + SQLite parity + gateway protocol, live under the hermetic cluster",
      checks: [
        "remote-workers.contracts",
        "remote-workers.storage",
        "remote-workers.gateway",
        "remote-workers.live-postgres",
      ],
      suites: [
        "packages/contracts/src/remote-worker-admission.test.ts (bootstrap/credential envelope + hash-only nonce intent)",
        "packages/storage/src/remote-worker-nonce-repo.test.ts + remote-worker-nonce-schema-parity.test.ts (single-use consumption, no-update/no-delete guards, SQLite 176 <-> PostgreSQL 118 parity)",
        "apps/gateway/src/services/remote-worker-protocol.test.ts (authenticated protocol handling, durable single-use nonce consumption, secret-free diagnostics)",
        "packages/storage/src/remote-worker-nonce-repo.postgres.test.ts (live-cluster single-use replay under the hermetic PostgreSQL)",
      ],
    },
    {
      row: 2,
      title:
        "HX-501/HX-502 admission + assignment foundations: hash-only admission ceilings and one-current generation leases with exactly-once settlement",
      checks: ["remote-workers.contracts", "remote-workers.storage", "remote-workers.live-postgres"],
      suites: [
        "packages/contracts/src/remote-worker-admission.test.ts + remote-worker-assignment.test.ts (manifest/credential envelopes, immutable ceilings, dispatch authority)",
        "packages/storage/src/remote-worker-admission-repo.test.ts (hash-only bootstrap-secret/credential-token persistence, quarantine/revoke, N+1 re-admission)",
        "packages/storage/src/remote-worker-assignment-repo.test.ts (one-current generation leases, DB-clock renewal, cancellation/recovery, exactly-once settlement)",
        "packages/storage/src/remote-worker-admission-repo.postgres.test.ts + remote-worker-assignment-repo.postgres.test.ts (live-cluster generation fencing)",
      ],
    },
    {
      row: 3,
      title:
        "HX-503 inference owner: immutable assignment-bound requests, ordered delivery outbox, one-route secret isolation, durable frame replay, HX-306 accounting authority",
      checks: [
        "remote-workers.contracts",
        "remote-workers.storage",
        "remote-workers.gateway",
        "remote-workers.live-postgres",
      ],
      suites: [
        "packages/contracts/src/remote-worker-inference.test.ts (bounded text input, model-intent ceilings, no provider credentials)",
        "packages/storage/src/remote-worker-inference-repo.test.ts + remote-worker-inference-schema-parity.test.ts (immutable requests, ordered worker-delivery outbox, SQLite 177 <-> PostgreSQL 119 parity)",
        "apps/gateway/src/services/remote-worker-inference-service.test.ts + remote-worker-inference-llm-adapter.test.ts (one effective route, secret isolation, atomic-budget recheck, no redispatch after ambiguous acceptance, HX-306 as authoritative accounting)",
        "packages/storage/src/remote-worker-inference-repo.postgres.test.ts (live-cluster frame-before-delivery ordering)",
      ],
    },
    {
      row: 4,
      title:
        "HX-504 ordered-event and materialization foundation: hash-chained typed events, next-sequence acceptance, byte-identical replay, watermarks, exactly-once Chat-transcript/durable-result materialization",
      checks: ["remote-workers.storage", "remote-workers.live-postgres"],
      suites: [
        "packages/storage/src/remote-worker-assignment-repo.test.ts (chained-hash events, next-sequence acceptance, changed-duplicate/gap conflict, bounded watermarks, explicit event/settlement materialization owners, exactly-once receipts — the paired HX-502/HX-504 171/113 foundation)",
        "packages/storage/src/remote-worker-assignment-schema-parity.test.ts (SQLite 171 <-> PostgreSQL 113 ordered-event/materialization DDL parity)",
        "packages/storage/src/remote-worker-assignment-repo.postgres.test.ts (live-cluster ordered-event acceptance and materialization receipts)",
      ],
    },
    {
      row: 5,
      title:
        "HX-505 execution cell: container-only isolation, server-owned profiles, capacity accounting, kernel-enforced deny-by-default egress, bounded diagnostics, hash-bound backup/restore, generation-fenced cleanup",
      checks: [
        "remote-workers.contracts",
        "remote-workers.storage",
        "remote-workers.policy",
        "remote-workers.gateway",
        "remote-workers.live-postgres",
      ],
      suites: [
        "packages/contracts/src/remote-worker-cell.test.ts (immutable cell state + append-only evidence contracts)",
        "packages/policy-engine/src/worker-cell-egress-proxy.security.test.ts (deny-by-default egress, allowlist, DNS-rebind/redirect containment)",
        "packages/storage/src/remote-worker-cell-repo.test.ts + remote-worker-cell-schema-parity.test.ts (revision-CAS state machines, retained-byte truth, hash-chained evidence, SQLite 178 <-> PostgreSQL 120 parity)",
        "apps/gateway/src/services/remote-worker-cell-service.test.ts + cell-filesystem.security + cell-terminal-capture + cell-platform + cell-container-adapter.security + cell-backup-port (capacity, bounded capture, container-only, hash-bound backup/restore)",
        "packages/storage/src/remote-worker-cell-repo.postgres.test.ts (live-cluster capacity/cleanup fencing)",
      ],
    },
    {
      row: 6,
      title:
        "HX-506 settlement: hash-addressed CAS commits, Gateway-trusted verification, generation-fenced artifact/effect settlement correlated to canonical outcomes without a second accounting authority",
      checks: [
        "remote-workers.contracts",
        "remote-workers.storage",
        "remote-workers.gateway",
        "remote-workers.live-postgres",
      ],
      suites: [
        "packages/contracts/src/remote-worker-settlement.test.ts (remote-only upload parts, immutable CAS manifests, effect intents/transitions/correlations)",
        "packages/storage/src/remote-worker-artifact-repo.test.ts + remote-worker-effect-repo.test.ts + remote-worker-settlement-schema-parity.test.ts (insert-only parts/blobs/manifests/intents, revision-CAS receipts, SQLite 179 <-> PostgreSQL 121 parity)",
        "apps/gateway/src/services/remote-worker-artifact-store.test.ts + remote-worker-artifact-settlement-service.test.ts + remote-worker-verification-service.test.ts + remote-worker-effect-settlement-service.test.ts (CAS store, Gateway-trusted verification, generation-fenced settlement, worker-claim non-authority)",
        "apps/gateway/src/services/remote-worker-settlement.integration.test.ts (end-to-end upload -> CAS -> verify -> intent-before-delivery -> settle closure)",
        "packages/storage/src/remote-worker-artifact-repo.postgres.test.ts + remote-worker-effect-repo.postgres.test.ts (live-cluster crash-convergent settlement)",
      ],
    },
    {
      row: 7,
      title:
        "HX-507 visibility: operator-only Ops registry/detail and one-Chat worker activity — server-authored authority labels, bounded redacted events, idempotent revision-bound controls, retained-event gap recovery",
      checks: ["remote-workers.contracts", "remote-workers.gateway", "remote-workers.shared", "remote-workers.mc-next"],
      suites: [
        "packages/contracts/src/remote-worker-ops.test.ts (authority-label vocabulary, cursor/idempotency/revision contracts)",
        "apps/gateway/src/services/remote-workers-route-service.test.ts + apps/gateway/src/routes/remote-workers.test.ts (workspace API: labels, bounded redacted summaries, stable cursors, access-class isolation, no-store)",
        "packages/mission-control-shared/src/api/remote-workers.test.ts + hooks/useRemoteWorkerRegistry.test.ts + state/realtime-derived.test.ts (bounded parsers, registry hook, retained-event invalidate/refetch)",
        "apps/mission-control-next/src/features/native-routes/ops/RemoteWorkersRoutePage.test.tsx + threaded-surface/RemoteWorkerInlineActivity.test.tsx + useRemoteWorkerInlineActivity.test.ts + app/remote-worker-realtime.test.ts (Ops drill-in, one-Chat activity, realtime projection)",
      ],
    },
    {
      row: 8,
      title:
        "Hermetic live PostgreSQL: every remote-worker generation-fenced owner .postgres.test.ts run against ONE self-provisioned native cluster (not an optional skip)",
      checks: ["remote-workers.live-postgres"],
      suites: [
        "packages/storage/src/postgres-bootstrap-bridge.postgres.test.ts plus remote-worker-{nonce,admission,assignment,inference,cell,artifact,effect}-repo.postgres.test.ts (eight suites, one hermetic initdb/pg_ctl cluster, requireAllExecuted so no PostgreSQL side self-skips)",
      ],
      note: "The live-PostgreSQL check provisions a hermetic native cluster on a distinct port (or honours GOATCITADEL_TEST_POSTGRES_URL) and runs the bootstrap bridge plus all seven owner .postgres.test.ts suites with requireAllExecuted; a self-skipped PostgreSQL side fails the lane.",
    },
    {
      row: 9,
      title:
        "Static scans: no raw secret column in the remote-worker migration SQL (both dialects), no HX-306 accounting mutation from remote-worker owners, control-byte-free remote-worker source, and linear 176-179 / 118-121 migration heads",
      checks: ["remote-workers.static-scans"],
      suites: [
        "lane scan A (remote_worker CREATE TABLE columns carry no raw lease/credential/nonce/secret — hash-only persistence, both dialects)",
        "lane scan B (no remote-worker owner INSERT/UPDATE/DELETE against external_side_effect_runs/model_usage_events/cost_ledger — HX-306 reused through narrow ports, never a second authority)",
        "lane scan C (byte-level: no C0 control bytes in remote-worker .ts source)",
        "lane scan D (SQLite/PostgreSQL migration versions strictly contiguous 1..head with 176-179 / 118-121 present — no gap, no duplicate)",
      ],
    },
    {
      row: 10,
      title:
        "Release hygiene: remote-worker-span typechecks (six packages), eslint over the lane artifacts and remote-worker source, and git diff --check",
      checks: ["remote-workers.typecheck", "remote-workers.eslint", "remote-workers.diff"],
      suites: [
        "pnpm --filter contracts/storage/gateway/policy-engine/mission-control-shared/mission-control-next typecheck",
        "eslint over the lane's own new artifacts plus the remote-worker source span",
        "git diff --check (no whitespace errors or conflict markers)",
      ],
    },
    {
      row: 11,
      title: "Two-machine native TLS 1.3 / mTLS + exporter-bound proof-of-possession admission exchange (HX-501B2)",
      checks: [],
      suites: [],
      skipReason:
        "SKIP: requires two physical machines and client-certificate provisioning; no mTLS test environment exists on this single verification host. The HX-501B2 HOLD preconditions (a real second machine presenting a provisioned client certificate over a native TLS 1.3 channel with an exporter-bound PoP) cannot be met here, so the row reports this conditional skip honestly instead of faking execution.",
      note: "The single-host transport core is already proven and independently security-reviewed: native-TLS-1.3 configuration, strict transport evidence validation, exact signed runtime/vendor-tree attestation, channel-bound proof-of-possession with bounded single-process nonce replay protection, module-private secureConnection authority, and forged-TLSSocket-authority rejection landed at commits 5fa644e30 (transport/attestation/PoP core, 4 suites/76 tests) and 3cbb89c7f (native listener, no-follow trust, installed-tree scanner, 128 focused tests) with independent adversarial review dispositions in the parity-program ledger. Only the genuinely two-machine mTLS exchange is held — exactly the posture HX-408's two-node mTLS proof-matrix row uses.",
    },
    {
      row: 12,
      title:
        "Live connected-worker end-to-end: admission -> scheduler dispatch -> inference -> transcript/event transport -> artifact/effect settlement, with reconnect/restart carrying no provider redispatch or duplicate accounting",
      checks: [],
      suites: [],
      skipReason:
        "SKIP: two stages of the full connected-worker loop have no worker-facing wire route, so a live remote worker cannot execute the complete admission -> dispatch -> inference -> transcript/event transport -> artifact/effect settlement journey single-host. What now EXISTS and is unit-proven: the connected-worker runtime (apps/remote-worker — durable credential/lease/signing-pin retention, reconnect/restart without one-time-secret replay, ordered exactly-once transcript outbox, idempotent no-duplicate-accounting settlement) and the routes 2-6 assignment RPC + routes 8-10 dispatch owners composed into the native listener behind GOATCITADEL_WORKER_ASSIGNMENT_RUNTIME_ENABLED (default dark). What is MISSING: the HX-503 inference proxy and HX-506 artifact/effect settlement owners have NO PoP-v2 binding in the closed ten-purpose protected-proof table (REMOTE_WORKER_POP_V2_ROUTE_BINDINGS is exactly codes 1-10; none is inference/settlement). Adding those routes also requires extending the closed table the Windows protected PoP-v2 signer enforces — a separate security-reviewed tranche that cannot be built or proven on this single host. So the reachable dispatch/ordered-event/lease-renewal/assignment-settlement sub-loop is composable, but the marquee inference and CAS-settlement stages remain routeless; this row stays a sharpened declared skip rather than faked execution.",
      note: "Each stage's Gateway-side authority executes above: admission/nonce (scenarios 1-2), inference proxy with no-redispatch-after-ambiguous-acceptance and HX-306 accounting (scenario 3), ordered-event/materialization transport (scenario 4), settlement with generation-fenced intent-before-delivery (scenario 6), and restart/recovery fencing in the assignment owner (scenario 2). The worker runtime core and the routes 2-6/8-10 native composition now exist and are exercised by the release-hygiene typecheck (apps/remote-worker, scenario 10) and the Gateway owner check (mux, admission composition, assignment-runtime composition — scenarios 3/5/6/7). The remaining hold is precisely the inference (HX-503) and artifact/effect settlement (HX-506) stages, whose owners ship production-dark but have no PoP-v2 wire route; wiring them touches the closed protected-proof table the Windows signer enforces and is deferred to a security-reviewed tranche (HX-501B2-adjacent).",
    },
  ];
}

// ---------------------------------------------------------------------------
// Static scans (pure). Each takes plain data records so the unit test can
// prove the scan logic — including that it CATCHES dirty inputs — without
// touching the real filesystem. The entrypoint reads the real files and feeds
// them in.
// ---------------------------------------------------------------------------

/**
 * Scan A — the remote-worker migration DDL persists no raw secret. Extract
 * every `CREATE TABLE ... remote_worker_*` block from the migration sources
 * (both dialects) and flag any column declared with a bare secret-bearing name
 * followed by a SQL text/blob type. Hashed (`*_sha256`/`*_hash`/`*_digest`),
 * identifier (`*_id`/`*_generation`), timestamp (`*_expires_at`), and
 * model-token-budget (`*_token_ceiling`) columns are word-boundary-safe against
 * this pattern and never flagged; a raw `bootstrap_secret TEXT` /
 * `credential_token TEXT` / `nonce BLOB` / `lease_token TEXT` is.
 */
const RAW_SECRET_COLUMN =
  /\b(secret|bootstrap_secret|credential_token|credential_secret|nonce|nonce_value|lease_token|pop_secret|proof_of_possession|raw_secret|plaintext|private_key|master_token|session_secret)\s+(TEXT|BLOB|VARCHAR|BYTEA|CHAR|CHARACTER|CLOB|VARBINARY)\b/i;

export function extractRemoteWorkerCreateTableBlocks(source) {
  const lines = String(source).split(/\r?\n/);
  const blocks = [];
  let inBlock = false;
  let current = [];
  let startLine = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!inBlock && /CREATE TABLE[^;]*\bremote_worker_\w+/iu.test(line)) {
      inBlock = true;
      current = [];
      startLine = index + 1;
    }
    if (inBlock) {
      current.push({ line: index + 1, text: line });
      // A DDL block terminates on the closing paren + semicolon (optionally
      // "WITHOUT ROWID" for SQLite). Inner CHECK/DEFAULT parens never sit alone
      // as ");" on their own line, so this does not close early.
      if (/^\s*\)\s*(WITHOUT ROWID\s*)?;?\s*$/u.test(line) || /\)\s*;\s*$/u.test(line)) {
        inBlock = false;
        blocks.push({ startLine, lines: current });
      }
    }
  }
  return blocks;
}

export function scanRemoteWorkerMigrationSecrets(migrationFiles) {
  const matches = [];
  let blocksScanned = 0;
  for (const file of migrationFiles) {
    const blocks = extractRemoteWorkerCreateTableBlocks(file.content);
    blocksScanned += blocks.length;
    for (const block of blocks) {
      for (const { line, text } of block.lines) {
        if (RAW_SECRET_COLUMN.test(text)) {
          matches.push({ file: normalizePath(file.path), line, text: text.trim().slice(0, 200) });
        }
      }
    }
  }
  return { passed: matches.length === 0, blocksScanned, matches };
}

/**
 * Scan B — no remote-worker owner mutates the HX-306 accounting tables. The
 * settlement/inference owners reuse HX-306 through narrow ports and never
 * become a second accounting authority, so no owner source line may INSERT
 * INTO / UPDATE / DELETE FROM external_side_effect_runs / model_usage_events /
 * cost_ledger. A comment naming a table (e.g. "never extends
 * external_side_effect_runs") carries no mutation keyword and is not flagged.
 */
const HX306_ACCOUNTING_MUTATION =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(external_side_effect_runs|model_usage_events|cost_ledger)"?\b/iu;

export function scanRemoteWorkerAccountingMutation(ownerFiles) {
  const matches = [];
  for (const file of ownerFiles) {
    const lines = String(file.content).split(/\r?\n/);
    lines.forEach((text, index) => {
      if (HX306_ACCOUNTING_MUTATION.test(text)) {
        matches.push({ file: normalizePath(file.path), line: index + 1, text: text.trim().slice(0, 200) });
      }
    });
  }
  return { passed: matches.length === 0, checkedFiles: ownerFiles.length, matches };
}

/**
 * Scan C — byte-level hygiene: no C0 control byte (other than tab, LF, CR) and
 * no DEL in any remote-worker `.ts` source. Takes `{ path, bytes }` where
 * `bytes` is a Buffer/Uint8Array/number[] of the file's raw bytes (a raw NUL in
 * a `.ts` is invisible to ripgrep, so the entrypoint reads real bytes).
 */
export function scanRemoteWorkerControlBytes(byteFiles) {
  const matches = [];
  for (const file of byteFiles) {
    const bytes = file.bytes;
    for (let offset = 0; offset < bytes.length; offset += 1) {
      const byte = bytes[offset];
      if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
        matches.push({ file: normalizePath(file.path), offset, byte });
        break;
      }
    }
  }
  return { passed: matches.length === 0, checkedFiles: byteFiles.length, matches };
}

/**
 * Scan D — migration heads are linear (strictly contiguous 1..head with no
 * duplicate) in both dialects, and each required remote-worker version is
 * registered. Fails on any gap, duplicate, or missing required version.
 */
export function assertMigrationContiguity({ sqliteSource, postgresSource, requiredSqlite, requiredPostgres }) {
  const sqlite = analyzeMigrationVersions(sqliteSource, requiredSqlite);
  const postgres = analyzeMigrationVersions(postgresSource, requiredPostgres);
  return { passed: sqlite.passed && postgres.passed, sqlite, postgres };
}

function analyzeMigrationVersions(source, required) {
  const versions = [...String(source).matchAll(/\bversion:\s*([0-9]+)\b/gu)].map((match) => Number(match[1]));
  const unique = [...new Set(versions)];
  const head = unique.length > 0 ? Math.max(...unique) : 0;
  const duplicate = versions.length !== unique.length;
  const gaps = [];
  for (let version = 1; version <= head; version += 1) {
    if (!unique.includes(version)) gaps.push(version);
  }
  const missingRequired = required.filter((version) => !unique.includes(version));
  const passed = !duplicate && gaps.length === 0 && missingRequired.length === 0 && head > 0;
  return { head, duplicate, gaps, missingRequired, passed };
}

/**
 * Combine the four scans into one pass/fail with a diagnostic detail object.
 * `inputs` carries the file-record groups and the two migration sources; the
 * entrypoint supplies real content, the unit test supplies synthetic records.
 */
export function runRemoteWorkerStaticScans(inputs) {
  const secrets = scanRemoteWorkerMigrationSecrets(inputs.migrationFiles);
  const accounting = scanRemoteWorkerAccountingMutation(inputs.ownerFiles);
  const controlBytes = scanRemoteWorkerControlBytes(inputs.byteFiles);
  const contiguity = assertMigrationContiguity({
    sqliteSource: inputs.sqliteSource,
    postgresSource: inputs.postgresSource,
    requiredSqlite: inputs.requiredSqlite,
    requiredPostgres: inputs.requiredPostgres,
  });
  return {
    passed: secrets.passed && accounting.passed && controlBytes.passed && contiguity.passed,
    detail: {
      migrationSecrets: secrets,
      accountingMutation: accounting,
      controlBytes,
      migrationContiguity: contiguity,
      currentDependencyMigrationHeads: { sqlite: contiguity.sqlite.head, postgres: contiguity.postgres.head },
    },
  };
}

function normalizePath(value) {
  return String(value).replaceAll("\\", "/");
}

/**
 * Fold executed check results into the 12-scenario proof matrix.
 *   * any failing cited check fails the row;
 *   * a row with a declared skipReason (scenarios 11-12) NEVER reports plain
 *     "executed": with passing checks it reports "executed_with_declared_skip",
 *     with none it reports "skipped_with_reason" — both visibly honest;
 *   * a row with neither passing checks nor a skipReason is a table bug and
 *     FAILS (the dropped-row guard); an unknown check id resolves to no result
 *     and therefore fails, never passes.
 */
export function deriveRemoteWorkersRowStatuses(matrix, checkResults) {
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
export function deriveRemoteWorkersLaneStatus(checkResults, rowStatuses) {
  const failedChecks = [...checkResults.values()].filter((result) => result.status === "failed");
  const failedRows = rowStatuses.filter((row) => row.status === "failed");
  return failedChecks.length === 0 && failedRows.length === 0 ? "passed" : "failed";
}
