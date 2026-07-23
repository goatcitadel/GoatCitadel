import { canonicalJsonString } from "./canonical-json.js";

/**
 * HX-505 remote-worker execution-cell contract (production-dark).
 *
 * The Gateway owns the immutable execution-cell profile for ONE active
 * remote-worker assignment generation: the workspace/worker/generation/
 * assignment bindings, the assignment-manifest and path-jail hashes, the
 * logical root and container backend, runtime/launcher attestation, the exact
 * worst-case capacity reservation, the exact egress posture/policy/DNS
 * revision, the backup/staging reservation, and an environment-NAME allowlist
 * hash with no values and no secret references. The worker cannot choose or
 * widen any field; a policy change may only tighten or cancel an unstarted
 * cell.
 *
 * The append-only `remote_worker_cell_evidence` chain records ONLY bounded,
 * secret-free transition/capacity evidence hashes. It never carries transcript
 * text, artifact payloads, raw terminal output, or credentials; `assertExactKeys`
 * rejects every such field.
 */

export const REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-profile.v1" as const;
export const REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-capacity.v1" as const;
export const REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-evidence.v1" as const;
export const REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-platform.v1" as const;

export const REMOTE_WORKER_CELL_EVIDENCE_GENESIS_SHA256 = "0".repeat(64);
export const REMOTE_WORKER_CELL_MAX_EVIDENCE_COUNT = 100_000;

// Worst-case ceilings (bounded so a hostile worker cannot request unbounded
// reservations). Physical/logical bytes are capped at 1 TiB; counts are bounded.
export const REMOTE_WORKER_CELL_MAX_DISK_BYTES = 1_099_511_627_776;
export const REMOTE_WORKER_CELL_MAX_FILE_COUNT = 100_000_000;
export const REMOTE_WORKER_CELL_MAX_PROCESS_COUNT = 100_000;
export const REMOTE_WORKER_CELL_MAX_CPU_MILLI = 1_024_000;
export const REMOTE_WORKER_CELL_MAX_WALL_MS = 604_800_000;
export const REMOTE_WORKER_CELL_MAX_MEMORY_BYTES = 1_099_511_627_776;
export const REMOTE_WORKER_CELL_MAX_ENV_NAMES = 256;

export const REMOTE_WORKER_CELL_BACKENDS = ["container"] as const;
export type RemoteWorkerCellBackend = (typeof REMOTE_WORKER_CELL_BACKENDS)[number];

export const REMOTE_WORKER_CELL_EGRESS_POSTURES = ["deny_all", "allowlisted"] as const;
export type RemoteWorkerCellEgressPosture = (typeof REMOTE_WORKER_CELL_EGRESS_POSTURES)[number];

// --- State machines ---------------------------------------------------------

export const REMOTE_WORKER_CELL_EXECUTION_STATES = [
  "profiled",
  "provisioning",
  "ready",
  "starting",
  "running",
  "exited",
  "cancelled",
  "limit_exceeded",
  "failed",
  "liveness_unknown",
] as const;
export type RemoteWorkerCellExecutionState = (typeof REMOTE_WORKER_CELL_EXECUTION_STATES)[number];

export const REMOTE_WORKER_CELL_EXECUTION_TERMINAL_STATES = [
  "exited",
  "cancelled",
  "limit_exceeded",
  "failed",
] as const;

const EXECUTION_TRANSITIONS: Readonly<
  Record<RemoteWorkerCellExecutionState, readonly RemoteWorkerCellExecutionState[]>
> = {
  profiled: ["provisioning", "cancelled"],
  provisioning: ["ready", "failed", "cancelled", "liveness_unknown"],
  ready: ["starting", "cancelled", "failed"],
  starting: ["running", "failed", "cancelled", "liveness_unknown"],
  running: ["exited", "cancelled", "limit_exceeded", "failed", "liveness_unknown"],
  exited: [],
  cancelled: [],
  limit_exceeded: [],
  failed: [],
  liveness_unknown: [],
};

export const REMOTE_WORKER_CELL_CLEANUP_STATES = [
  "not_started",
  "pending",
  "stopping",
  "verifying_zero",
  "verified_clean",
  "failed_cleanup",
  "manual_reconciliation",
  "quarantined",
] as const;
export type RemoteWorkerCellCleanupState = (typeof REMOTE_WORKER_CELL_CLEANUP_STATES)[number];

