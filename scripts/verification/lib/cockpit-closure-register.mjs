import { createHash } from "node:crypto";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function entry(row, kind) {
  return {
    id: row.id,
    kind,
    ownerTask: row.owner_task,
    historicalDigest: digest(row),
    priorStatus: row.current_implementation_status ?? null,
    criterion: row.acceptance_criterion ?? row.acceptance ?? null,
    legacyUrl: row.legacy_url ?? null,
    nativeDestination: row.native_destination ?? null,
    status: "pending_recheck",
    parityVerified: false,
    owner: { task: row.owner_task, scope: row.release_scope?.area ?? "Cockpit remediation" },
    acceptanceResult: "Unverified on this candidate",
    currentDisposition: "Recheck implementation and executable acceptance",
    priorEvidence: structuredClone(row.evidence_references ?? []),
    evidence: [],
    dependency: "Current candidate source, action, error, scope and deep-link acceptance",
  };
}

/** Historical input is immutable. Accepted slices are provenance, never blanket capability certification. */
export function buildCockpitClosureRegister({ revision, ciRevision, sourceDigest, ledger, inventory }) {
  return {
    schemaVersion: 2,
    sourceDigest,
    revision,
    ciRevision,
    priorTaskSlices: structuredClone(
      Object.fromEntries(
        Object.entries({ ledger, inventory }).map(([kind, value]) => [
          kind,
          Object.fromEntries(Object.entries(value).filter(([key]) => /^task_(15|16|17)_/.test(key))),
        ]),
      ),
    ),
    historicalDigests: { ledger: digest(ledger), inventory: digest(inventory) },
    findings: ledger.findings.map((row) => entry(row, "finding")),
    capabilities: [
      ...inventory.routes.map((row) => entry(row, "route")),
      ...inventory.legacy_adapters.map((row) => entry(row, "legacy_adapter")),
      ...inventory.shell_capabilities.map((row) => entry(row, "shell_capability")),
    ],
    retirement: { ready: false, stableCycleElapsed: false, rollbackRetained: true },
  };
}

export function validateCockpitClosureRegister(register) {
  const errors = [];
  if (!/^[a-f0-9]{40}$/u.test(register.revision ?? "")) errors.push("candidate revision must be a full SHA");
  for (const [kind, rows] of [
    ["findings", register.findings],
    ["capabilities", register.capabilities],
  ]) {
    const ids = new Set();
    for (const row of rows ?? []) {
      if (!row.id || ids.has(row.id)) errors.push(`${kind}: duplicate or missing identifier ${row.id}`);
      ids.add(row.id);
      if (
        (row.status === "verified" || row.parityVerified) &&
        !row.evidence?.some(
          (item) =>
            item.revision === register.revision &&
            /^[a-f0-9]{64}$/u.test(register.sourceDigest ?? "") &&
            item.sourceDigest === register.sourceDigest &&
            item.outcome === "passed" &&
            item.artifact,
        )
      ) {
        errors.push(`${row.id}: acceptance requires passed candidate-bound evidence`);
      }
    }
  }
  if (
    register.retirement?.ready &&
    (!register.retirement.stableCycleElapsed || register.capabilities.some((row) => !row.parityVerified))
  )
    errors.push("retirement requires complete parity and a real Stable cycle");
  return errors;
}

export { verificationSourceDigest as cockpitCandidateSourceDigest } from "./source-identity.mjs";
