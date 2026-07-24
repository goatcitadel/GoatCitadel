// HX-408 mesh-capability-publication proof lane library (packet
// docs/review/HX_408_MESH_CAPABILITY_PUBLICATION_PACKET_2026-07-14.md,
// section "## Proof matrix").
//
// This module owns the lane's DATA and pure logic — the numbered check table,
// the packet proof-matrix row table, the static scans, and the status
// derivations — so `mesh-capability-publication-lane.test.mjs` can prove the
// lane's shape and honesty without spawning processes. The executable
// entrypoint (`scripts/verification/mesh-capability-publication-proof.mjs`)
// injects real process spawning, the hermetic PostgreSQL lifecycle, and
// artifact writing.
//
// Honesty rules (mirroring the external-sources / requester-scope lanes):
//   * every vitest/node-test check parses the runner's reported counts and
//     FAILS when zero tests executed, even on exit code 0 (`deriveCheckStatus`
//     is re-used from the unit-proven external-sources lane library);
//   * a proof-matrix row with no passing checks and no declared skipReason is
//     a table bug and FAILS — no row can be silently dropped;
//   * the live-PostgreSQL check must EXECUTE (hermetically provisioned or via
//     GOATCITADEL_TEST_POSTGRES_URL); its suite may never self-skip inside
//     the lane;
//   * the single declared skip is the packet's own conditional: the live
//     two-node mTLS proof runs only "when an mTLS test environment is
//     configured", which this host does not have — the row reports SKIP with
//     that reason and cites the M1-M3 independent security-review
//     dispositions in its note. Nothing is faked.
import {
  deriveCheckStatus,
  parseNodeTestCounts,
  parseVitestCounts,
  stripAnsi,
} from "./external-sources-lane.mjs";

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
 * The lane's numbered checks. `count` enables the zero-test honesty guard;
 * `kind` marks the two non-spawn checks (static scans, live PostgreSQL).
 */
