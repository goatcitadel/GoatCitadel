import type {
  RemoteWorkerAssignmentPhase,
  RemoteWorkerAssignmentSettlementOutcome,
  RemoteWorkerRegistryPosture,
  RemoteWorkerTruthAuthorityClass,
} from "@goatcitadel/contracts";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

const UNKNOWN: StatusPresentation = { label: "Unknown", tone: "neutral" };

const WORKER: Readonly<Record<RemoteWorkerRegistryPosture, StatusPresentation>> = {
  active: { label: "Active", tone: "done" },
  quarantined: { label: "Contained", tone: "waiting" },
  revoked: { label: "Revoked", tone: "failed" },
};
const PHASE: Readonly<Record<RemoteWorkerAssignmentPhase, StatusPresentation>> = {
  created: { label: "Queued", tone: "neutral" },
  leased: { label: "Running", tone: "running" },
  lease_expired: { label: "Lease expired", tone: "waiting" },
  cancelling: { label: "Cancelling", tone: "waiting" },
  settled: { label: "Done", tone: "done" },
};
const SETTLEMENT: Readonly<Record<RemoteWorkerAssignmentSettlementOutcome, StatusPresentation>> = {
  completed: { label: "Done", tone: "done" },
  failed: { label: "Failed", tone: "failed" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
const RECONCILIATION: Readonly<Record<string, StatusPresentation>> = {
  consistent: { label: "Matches", tone: "done" },
  divergent: { label: "Differs", tone: "waiting" },
  empty: { label: "Nothing recorded", tone: "neutral" },
};

export const workerStatus = (posture: RemoteWorkerRegistryPosture | null | undefined): StatusPresentation =>
  (posture && WORKER[posture]) || UNKNOWN;
export const assignmentStatus = (phase: RemoteWorkerAssignmentPhase | null | undefined): StatusPresentation =>
  (phase && PHASE[phase]) || UNKNOWN;
export const settlementStatus = (
  outcome: RemoteWorkerAssignmentSettlementOutcome | null | undefined,
): StatusPresentation => (outcome && SETTLEMENT[outcome]) || UNKNOWN;
export const reconciliationStatus = (status: string | null | undefined): StatusPresentation =>
  (status && RECONCILIATION[status]) || UNKNOWN;

/** How sure a value is, in operator words; the class name itself stays in technical details. */
export const SOURCE_WORDS: Readonly<Record<RemoteWorkerTruthAuthorityClass, string>> = {
  canonical_record: "Saved record",
  derived_projection: "Summary",
  retained_signal: "Last reported",
  unavailable: "Not available",
};

export const shortDigest = (digest: string) => `${digest.slice(0, 10)}…`;

/** `?workerId=` and `?assignmentId=`; a repeated, blank or orphaned value identifies no worker. */
export function readWorkerSelection(search: string): {
  workerId?: string;
  assignmentId?: string;
  invalid: boolean;
} {
  const params = new URLSearchParams(search);
  const workers = params.getAll("workerId"),
    assignments = params.getAll("assignmentId");
  const workerId = workers[0],
    assignmentId = assignments[0];
  const invalid =
    workers.some((value) => !value || value !== workerId) ||
    assignments.some((value) => !value || value !== assignmentId) ||
    workers.length > 1 ||
    assignments.length > 1 ||
    (assignmentId !== undefined && workerId === undefined);
  return { workerId, assignmentId, invalid };
}