const CLEANUP_TRANSITIONS: Readonly<Record<RemoteWorkerCellCleanupState, readonly RemoteWorkerCellCleanupState[]>> = {
  not_started: ["pending"],
  pending: ["stopping"],
  stopping: ["verifying_zero"],
  verifying_zero: ["verified_clean", "failed_cleanup", "manual_reconciliation"],
  verified_clean: [],
  failed_cleanup: ["manual_reconciliation"],
  manual_reconciliation: ["quarantined"],
  quarantined: [],
};

export const REMOTE_WORKER_CELL_BACKUP_STATES = [
  "disabled",
  "pending",
  "staged",
  "verified",
  "corrupt",
  "manual_reconciliation",
  "restore_pending",
  "restored",
  "drifted",
] as const;
export type RemoteWorkerCellBackupState = (typeof REMOTE_WORKER_CELL_BACKUP_STATES)[number];

const BACKUP_TRANSITIONS: Readonly<Record<RemoteWorkerCellBackupState, readonly RemoteWorkerCellBackupState[]>> = {
  disabled: ["pending", "restore_pending"],
  pending: ["staged", "corrupt"],
  staged: ["verified"],
  verified: ["restore_pending"],
  corrupt: ["manual_reconciliation"],
  restore_pending: ["restored", "drifted"],
  restored: [],
  drifted: ["manual_reconciliation"],
  manual_reconciliation: [],
};

export function remoteWorkerCellExecutionCanTransition(
  from: RemoteWorkerCellExecutionState,
  to: RemoteWorkerCellExecutionState,
): boolean {
  return EXECUTION_TRANSITIONS[from]?.includes(to) ?? false;
}

export function remoteWorkerCellCleanupCanTransition(
  from: RemoteWorkerCellCleanupState,
  to: RemoteWorkerCellCleanupState,
): boolean {
  return CLEANUP_TRANSITIONS[from]?.includes(to) ?? false;
}