export function buildMeshCapabilityLaneChecks() {
  return [
    {
      id: "mesh-publication.contracts",
      title:
        "Contracts: manifest/entry canonicalization, digest verification, kind-specific descriptor rules, credential/URL smuggling and unknown-field rejection",
      args: [
        "--filter",
        "@goatcitadel/contracts",
        "exec",
        "vitest",
        "run",
        "src/mesh-capability-publication.test.ts",
      ],
      count: "vitest",
    },
    {
      id: "mesh-publication.typecheck",
      // Runs early on purpose: tsc -b also EMITS the workspace dist/ outputs
      // the tsx-based storage checks and the UI packages resolve, so a fresh
      // clone self-bootstraps instead of failing on missing builds.
      title: "Contracts, storage, gateway, shared-client, and mission-control-next boundary typechecks",
      args: [
        "--filter",
        "@goatcitadel/contracts",
        "--filter",
        "@goatcitadel/storage",
        "--filter",
        "@goatcitadel/gateway",
        "--filter",
        "@goatcitadel/mission-control-shared",
        "--filter",
        "@goatcitadel/mission-control-next",
        "typecheck",
      ],
    },
    {
      id: "mesh-publication.storage-owners",
      title:
        "Storage owners: publication/activation/invocation repositories (replay, conflict, caps, triggers, advisory-lock ordering) + node admission + SQLite/PostgreSQL schema parity",
      args: [
        "--filter",
        "@goatcitadel/storage",
        "exec",
        "tsx",
        "--test",
        "src/mesh-capability-publication-repo.test.ts",
        "src/mesh-capability-node-admission-repo.test.ts",
        "src/mesh-capability-publication-schema-parity.test.ts",
        "src/mesh-capability-node-admission-schema-parity.test.ts",
      ],
      count: "node-test",
    },
    {
      id: "mesh-publication.gateway-owners",
      title:
        "Gateway owners: publication owner (auth, replay/conflict, projection), activation factory + governed activation (denial matrix, drift), generation-fenced invocation (one-winner settlement, fences, recovery)",
      args: gatewayVitest([
        "services/mesh-capability-publication-service.test.ts",
        "services/mesh-capability-activation-approval-service.test.ts",
        "services/mesh-capability-activation-service.test.ts",
        "services/mesh-capability-invocation-service.test.ts",
      ]),
      count: "vitest",
    },
    {
      id: "mesh-publication.routes",
      title:
        "Routes + access classes: admitted-node vs operator credential isolation both directions, strict bodies, no-store headers, rate-limit config, content-free reason codes",
      args: gatewayVitest(["routes/mesh-capabilities.test.ts", "routes/route-access.test.ts"]),
      count: "vitest",
    },
    {
      id: "mesh-publication.catalog-profile-gates",
      title:
        "Catalog projection + profile freeze + pre-dispatch gates: mesh kinds isolated from local capabilities, freeze drift blocks the turn, drift-blocks-first dispatch admission, one-Chat tool-run rendering",
      args: gatewayVitest([
        "services/capability-system-service.test.ts",
        "services/chat-turn-capability-profile-service.test.ts",
        "services/chat-turn-agent-runner.capability-profile.test.ts",
      ]),
      count: "vitest",
    },
    {
      id: "mesh-publication.ops-client",
      title:
        "Operator shared client + hook: bounded response parsers (smuggle rejection), exact activation/revoke bodies, retained-event invocation reduction, independent failure honesty",
      args: [
        "--filter",
        "@goatcitadel/mission-control-shared",
        "exec",
        "vitest",
        "run",
        "src/api/mesh-capabilities.test.ts",
        "src/hooks/useMeshCapabilityOps.test.tsx",
      ],
      count: "vitest",
    },
    {
      id: "mesh-publication.ops-panel",
      title:
        "Ops panel: semantic publication/activation/invocation rendering without raw manifest JSON, request/revoke interactions, honest unavailable states, Ops runtime-route mount",
      args: [
        "--filter",
        "@goatcitadel/mission-control-next",
        "exec",
        "vitest",
        "run",
        "src/features/native-routes/ops/MeshCapabilityPanel.test.tsx",
        "src/features/native-routes/ops/RuntimeRoutePage.test.tsx",
      ],
      count: "vitest",
    },
    {
      id: "mesh-publication.static-scans",
      title:
        "Static scans: Ops surface renders no raw manifest JSON; mesh capability owners reference no MCP transport client and no skill-lifecycle writer; migration heads recorded (no M4 migration)",
      kind: "static-scans",
    },
    {
      id: "mesh-publication.live-postgres",
      title:
        "Live PostgreSQL parity: full migration ledger + publication replay/conflict, approval-trigger activation, revoke removing callability, one-winner settlement, expired-unsettled recovery projection (hermetic cluster unless GOATCITADEL_TEST_POSTGRES_URL is provided; never an accepted skip)",
      kind: "live-postgres",
      count: "node-test",
      requireAllExecuted: true,
    },
  ];
}

/**
 * Packet "## Proof matrix" rows 1..10, each mapped to the checks that execute
 * it. Titles abbreviate the packet text; the packet section remains the
 * authoritative wording. Row 10 carries the lane's ONLY declared skip — the
 * packet itself conditions the live two-node proof on an mTLS test
 * environment existing — and cites the independent security-review
 * dispositions in its note.
 */
