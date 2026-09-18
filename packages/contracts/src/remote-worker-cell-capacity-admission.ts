import { canonicalJsonString } from "./canonical-json.js";
import {
  REMOTE_WORKER_CELL_MAX_DISK_BYTES,
  evaluateRemoteWorkerCellCapacityPressure,
  normalizeRemoteWorkerCellCapacityFootprint,
  normalizeRemoteWorkerCellCapacityReservation,
  remoteWorkerCellCapacityFootprintSha256,
  remoteWorkerCellCapacityFootprintTotalBytes,
  type RemoteWorkerCellCapacityFootprint,
  type RemoteWorkerCellCapacityPressureDecision,
  type RemoteWorkerCellCapacityReservation,
} from "./remote-worker-cell.js";

export interface RemoteWorkerCellCapacityMetrics {
  readonly peakDiskBytes: number;
  readonly peakMemoryBytes: number;
  readonly peakFileCount: number;
  readonly peakProcessCount: number;
  readonly rawOutputBytes: number;
}

export interface RemoteWorkerCellCapacityAdmissionObservation extends RemoteWorkerCellCapacityMetrics {
  readonly footprint: RemoteWorkerCellCapacityFootprint;
  readonly reservation: RemoteWorkerCellCapacityReservation;
  readonly incomingBytes: number;
}

export interface RemoteWorkerCellCapacityAdmissionState extends RemoteWorkerCellCapacityMetrics {
  readonly capacity: RemoteWorkerCellCapacityReservation;
  readonly failedCleanupRetainedBytes: number;
  readonly quarantineRetainedBytes: number;
}

export interface RemoteWorkerCellCapacityAdmissionEvaluation {
  readonly decision: RemoteWorkerCellCapacityPressureDecision;
  readonly reason: string;
  readonly footprint: RemoteWorkerCellCapacityFootprint;
  readonly footprintSha256: string;
  readonly highWater: RemoteWorkerCellCapacityMetrics;
}

const RESOURCE_LIMITS = [
  ["peakDiskBytes", "allocatedDiskBytes"],
  ["peakMemoryBytes", "memoryLimitBytes"],
  ["peakFileCount", "fileLimit"],
  ["peakProcessCount", "processLimit"],
  ["rawOutputBytes", "rawOutputLimitBytes"],
] as const;

export function normalizeRemoteWorkerCellCapacityAdmissionObservation(
  input: RemoteWorkerCellCapacityAdmissionObservation,
): RemoteWorkerCellCapacityAdmissionObservation {
  const snapshot = { ...input };
  return Object.freeze({
    ...normalizeRemoteWorkerCellCapacityAdmissionRequest(snapshot),
    footprint: normalizeRemoteWorkerCellCapacityFootprint(snapshot.footprint),
  });
}

/** Validate admission parameters before the separately collected footprint is available. */
export function normalizeRemoteWorkerCellCapacityAdmissionRequest(
  input: Omit<RemoteWorkerCellCapacityAdmissionObservation, "footprint">,
): Omit<RemoteWorkerCellCapacityAdmissionObservation, "footprint"> {
  const snapshot = { ...input };
  assertCapacityCount(snapshot.incomingBytes, "incomingBytes", REMOTE_WORKER_CELL_MAX_DISK_BYTES);
  return Object.freeze({ ...normalizeMetrics(snapshot), reservation: normalizeRemoteWorkerCellCapacityReservation(snapshot.reservation),
    incomingBytes: snapshot.incomingBytes });
}

/** Pure evaluation over a complete owner-supplied footprint and canonical state.
 * The persistence owner must hold authority and cell locks through the decision. */
export function evaluateRemoteWorkerCellCapacityAdmission(
  input: RemoteWorkerCellCapacityAdmissionObservation,
  current: RemoteWorkerCellCapacityAdmissionState,
): RemoteWorkerCellCapacityAdmissionEvaluation {
  const observation = normalizeRemoteWorkerCellCapacityAdmissionObservation(input);
  const capacity = normalizeRemoteWorkerCellCapacityReservation(current.capacity);
  const recorded = normalizeMetrics(current);
  assertCapacityCount(current.failedCleanupRetainedBytes, "failedCleanupRetainedBytes");
  assertCapacityCount(current.quarantineRetainedBytes, "quarantineRetainedBytes");
  if (canonicalJsonString(observation.reservation) !== canonicalJsonString(capacity)) {
    throw new Error("Remote worker cell immutable capacity reservation differs from the observation.");
  }
  const footprint = normalizeRemoteWorkerCellCapacityFootprint({
    ...observation.footprint,
    failedCleanupBytes: Math.max(observation.footprint.failedCleanupBytes, current.failedCleanupRetainedBytes),
    quarantineEvidenceBytes: Math.max(observation.footprint.quarantineEvidenceBytes, current.quarantineRetainedBytes),
  });
  const pressure = evaluateRemoteWorkerCellCapacityPressure({ footprint, reservation: capacity, incomingBytes: observation.incomingBytes });
  const highWater = Object.freeze({
    peakDiskBytes: Math.max(observation.peakDiskBytes, recorded.peakDiskBytes, remoteWorkerCellCapacityFootprintTotalBytes(footprint)),
    peakMemoryBytes: Math.max(observation.peakMemoryBytes, recorded.peakMemoryBytes),
    peakFileCount: Math.max(observation.peakFileCount, recorded.peakFileCount),
    peakProcessCount: Math.max(observation.peakProcessCount, recorded.peakProcessCount),
    rawOutputBytes: Math.max(observation.rawOutputBytes, recorded.rawOutputBytes),
  });
  const exceeded = RESOURCE_LIMITS.filter(([metric, limit]) => highWater[metric] > capacity[limit]);
  return Object.freeze({
    decision: exceeded.length > 0 ? "quarantine" : pressure.decision,
    reason: exceeded.length > 0
      ? `Observed or retained ${exceeded.map(([metric]) => metric).join(", ")} exceeds the immutable reservation; quarantine new work.`
      : pressure.reason,
    footprint,
    footprintSha256: remoteWorkerCellCapacityFootprintSha256(footprint),
    highWater,
  });
}

function normalizeMetrics(input: RemoteWorkerCellCapacityMetrics): RemoteWorkerCellCapacityMetrics {
  const result = {
    peakDiskBytes: input.peakDiskBytes, peakMemoryBytes: input.peakMemoryBytes,
    peakFileCount: input.peakFileCount, peakProcessCount: input.peakProcessCount, rawOutputBytes: input.rawOutputBytes,
  };
  for (const [metric] of RESOURCE_LIMITS) assertCapacityCount(result[metric], metric);
  return Object.freeze(result);
}

function assertCapacityCount(value: number, label: string, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`Remote worker cell ${label} must be a non-negative safe integer no greater than ${max}.`);
  }
}