export function remoteWorkerCellBackupCanTransition(
  from: RemoteWorkerCellBackupState,
  to: RemoteWorkerCellBackupState,
): boolean {
  return BACKUP_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isRemoteWorkerCellExecutionTerminalState(value: string): boolean {
  return (REMOTE_WORKER_CELL_EXECUTION_TERMINAL_STATES as readonly string[]).includes(value);
}

/**
 * `liveness_unknown` blocks deletion, reuse, backup publication, restore, and
 * settlement. Absence never proves dead, clean, or restored.
 */
export function remoteWorkerCellBlocksIrreversibleSettlement(execution: RemoteWorkerCellExecutionState): boolean {
  return execution === "liveness_unknown";
}

// --- Immutable capacity reservation -----------------------------------------

export interface RemoteWorkerCellCapacityReservation {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION;
  /** Assignment logical authored/reference byte ceiling. */
  readonly logicalDiskBytes: number;
  /** Worker unique physical/allocated byte ceiling (worst-case reservation). */
  readonly allocatedDiskBytes: number;
  readonly fileLimit: number;
  readonly inodeLimit: number;
  readonly processLimit: number;
  readonly cpuLimitMilli: number;
  readonly wallLimitMs: number;
  readonly memoryLimitBytes: number;
  readonly rawOutputLimitBytes: number;
  readonly diagnosticLimitBytes: number;
  readonly artifactCeilingBytes: number;
  readonly backupStagingBytes: number;
  readonly backupPublicationBytes: number;
}

const CAPACITY_RESERVATION_KEYS = [
  "schemaVersion",
  "logicalDiskBytes",
  "allocatedDiskBytes",
  "fileLimit",
  "inodeLimit",
  "processLimit",
  "cpuLimitMilli",
  "wallLimitMs",
  "memoryLimitBytes",
  "rawOutputLimitBytes",
  "diagnosticLimitBytes",
  "artifactCeilingBytes",
  "backupStagingBytes",
  "backupPublicationBytes",
] as const;

export function normalizeRemoteWorkerCellCapacityReservation(
  input: RemoteWorkerCellCapacityReservation,
): RemoteWorkerCellCapacityReservation {
  assertRecord(input, "cell capacity reservation");
  assertExactKeys(input, [...CAPACITY_RESERVATION_KEYS], "cell capacity reservation");
  if (input.schemaVersion !== REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION) {
    throw new TypeError("Remote worker cell capacity reservation schema version is unsupported.");
  }
  const logicalDiskBytes = positiveInteger(
    input.logicalDiskBytes,
    "logicalDiskBytes",
    REMOTE_WORKER_CELL_MAX_DISK_BYTES,
  );
  const allocatedDiskBytes = positiveInteger(
    input.allocatedDiskBytes,
    "allocatedDiskBytes",
    REMOTE_WORKER_CELL_MAX_DISK_BYTES,
  );
  if (allocatedDiskBytes < logicalDiskBytes) {
    throw new TypeError("Remote worker cell allocated disk reservation cannot trail its logical ceiling.");
  }
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
    logicalDiskBytes,
    allocatedDiskBytes,
    fileLimit: positiveInteger(input.fileLimit, "fileLimit", REMOTE_WORKER_CELL_MAX_FILE_COUNT),
    inodeLimit: positiveInteger(input.inodeLimit, "inodeLimit", REMOTE_WORKER_CELL_MAX_FILE_COUNT),
    processLimit: positiveInteger(input.processLimit, "processLimit", REMOTE_WORKER_CELL_MAX_PROCESS_COUNT),
    cpuLimitMilli: positiveInteger(input.cpuLimitMilli, "cpuLimitMilli", REMOTE_WORKER_CELL_MAX_CPU_MILLI),
    wallLimitMs: positiveInteger(input.wallLimitMs, "wallLimitMs", REMOTE_WORKER_CELL_MAX_WALL_MS),
    memoryLimitBytes: positiveInteger(input.memoryLimitBytes, "memoryLimitBytes", REMOTE_WORKER_CELL_MAX_MEMORY_BYTES),
    rawOutputLimitBytes: positiveInteger(
      input.rawOutputLimitBytes,
      "rawOutputLimitBytes",
      REMOTE_WORKER_CELL_MAX_DISK_BYTES,
    ),
    diagnosticLimitBytes: positiveInteger(
      input.diagnosticLimitBytes,
      "diagnosticLimitBytes",
      REMOTE_WORKER_CELL_MAX_DISK_BYTES,
    ),
    artifactCeilingBytes: positiveInteger(
      input.artifactCeilingBytes,
      "artifactCeilingBytes",
      REMOTE_WORKER_CELL_MAX_DISK_BYTES,
    ),
    backupStagingBytes: positiveInteger(
      input.backupStagingBytes,
      "backupStagingBytes",
      REMOTE_WORKER_CELL_MAX_DISK_BYTES,
    ),
    backupPublicationBytes: positiveInteger(
      input.backupPublicationBytes,
      "backupPublicationBytes",
      REMOTE_WORKER_CELL_MAX_DISK_BYTES,
    ),
  });
}

// --- Immutable server-owned profile -----------------------------------------

export interface RemoteWorkerCellProfile {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION;
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly cellId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly backend: RemoteWorkerCellBackend;
  readonly logicalRootSha256: string;
  readonly assignmentManifestSha256: string;
  readonly pathJailSha256: string;
  readonly capabilityProfileSha256: string;
  readonly contextSnapshotSha256: string;
  readonly toolEffectPostureSha256: string;
  readonly runtimeAttestationSha256: string;
  readonly launcherAttestationSha256: string;
  readonly capacity: RemoteWorkerCellCapacityReservation;
  readonly egressPosture: RemoteWorkerCellEgressPosture;
  readonly egressPolicySha256: string;
  readonly egressDnsRevision: number;
  readonly envAllowlistSha256: string;
}

const PROFILE_KEYS = [
  "schemaVersion",
  "registryWorkspaceId",
  "assignmentId",
  "assignmentGeneration",
  "cellId",
  "workerId",
  "workerGeneration",
  "backend",
  "logicalRootSha256",
  "assignmentManifestSha256",
  "pathJailSha256",
  "capabilityProfileSha256",
  "contextSnapshotSha256",
  "toolEffectPostureSha256",
  "runtimeAttestationSha256",
  "launcherAttestationSha256",
  "capacity",
  "egressPosture",
  "egressPolicySha256",
  "egressDnsRevision",
  "envAllowlistSha256",
] as const;