export function buildMeshCapabilityProofMatrix() {
  return [
    {
      row: 1,
      title: "Manifest canonicalization, exact replay, conflict, caps, and SQLite/PostgreSQL parity",
      checks: [
        "mesh-publication.contracts",
        "mesh-publication.storage-owners",
        "mesh-publication.gateway-owners",
        "mesh-publication.live-postgres",
      ],
      suites: [
        "packages/contracts/src/mesh-capability-publication.test.ts (canonical JSON, digests, entry bounds)",
        "packages/storage/src/mesh-capability-publication-repo.test.ts (replay, conflict, 16/32/128/256 caps, PG-facade advisory-lock ordering)",
        "packages/storage/src/mesh-capability-publication-schema-parity.test.ts + mesh-capability-node-admission-schema-parity.test.ts (SQLite/PostgreSQL DDL parity)",
        "apps/gateway/src/services/mesh-capability-publication-service.test.ts (service-level same-byte replay / changed-byte conflict)",
        "packages/storage/src/mesh-capability-publication-repo.postgres.test.ts (live-cluster replay/conflict/activation/settlement after the FULL migration ledger)",
      ],
      note:
        "Live-PostgreSQL coverage executes the real repositories and committed 168/110 triggers on a hermetic cluster; the " +
        "concurrency-cap matrix itself is owned by the SQLite storage suite plus the PG-facade advisory-lock ordering assertions.",
    },
    {
      row: 2,
      title:
        "Unknown/extra fields, digest mismatch, schema bombs, credential/URL smuggling, ID collisions, and workspace collisions",
      checks: ["mesh-publication.contracts", "mesh-publication.gateway-owners", "mesh-publication.storage-owners"],
      suites: [
        "packages/contracts/src/mesh-capability-publication.test.ts (unknown fields, unsafe names, oversized metadata, embedded credentials/URLs)",
        "apps/gateway/src/services/mesh-capability-publication-service.test.ts (pre-write fail-closed matrix incl. forged capabilityId, digest mismatch, cross-workspace isolation)",
        "packages/storage/src/mesh-capability-publication-repo.test.ts (duplicate IDs, collision rejection at the durable layer)",
      ],
    },
    {
      row: 3,
      title:
        "Activation with missing/foreign/stale approval, permission drift, unknown effects, unhealthy publisher, or expired lease",
      checks: ["mesh-publication.gateway-owners", "mesh-publication.storage-owners", "mesh-publication.live-postgres"],
      suites: [
        "apps/gateway/src/services/mesh-capability-activation-service.test.ts (denial matrix, request/approve drift fail-closed, unknown posture preserved)",
        "apps/gateway/src/services/mesh-capability-activation-approval-service.test.ts (deterministic detached approval factory)",
        "packages/storage/src/mesh-capability-publication-repo.test.ts (activation trigger: approval payload byte-exactness, health, DB-clock lease)",
        "packages/storage/src/mesh-capability-publication-repo.postgres.test.ts (real-PG approval-verifying trigger fails a missing approval closed)",
      ],
    },
    {
      row: 4,
      title:
        "Disconnect/suspect/offline, reconnect generation, certificate rotation, manifest supersession, and revoke removing callability immediately",
      checks: [
        "mesh-publication.gateway-owners",
        "mesh-publication.catalog-profile-gates",
        "mesh-publication.live-postgres",
      ],
      suites: [
        "apps/gateway/src/services/mesh-capability-publication-service.test.ts (offline/superseded/revoked/blocked projections incl. certificate drift; reconnect never resumes a generation)",
        "apps/gateway/src/services/mesh-capability-activation-service.test.ts (revoke converges and removes callability before the next read)",
        "apps/gateway/src/services/chat-turn-capability-profile-service.test.ts + chat-turn-agent-runner.capability-profile.test.ts (each removal reason blocks at BOTH the freeze and pre-dispatch gates)",
        "packages/storage/src/mesh-capability-publication-repo.postgres.test.ts (revoke removes the activation from the live-PG callable projection immediately)",
      ],
    },
    {
      row: 5,
      title: "Profile-freeze and pre-dispatch drift checks",
      checks: ["mesh-publication.catalog-profile-gates"],
      suites: [
        "apps/gateway/src/services/chat-turn-capability-profile-service.test.ts (freeze seam re-verification, mesh_capability_freeze_drift fail-closed)",
        "apps/gateway/src/services/chat-turn-agent-runner.capability-profile.test.ts (pre-dispatch drift always blocks first; still-valid verdict is the only dispatch path)",
      ],
    },
    {
      row: 6,
      title:
        "One-winner dispatch/settlement, duplicate identical receipt, changed receipt conflict, stale generation, timeout, cancellation, and ambiguous delivery",
      checks: ["mesh-publication.gateway-owners", "mesh-publication.storage-owners", "mesh-publication.live-postgres"],
      suites: [
        "apps/gateway/src/services/mesh-capability-invocation-service.test.ts (full settlement matrix incl. the M4 vault-capacity pre-fence regression)",
        "packages/storage/src/mesh-capability-publication-repo.test.ts (intent/settlement triggers, stale-generation rejection)",
        "packages/storage/src/mesh-capability-publication-repo.postgres.test.ts (one-winner settlement replay/conflict + expired-unsettled recovery on the real DB clock)",
      ],
    },
    {
      row: 7,
      title: "No direct skill activation and no remote MCP transport bypass",
      checks: [
        "mesh-publication.gateway-owners",
        "mesh-publication.catalog-profile-gates",
        "mesh-publication.static-scans",
      ],
      suites: [
        "apps/gateway/src/services/mesh-capability-activation-service.test.ts (skill activation fails closed with zero approval rows)",
        "apps/gateway/src/services/mesh-capability-publication-service.test.ts + capability-system-service.test.ts (skill descriptors never project callable)",
        "lane static scan B (mesh capability owners reference no MCP transport client and no skill-lifecycle writer)",
      ],
    },
    {
      row: 8,
      title:
        "Actor/auth class isolation, rate limits, no-store inspection routes, audit/evidence, and secret redaction",
      checks: ["mesh-publication.routes", "mesh-publication.gateway-owners"],
      suites: [
        "apps/gateway/src/routes/mesh-capabilities.test.ts (node/operator isolation both directions, auth-mode none, no-store + Vary headers, rate-limit config, content-free errors)",
        "apps/gateway/src/routes/route-access.test.ts (mesh-node access class enforcement)",
        "apps/gateway/src/services/mesh-capability-invocation-service.test.ts (credential-absence envelope canary; realtime payloads pass the shared redaction owner)",
      ],
      note:
        "Realtime persistence redacts payloads through the shared redactStructuredSecrets owner in RealtimeEventService; the mesh " +
        "events carry only identifiers/digests by construction (envelope canary).",
    },
    {
      row: 9,
      title: "Ops and one-Chat activity rendering without raw JSON or a new conversation surface",
      checks: [
        "mesh-publication.ops-client",
        "mesh-publication.ops-panel",
        "mesh-publication.static-scans",
        "mesh-publication.catalog-profile-gates",
      ],
      suites: [
        "packages/mission-control-shared/src/api/mesh-capabilities.test.ts + src/hooks/useMeshCapabilityOps.test.tsx (bounded parsers, no descriptor fetch, honest failures)",
        "apps/mission-control-next/src/features/native-routes/ops/MeshCapabilityPanel.test.tsx (semantic cards, no raw manifest JSON, activation/revoke interactions, read-only reconciliation disclosure)",
        "apps/mission-control-next/src/features/native-routes/ops/RuntimeRoutePage.test.tsx (panel mounted on the existing Ops runtime route — no new surface)",
        "apps/gateway/src/services/chat-turn-agent-runner.capability-profile.test.ts (mesh outcomes ride the EXISTING chat tool-run stream)",
        "lane static scan A (panel renders no JSON.stringify/dangerouslySetInnerHTML/pre dumps; client fetches no descriptor bytes)",
      ],
      note:
        "The M3 unsettled/manual-reconciliation queue renders read-only from retained events: no operator inspection route exposes " +
        "the durable per-invocation queue yet and this slice may not add routes — the panel states that boundary explicitly.",
    },
    {
      row: 10,
      title: "Independent security review plus live two-node proof when an mTLS test environment is configured",
      checks: [],
      suites: [],
      skipReason:
        "No two-node mTLS test environment is configured on this host; the packet conditions the live two-node proof on such an " +
        "environment existing, so the row reports this conditional skip honestly instead of faking execution.",
      note:
        "Independent security review: the M1, M2, and M3 slices each passed a dedicated adversarial review before landing " +
        "(reviewed spans e85241a86 (M1), e85241a86..a70fba8ca (M2), a70fba8ca..3a933a4e2 (M3), review records in the program " +
        "ledger; all mandated fixes — e.g. the M2 mesh_node trust guards and the M3 infrastructure-error retry narrowing — " +
        "shipped in those commits). The M4 fold of the M3 review Minor (vault-capacity pre-fence ordering) executes in " +
        "mesh-publication.gateway-owners.",
    },
  ];
}