export function normalizeRemoteWorkerCellProfile(input: RemoteWorkerCellProfile): RemoteWorkerCellProfile {
  assertRecord(input, "cell profile");
  assertExactKeys(input, [...PROFILE_KEYS], "cell profile");
  if (input.schemaVersion !== REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION) {
    throw new TypeError("Remote worker cell profile schema version is unsupported.");
  }
  enumValue(input.backend, REMOTE_WORKER_CELL_BACKENDS, "backend");
  enumValue(input.egressPosture, REMOTE_WORKER_CELL_EGRESS_POSTURES, "egressPosture");
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION,
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(input.assignmentId, "assignmentId"),
    assignmentGeneration: positiveInteger(input.assignmentGeneration, "assignmentGeneration"),
    cellId: identifier(input.cellId, "cellId"),
    workerId: identifier(input.workerId, "workerId"),
    workerGeneration: positiveInteger(input.workerGeneration, "workerGeneration"),
    backend: input.backend,
    logicalRootSha256: digest(input.logicalRootSha256, "logicalRootSha256"),
    assignmentManifestSha256: digest(input.assignmentManifestSha256, "assignmentManifestSha256"),
    pathJailSha256: digest(input.pathJailSha256, "pathJailSha256"),
    capabilityProfileSha256: digest(input.capabilityProfileSha256, "capabilityProfileSha256"),
    contextSnapshotSha256: digest(input.contextSnapshotSha256, "contextSnapshotSha256"),
    toolEffectPostureSha256: digest(input.toolEffectPostureSha256, "toolEffectPostureSha256"),
    runtimeAttestationSha256: digest(input.runtimeAttestationSha256, "runtimeAttestationSha256"),
    launcherAttestationSha256: digest(input.launcherAttestationSha256, "launcherAttestationSha256"),
    capacity: normalizeRemoteWorkerCellCapacityReservation(input.capacity),
    egressPosture: input.egressPosture,
    egressPolicySha256: digest(input.egressPolicySha256, "egressPolicySha256"),
    egressDnsRevision: positiveInteger(input.egressDnsRevision, "egressDnsRevision"),
    envAllowlistSha256: digest(input.envAllowlistSha256, "envAllowlistSha256"),
  });
}

export function remoteWorkerCellProfileSha256(profile: RemoteWorkerCellProfile): string {
  return remoteWorkerCellCanonicalSha256(normalizeRemoteWorkerCellProfile(profile));
}

/**
 * A policy change may TIGHTEN or CANCEL an unstarted cell but never WIDEN an
 * existing profile. Returns true when `candidate` is a same-identity profile
 * whose every bounded ceiling is <= the existing profile and whose posture is
 * not loosened. The worker can never invoke this to widen a field.
 */
export function remoteWorkerCellProfileTightensOnly(
  existing: RemoteWorkerCellProfile,
  candidate: RemoteWorkerCellProfile,
): boolean {
  const before = normalizeRemoteWorkerCellProfile(existing);
  const after = normalizeRemoteWorkerCellProfile(candidate);
  if (
    before.registryWorkspaceId !== after.registryWorkspaceId ||
    before.assignmentId !== after.assignmentId ||
    before.assignmentGeneration !== after.assignmentGeneration ||
    before.cellId !== after.cellId ||
    before.workerId !== after.workerId ||
    before.workerGeneration !== after.workerGeneration ||
    before.backend !== after.backend ||
    before.logicalRootSha256 !== after.logicalRootSha256
  ) {
    return false;
  }
  const ceilingsTighten =
    after.capacity.logicalDiskBytes <= before.capacity.logicalDiskBytes &&
    after.capacity.allocatedDiskBytes <= before.capacity.allocatedDiskBytes &&
    after.capacity.fileLimit <= before.capacity.fileLimit &&
    after.capacity.inodeLimit <= before.capacity.inodeLimit &&
    after.capacity.processLimit <= before.capacity.processLimit &&
    after.capacity.cpuLimitMilli <= before.capacity.cpuLimitMilli &&
    after.capacity.wallLimitMs <= before.capacity.wallLimitMs &&
    after.capacity.memoryLimitBytes <= before.capacity.memoryLimitBytes &&
    after.capacity.rawOutputLimitBytes <= before.capacity.rawOutputLimitBytes &&
    after.capacity.diagnosticLimitBytes <= before.capacity.diagnosticLimitBytes &&
    after.capacity.artifactCeilingBytes <= before.capacity.artifactCeilingBytes &&
    after.capacity.backupStagingBytes <= before.capacity.backupStagingBytes &&
    after.capacity.backupPublicationBytes <= before.capacity.backupPublicationBytes;
  // Egress may only stay equal or tighten (allowlisted -> deny_all), never widen.
  const egressTightens =
    after.egressPosture === before.egressPosture ||
    (before.egressPosture === "allowlisted" && after.egressPosture === "deny_all");
  return ceilingsTighten && egressTightens;
}

// --- Capacity footprint accounting ------------------------------------------

/**
 * The exact pressure footprint. Every byte a cell can retain is counted: no
 * component can hide capacity, and raw output counts before redaction. Pressure
 * accounting NEVER deletes canonical state or evidence to improve any of these.
 */
export interface RemoteWorkerCellCapacityFootprint {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION;
  readonly mutableRootBytes: number;
  readonly inputStagingBytes: number;
  readonly backupStagingBytes: number;
  readonly artifactStagingBytes: number;
  readonly immutableArtifactBytes: number;
  readonly retainedOutboxBytes: number;
  readonly databaseSidecarBytes: number;
  readonly backupPublicationBytes: number;
  readonly manifestBytes: number;
  readonly proxySidecarBytes: number;
  readonly diagnosticBytes: number;
  readonly failedCleanupBytes: number;
  readonly quarantineEvidenceBytes: number;
}

const CAPACITY_FOOTPRINT_KEYS = [
  "schemaVersion",
  "mutableRootBytes",
  "inputStagingBytes",
  "backupStagingBytes",
  "artifactStagingBytes",
  "immutableArtifactBytes",
  "retainedOutboxBytes",
  "databaseSidecarBytes",
  "backupPublicationBytes",
  "manifestBytes",
  "proxySidecarBytes",
  "diagnosticBytes",
  "failedCleanupBytes",
  "quarantineEvidenceBytes",
] as const;

const CAPACITY_FOOTPRINT_BYTE_KEYS = CAPACITY_FOOTPRINT_KEYS.filter(
  (key): key is Exclude<(typeof CAPACITY_FOOTPRINT_KEYS)[number], "schemaVersion"> => key !== "schemaVersion",
);

export function normalizeRemoteWorkerCellCapacityFootprint(
  input: RemoteWorkerCellCapacityFootprint,
): RemoteWorkerCellCapacityFootprint {
  assertRecord(input, "cell capacity footprint");
  assertExactKeys(input, [...CAPACITY_FOOTPRINT_KEYS], "cell capacity footprint");
  if (input.schemaVersion !== REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION) {
    throw new TypeError("Remote worker cell capacity footprint schema version is unsupported.");
  }
  const normalized: Record<string, unknown> = { schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION };
  let total = 0;
  for (const key of CAPACITY_FOOTPRINT_BYTE_KEYS) {
    const value = nonNegativeInteger(input[key], key, REMOTE_WORKER_CELL_MAX_DISK_BYTES);
    total += value;
    normalized[key] = value;
  }
  if (total > Number.MAX_SAFE_INTEGER) {
    throw new TypeError("Remote worker cell capacity footprint total exceeds the safe integer range.");
  }
  return Object.freeze(normalized as unknown as RemoteWorkerCellCapacityFootprint);
}

export function remoteWorkerCellCapacityFootprintTotalBytes(input: RemoteWorkerCellCapacityFootprint): number {
  const normalized = normalizeRemoteWorkerCellCapacityFootprint(input);
  return CAPACITY_FOOTPRINT_BYTE_KEYS.reduce((sum, key) => sum + normalized[key], 0);
}