/**
 * Static scans (pure). `files` carries `{ path, content }` records grouped by
 * scan surface so the unit test can prove the scan logic without touching the
 * real filesystem.
 */
export function runMeshCapabilityStaticScans({ opsPanelFiles, opsClientFiles, meshOwnerFiles }) {
  // Scan A — the Ops surface renders semantic facts, never raw manifest JSON:
  // the panel may not stringify data into the DOM, inject HTML, or dump
  // <pre> blocks, and neither panel nor client may touch descriptor bytes or
  // canonical JSON fields (the inspection projection carries none).
  const panelForbidden = /JSON\.stringify\(|dangerouslySetInnerHTML|<pre\b/u;
  const surfaceDescriptorTokens = /descriptorJson|canonicalJson|inputSchema|outputSchema|\.descriptor\b/u;
  const opsMatches = [
    ...findLineMatches(opsPanelFiles, panelForbidden),
    ...findLineMatches([...opsPanelFiles, ...opsClientFiles], surfaceDescriptorTokens),
  ];

  // Scan B — packet row 7: the mesh capability gateway owners reference no
  // MCP transport client and no skill-lifecycle writer, so a published
  // descriptor can never bypass Gateway MCP mediation or stage a skill.
  const ownerForbidden =
    /invokeMcpTool|McpRuntime|mcp-runtime|McpClient|createMcpDispatcher|skill-hub-lifecycle|SkillHubLifecycle|stageSkillCandidate|approveSkillCandidate/u;
  const ownerMatches = findLineMatches(meshOwnerFiles, ownerForbidden);

  return {
    passed: opsMatches.length === 0 && ownerMatches.length === 0,
    detail: {
      opsSurface: {
        checkedFiles: [...opsPanelFiles, ...opsClientFiles].map((file) => file.path),
        matches: opsMatches,
      },
      meshOwners: {
        checkedFiles: meshOwnerFiles.map((file) => file.path),
        matches: ownerMatches,
      },
    },
  };
}

function findLineMatches(files, pattern) {
  const matches = [];
  for (const file of files) {
    const lines = String(file.content).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!pattern.test(line)) return;
      matches.push({ file: String(file.path).replaceAll("\\", "/"), line: index + 1, text: line.trim().slice(0, 200) });
    });
  }
  return matches;
}

/**
 * Fold executed check results into the packet proof-matrix rows.
 *   * any failing cited check fails the row;
 *   * a row with a declared skipReason NEVER reports plain "executed": with
 *     passing checks it reports "executed_with_declared_skip", with none it
 *     reports "skipped_with_reason" — both visibly honest;
 *   * a row with neither passing checks nor a skipReason is a table bug and
 *     FAILS (the dropped-row guard).
 */
export function deriveMeshProofRowStatuses(matrix, checkResults) {
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
export function deriveMeshLaneStatus(checkResults, rowStatuses) {
  const failedChecks = [...checkResults.values()].filter((result) => result.status === "failed");
  const failedRows = rowStatuses.filter((row) => row.status === "failed");
  return failedChecks.length === 0 && failedRows.length === 0 ? "passed" : "failed";
}