/** Bytes that a cleanup/quarantine cannot reclaim and that never vanish from accounting. */
export function remoteWorkerCellUnrecoverableFootprintBytes(input: RemoteWorkerCellCapacityFootprint): number {
  const normalized = normalizeRemoteWorkerCellCapacityFootprint(input);
  return normalized.failedCleanupBytes + normalized.quarantineEvidenceBytes;
}

export function remoteWorkerCellCapacityFootprintSha256(input: RemoteWorkerCellCapacityFootprint): string {
  return remoteWorkerCellCanonicalSha256(normalizeRemoteWorkerCellCapacityFootprint(input));
}

export type RemoteWorkerCellCapacityPressureDecision = "accept" | "reject" | "quarantine";

export interface RemoteWorkerCellCapacityPressureInput {
  readonly footprint: RemoteWorkerCellCapacityFootprint;
  readonly reservation: RemoteWorkerCellCapacityReservation;
  readonly incomingBytes: number;
}

export interface RemoteWorkerCellCapacityPressureResult {
  readonly decision: RemoteWorkerCellCapacityPressureDecision;
  readonly projectedBytes: number;
  readonly allocatedDiskBytes: number;
  readonly unrecoverableBytes: number;
  readonly reason: string;
}

/**
 * Pressure REJECTS or QUARANTINES new work; it never deletes live canonical
 * state or evidence to improve a metric. When the projected physical footprint
 * would exceed the worst-case allocated reservation, unrecoverable
 * failed-cleanup/quarantine bytes force `quarantine`; otherwise new work is
 * `reject`ed. `delete` is not a possible decision.
 */
export function evaluateRemoteWorkerCellCapacityPressure(
  input: RemoteWorkerCellCapacityPressureInput,
): RemoteWorkerCellCapacityPressureResult {
  assertRecord(input, "cell capacity pressure input");
  assertExactKeys(input, ["footprint", "reservation", "incomingBytes"], "cell capacity pressure input");
  const footprint = normalizeRemoteWorkerCellCapacityFootprint(input.footprint);
  const reservation = normalizeRemoteWorkerCellCapacityReservation(input.reservation);
  const incomingBytes = nonNegativeInteger(input.incomingBytes, "incomingBytes", REMOTE_WORKER_CELL_MAX_DISK_BYTES);
  const projectedBytes = remoteWorkerCellCapacityFootprintTotalBytes(footprint) + incomingBytes;
  const unrecoverableBytes = remoteWorkerCellUnrecoverableFootprintBytes(footprint);
  if (projectedBytes <= reservation.allocatedDiskBytes) {
    return Object.freeze({
      decision: "accept",
      projectedBytes,
      allocatedDiskBytes: reservation.allocatedDiskBytes,
      unrecoverableBytes,
      reason: "Projected footprint is within the worst-case allocated reservation.",
    });
  }
  if (unrecoverableBytes > 0) {
    return Object.freeze({
      decision: "quarantine",
      projectedBytes,
      allocatedDiskBytes: reservation.allocatedDiskBytes,
      unrecoverableBytes,
      reason: "Projected footprint exceeds the reservation with unrecoverable retained bytes; quarantine new work.",
    });
  }
  return Object.freeze({
    decision: "reject",
    projectedBytes,
    allocatedDiskBytes: reservation.allocatedDiskBytes,
    unrecoverableBytes,
    reason: "Projected footprint exceeds the worst-case allocated reservation; reject new work.",
  });
}

// --- Platform identity ------------------------------------------------------

export interface RemoteWorkerCellPlatformIdentity {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION;
  readonly backend: RemoteWorkerCellBackend;
  readonly containerName: string;
  readonly containerLabelSha256: string;
  readonly imageDigest: string;
  readonly networkName: string;
}

const PLATFORM_KEYS = [
  "schemaVersion",
  "backend",
  "containerName",
  "containerLabelSha256",
  "imageDigest",
  "networkName",
] as const;

const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CONTAINER_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;

export function normalizeRemoteWorkerCellPlatformIdentity(
  input: RemoteWorkerCellPlatformIdentity,
): RemoteWorkerCellPlatformIdentity {
  assertRecord(input, "cell platform identity");
  assertExactKeys(input, [...PLATFORM_KEYS], "cell platform identity");
  if (input.schemaVersion !== REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION) {
    throw new TypeError("Remote worker cell platform identity schema version is unsupported.");
  }
  enumValue(input.backend, REMOTE_WORKER_CELL_BACKENDS, "backend");
  if (typeof input.containerName !== "string" || !CONTAINER_NAME_PATTERN.test(input.containerName)) {
    throw new TypeError("Remote worker cell container name must be a deterministic lower-case token.");
  }
  if (typeof input.imageDigest !== "string" || !IMAGE_DIGEST_PATTERN.test(input.imageDigest)) {
    throw new TypeError("Remote worker cell image must be pinned to a sha256 digest.");
  }
  if (typeof input.networkName !== "string" || !CONTAINER_NAME_PATTERN.test(input.networkName)) {
    throw new TypeError("Remote worker cell network name must be a deterministic lower-case token.");
  }
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION,
    backend: input.backend,
    containerName: input.containerName,
    containerLabelSha256: digest(input.containerLabelSha256, "containerLabelSha256"),
    imageDigest: input.imageDigest,
    networkName: input.networkName,
  });
}

export function remoteWorkerCellPlatformIdentitySha256(input: RemoteWorkerCellPlatformIdentity): string {
  return remoteWorkerCellCanonicalSha256(normalizeRemoteWorkerCellPlatformIdentity(input));
}

// --- Append-only transition evidence (bounded, secret-free) -----------------

export const REMOTE_WORKER_CELL_EVIDENCE_DOMAINS = ["execution", "cleanup", "backup", "capacity"] as const;
export type RemoteWorkerCellEvidenceDomain = (typeof REMOTE_WORKER_CELL_EVIDENCE_DOMAINS)[number];

export interface RemoteWorkerCellTransitionEvidencePayload {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION;
  readonly domain: "execution" | "cleanup" | "backup";
  readonly fromState: string;
  readonly toState: string;
  readonly detailSha256: string;
}

export interface RemoteWorkerCellCapacityEvidencePayload {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION;
  readonly domain: "capacity";
  readonly capacityRevision: number;
  readonly footprintSha256: string;
  readonly detailSha256: string;
}

export type RemoteWorkerCellEvidencePayload =
  | RemoteWorkerCellTransitionEvidencePayload
  | RemoteWorkerCellCapacityEvidencePayload;

export function normalizeRemoteWorkerCellEvidencePayload(
  input: RemoteWorkerCellEvidencePayload,
): RemoteWorkerCellEvidencePayload {
  assertRecord(input, "cell evidence payload");
  if (input.schemaVersion !== REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION) {
    throw new TypeError("Remote worker cell evidence payload schema version is unsupported.");
  }
  enumValue(input.domain, REMOTE_WORKER_CELL_EVIDENCE_DOMAINS, "domain");
  if (input.domain === "capacity") {
    assertExactKeys(
      input,
      ["schemaVersion", "domain", "capacityRevision", "footprintSha256", "detailSha256"],
      "cell capacity evidence payload",
    );
    return Object.freeze({
      schemaVersion: REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION,
      domain: "capacity",
      capacityRevision: positiveInteger(input.capacityRevision, "capacityRevision"),
      footprintSha256: digest(input.footprintSha256, "footprintSha256"),
      detailSha256: digest(input.detailSha256, "detailSha256"),
    });
  }
  assertExactKeys(
    input,
    ["schemaVersion", "domain", "fromState", "toState", "detailSha256"],
    "cell transition evidence payload",
  );
  const value = input as RemoteWorkerCellTransitionEvidencePayload;
  assertTransitionStatesForDomain(value.domain, value.fromState, value.toState);
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION,
    domain: value.domain,
    fromState: value.fromState,
    toState: value.toState,
    detailSha256: digest(value.detailSha256, "detailSha256"),
  });
}

function assertTransitionStatesForDomain(domain: "execution" | "cleanup" | "backup", from: string, to: string): void {
  if (domain === "execution") {
    enumValue(from, REMOTE_WORKER_CELL_EXECUTION_STATES, "fromState");
    enumValue(to, REMOTE_WORKER_CELL_EXECUTION_STATES, "toState");
    if (
      !remoteWorkerCellExecutionCanTransition(
        from as RemoteWorkerCellExecutionState,
        to as RemoteWorkerCellExecutionState,
      )
    ) {
      throw new TypeError("Remote worker cell execution transition is not permitted by the state machine.");
    }
    return;
  }
  if (domain === "cleanup") {
    enumValue(from, REMOTE_WORKER_CELL_CLEANUP_STATES, "fromState");
    enumValue(to, REMOTE_WORKER_CELL_CLEANUP_STATES, "toState");
    if (
      !remoteWorkerCellCleanupCanTransition(from as RemoteWorkerCellCleanupState, to as RemoteWorkerCellCleanupState)
    ) {
      throw new TypeError("Remote worker cell cleanup transition is not permitted by the state machine.");
    }
    return;
  }
  enumValue(from, REMOTE_WORKER_CELL_BACKUP_STATES, "fromState");
  enumValue(to, REMOTE_WORKER_CELL_BACKUP_STATES, "toState");
  if (!remoteWorkerCellBackupCanTransition(from as RemoteWorkerCellBackupState, to as RemoteWorkerCellBackupState)) {
    throw new TypeError("Remote worker cell backup transition is not permitted by the state machine.");
  }
}

export function remoteWorkerCellEvidencePayloadSha256(input: RemoteWorkerCellEvidencePayload): string {
  return remoteWorkerCellCanonicalSha256(normalizeRemoteWorkerCellEvidencePayload(input));
}

export interface RemoteWorkerCellEvidenceHashInput {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly cellId: string;
  readonly evidenceSequence: number;
  readonly domain: RemoteWorkerCellEvidenceDomain;
  readonly payloadSha256: string;
  readonly previousEvidenceSha256: string;
}

export function remoteWorkerCellEvidenceHashMaterial(input: RemoteWorkerCellEvidenceHashInput): object {
  return Object.freeze({
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(input.assignmentId, "assignmentId"),
    assignmentGeneration: positiveInteger(input.assignmentGeneration, "assignmentGeneration"),
    cellId: identifier(input.cellId, "cellId"),
    evidenceSequence: positiveInteger(
      input.evidenceSequence,
      "evidenceSequence",
      REMOTE_WORKER_CELL_MAX_EVIDENCE_COUNT,
    ),
    domain: assertDomain(input.domain),
    payloadSha256: digest(input.payloadSha256, "payloadSha256"),
    previousEvidenceSha256: digest(input.previousEvidenceSha256, "previousEvidenceSha256"),
  });
}

export function remoteWorkerCellEvidenceSha256(input: RemoteWorkerCellEvidenceHashInput): string {
  return remoteWorkerCellCanonicalSha256(remoteWorkerCellEvidenceHashMaterial(input));
}

export function remoteWorkerCellCanonicalSha256(value: unknown): string {
  return sha256Utf8(canonicalJsonString(value));
}

function assertDomain(value: unknown): RemoteWorkerCellEvidenceDomain {
  enumValue(value, REMOTE_WORKER_CELL_EVIDENCE_DOMAINS, "domain");
  return value;
}

// --- Local validation helpers (browser-safe, dependency-free) ---------------

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Remote worker cell ${field} must be an object.`);
  }
}

function assertExactKeys(value: object, allowed: string[], field: string, optional: string[] = []): void {
  const keys = Object.keys(value);
  const required = allowed.filter((key) => !optional.includes(key));
  if (keys.some((key) => !allowed.includes(key))) {
    throw new TypeError(`Remote worker cell ${field} contains unknown fields.`);
  }
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError(`Remote worker cell ${field} is missing required fields.`);
  }
}

function identifier(value: unknown, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`Remote worker cell ${field} is invalid.`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`Remote worker cell ${field} must be a lower-case SHA-256 digest.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new TypeError(`Remote worker cell ${field} must be a bounded positive integer.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new TypeError(`Remote worker cell ${field} must be a bounded non-negative integer.`);
  }
  return value as number;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new TypeError(`Remote worker cell ${field} is unsupported.`);
  }
}

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
] as const;

function sha256Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const x = schedule[index - 15]!;
      const y = schedule[index - 2]!;
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const upper = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const first = (h! + upper + choice + SHA256_ROUND_CONSTANTS[index]! + schedule[index]!) >>> 0;
      const lower = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const second = (lower + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}
