import type { ModelUsageSummary } from "./model-usage.js";
import { REMOTE_WORKER_CELL_BACKENDS, REMOTE_WORKER_CELL_EXECUTION_STATES,
  REMOTE_WORKER_CELL_CLEANUP_STATES, REMOTE_WORKER_CELL_BACKUP_STATES,
  normalizeRemoteWorkerCellCapacityReservation, type RemoteWorkerCellCapacityReservation,
  type RemoteWorkerCellBackend, type RemoteWorkerCellExecutionState,
  type RemoteWorkerCellCleanupState, type RemoteWorkerCellBackupState } from "./remote-worker-cell.js";
import type { RemoteWorkerTruth } from "./remote-worker-ops.js";

export const REMOTE_WORKER_ASSIGNMENT_RUNTIME_SCHEMA_VERSION = "goatcitadel.remote-worker-assignment-runtime.v1" as const;
export interface RemoteWorkerRuntimeReadKey {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
}
export const REMOTE_WORKER_CONTACT_WINDOW_MS = 60_000 as const;
export interface RemoteWorkerContactReadKey {
  readonly registryWorkspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
}
/** Authentication history is a bounded observation, not a live socket or an
 * execution grant. Nonce pruning can remove history before the next read. */
export interface RemoteWorkerContactProjection {
  readonly basis: "credential_request_nonce";
  readonly retention: "replay_window";
  readonly connectionStatus: "unavailable";
  readonly freshness: "recent" | "stale" | "not_observed";
  readonly lastAuthenticatedAt: string | null;
  readonly evaluatedAt: string;
  readonly staleAfter: string | null;
  readonly recentWindowMs: typeof REMOTE_WORKER_CONTACT_WINDOW_MS;
}
export interface RemoteWorkerUsageAndCostProjection {
  readonly usage: ModelUsageSummary;
  /** Outstanding holds are reservations, never charged or final provider cost. */
  readonly pendingReservations: number;
  readonly reservedRequests: number;
  readonly reservedCostMicrousd: number;
}
export interface RemoteWorkerCellRuntimeProjection {
  readonly cellId: string;
  readonly backend: RemoteWorkerCellBackend;
  readonly executionState: RemoteWorkerCellExecutionState;
  readonly executionRevision: number;
  readonly cleanupState: RemoteWorkerCellCleanupState;
  readonly cleanupRevision: number;
  readonly backupState: RemoteWorkerCellBackupState;
  readonly backupRevision: number;
  readonly capacity: RemoteWorkerCellCapacityReservation;
  readonly peakDiskBytes: number;
  readonly peakMemoryBytes: number;
  readonly peakFileCount: number;
  readonly peakProcessCount: number;
  readonly retainedDiagnosticBytes: number;
  readonly failedCleanupRetainedBytes: number;
  readonly quarantineRetainedBytes: number;
  readonly updatedAt: string;
}
export interface RemoteWorkerArtifactsAndEffectsProjection {
  readonly nativeOutputArtifacts?: { readonly nonces: readonly string[]; readonly truncated: boolean };
  readonly nativeFileArtifacts?: { readonly nonces: readonly string[]; readonly truncated: boolean };
  readonly uploadCount: number;
  readonly committedUploadCount: number;
  readonly quarantinedUploadCount: number;
  readonly cleanupPendingCount: number;
  readonly manifestFileCount: number | null;
  readonly manifestTotalBytes: number | null;
  readonly verificationState: "not_required" | "pending" | "satisfied" | null;
  readonly effectIntentCount: number;
  readonly effectReceiptCount: number;
  readonly effectReconciliationCount: number;
}
/** Retained records for the current generation. This read grants no execution
 * authority and does not infer current OS/process/connection health. */
export interface RemoteWorkerAssignmentRuntime {
  readonly schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_RUNTIME_SCHEMA_VERSION;
  readonly readOnly: true;
  readonly mutationSemantics: "none";
  readonly workspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number | null;
  readonly workerId: string | null;
  readonly workerGeneration: number | null;
  readonly observedAt: string;
  readonly usageAndCost: RemoteWorkerTruth<RemoteWorkerUsageAndCostProjection>;
  readonly resourceCell: RemoteWorkerTruth<RemoteWorkerCellRuntimeProjection>;
  readonly artifactAndEffects: RemoteWorkerTruth<RemoteWorkerArtifactsAndEffectsProjection>;
  readonly connectionHealth: RemoteWorkerTruth<RemoteWorkerContactProjection>;
}
const invalid = () => new TypeError("Remote worker runtime projection is invalid.");
function object(input: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || ![...keys, ...optional].includes(key)) ||
    keys.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) throw invalid();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function text(input: unknown): string {
  if (typeof input !== "string" || !input.length || input.length > 256 || input !== input.normalize("NFKC").trim() || /\p{Cc}/u.test(input)) throw invalid();
  return input;
}
function number(input: unknown, positive = false): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < (positive ? 1 : 0)) throw invalid();
  return input;
}
function timestamp(input: unknown): string {
  if (typeof input !== "string" || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) throw invalid();
  return input;
}
function choice<T extends string>(input: unknown, values: readonly T[]): T {
  if (typeof input !== "string" || !values.includes(input as T)) throw invalid();
  return input as T;
}
export function normalizeRemoteWorkerRuntimeReadKey(input: unknown): RemoteWorkerRuntimeReadKey {
  const value = object(input, ["registryWorkspaceId", "assignmentId"]);
  return Object.freeze({ registryWorkspaceId: text(value.registryWorkspaceId), assignmentId: text(value.assignmentId) });
}
export function normalizeRemoteWorkerContactReadKey(input: unknown): RemoteWorkerContactReadKey {
  const value = object(input, ["registryWorkspaceId", "workerId", "workerGeneration"]);
  return Object.freeze({ registryWorkspaceId: text(value.registryWorkspaceId), workerId: text(value.workerId), workerGeneration: number(value.workerGeneration, true) });
}
export function normalizeRemoteWorkerContactProjection(input: unknown): RemoteWorkerContactProjection {
  const value = object(input, ["basis", "retention", "connectionStatus", "freshness", "lastAuthenticatedAt", "evaluatedAt", "staleAfter", "recentWindowMs"]);
  if (value.basis !== "credential_request_nonce" || value.retention !== "replay_window" || value.connectionStatus !== "unavailable" ||
    value.recentWindowMs !== REMOTE_WORKER_CONTACT_WINDOW_MS) throw invalid();
  const evaluatedAt = timestamp(value.evaluatedAt);
  const lastAuthenticatedAt = value.lastAuthenticatedAt === null ? null : timestamp(value.lastAuthenticatedAt);
  const staleAfter = value.staleAfter === null ? null : timestamp(value.staleAfter);
  if ((lastAuthenticatedAt === null) !== (staleAfter === null)) throw invalid();
  if (lastAuthenticatedAt !== null && (Date.parse(lastAuthenticatedAt) > Date.parse(evaluatedAt) ||
    Date.parse(staleAfter!) - Date.parse(lastAuthenticatedAt) !== REMOTE_WORKER_CONTACT_WINDOW_MS)) throw invalid();
  const freshness = lastAuthenticatedAt === null ? "not_observed" : Date.parse(evaluatedAt) < Date.parse(staleAfter!) ? "recent" : "stale";
  if (value.freshness !== freshness) throw invalid();
  return Object.freeze({ basis: "credential_request_nonce", retention: "replay_window", connectionStatus: "unavailable",
    freshness, lastAuthenticatedAt, evaluatedAt, staleAfter, recentWindowMs: REMOTE_WORKER_CONTACT_WINDOW_MS });
}
function usage(input: unknown): ModelUsageSummary {
  const metrics = ["inputTokens", "outputTokens", "cachedInputTokens", "costUsd"] as const;
  const value = object(input, ["attemptCount", "uncertainDispatchCount", "trackedAttemptCount", "unknownAttemptCount", "metricAvailability"], metrics);
  const attemptCount = number(value.attemptCount), uncertainDispatchCount = number(value.uncertainDispatchCount);
  const total = number(attemptCount + uncertainDispatchCount);
  const trackedAttemptCount = number(value.trackedAttemptCount), unknownAttemptCount = number(value.unknownAttemptCount);
  if (trackedAttemptCount + unknownAttemptCount > attemptCount) throw invalid();
  const available = object(value.metricAvailability, metrics);
  const metricAvailability = {} as ModelUsageSummary["metricAvailability"];
  const counts: Partial<Record<typeof metrics[number], number>> = {};
  for (const metric of metrics) {
    const item = object(available[metric], ["knownAttemptCount", "unknownAttemptCount", "complete"]);
    const known = number(item.knownAttemptCount), unknown = number(item.unknownAttemptCount);
    if (known + unknown !== total || item.complete !== (unknown === 0)) throw invalid();
    metricAvailability[metric] = Object.freeze({ knownAttemptCount: known, unknownAttemptCount: unknown, complete: unknown === 0 });
    if (Object.hasOwn(value, metric)) {
      const amount = value[metric];
      if (!known || typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || (metric !== "costUsd" && !Number.isSafeInteger(amount))) throw invalid();
      counts[metric] = amount;
    } else if (known) throw invalid();
  }
  return Object.freeze({ attemptCount, uncertainDispatchCount, trackedAttemptCount, unknownAttemptCount,
    ...counts, metricAvailability: Object.freeze(metricAvailability) });
}
export function normalizeRemoteWorkerUsageAndCostProjection(input: unknown): RemoteWorkerUsageAndCostProjection {
  const value = object(input, ["usage", "pendingReservations", "reservedRequests", "reservedCostMicrousd"]);
  const pendingReservations = number(value.pendingReservations), reservedRequests = number(value.reservedRequests);
  const reservedCostMicrousd = number(value.reservedCostMicrousd);
  if ((!pendingReservations && (reservedRequests || reservedCostMicrousd)) || reservedRequests < pendingReservations) throw invalid();
  return Object.freeze({ usage: usage(value.usage), pendingReservations, reservedRequests, reservedCostMicrousd });
}
export function normalizeRemoteWorkerCellRuntimeProjection(input: unknown): RemoteWorkerCellRuntimeProjection {
  const value = object(input, ["cellId", "backend", "executionState", "executionRevision", "cleanupState", "cleanupRevision",
    "backupState", "backupRevision", "capacity", "peakDiskBytes", "peakMemoryBytes", "peakFileCount", "peakProcessCount",
    "retainedDiagnosticBytes", "failedCleanupRetainedBytes", "quarantineRetainedBytes", "updatedAt"]);
  return Object.freeze({ cellId: text(value.cellId), backend: choice(value.backend, REMOTE_WORKER_CELL_BACKENDS),
    executionState: choice(value.executionState, REMOTE_WORKER_CELL_EXECUTION_STATES), executionRevision: number(value.executionRevision),
    cleanupState: choice(value.cleanupState, REMOTE_WORKER_CELL_CLEANUP_STATES), cleanupRevision: number(value.cleanupRevision),
    backupState: choice(value.backupState, REMOTE_WORKER_CELL_BACKUP_STATES), backupRevision: number(value.backupRevision),
    capacity: normalizeRemoteWorkerCellCapacityReservation(object(value.capacity, [
      "schemaVersion", "logicalDiskBytes", "allocatedDiskBytes", "fileLimit", "inodeLimit", "processLimit",
      "cpuLimitMilli", "wallLimitMs", "memoryLimitBytes", "rawOutputLimitBytes", "diagnosticLimitBytes",
      "artifactCeilingBytes", "backupStagingBytes", "backupPublicationBytes",
    ]) as unknown as RemoteWorkerCellCapacityReservation),
    peakDiskBytes: number(value.peakDiskBytes), peakMemoryBytes: number(value.peakMemoryBytes), peakFileCount: number(value.peakFileCount),
    peakProcessCount: number(value.peakProcessCount), retainedDiagnosticBytes: number(value.retainedDiagnosticBytes),
    failedCleanupRetainedBytes: number(value.failedCleanupRetainedBytes), quarantineRetainedBytes: number(value.quarantineRetainedBytes),
    updatedAt: timestamp(value.updatedAt) });
}
export function normalizeRemoteWorkerArtifactsAndEffectsProjection(input: unknown): RemoteWorkerArtifactsAndEffectsProjection {
  const value = object(input, ["uploadCount", "committedUploadCount", "quarantinedUploadCount", "cleanupPendingCount",
    "manifestFileCount", "manifestTotalBytes", "verificationState", "effectIntentCount", "effectReceiptCount", "effectReconciliationCount"], ["nativeOutputArtifacts", "nativeFileArtifacts"]);
  let nativeOutputArtifacts: RemoteWorkerArtifactsAndEffectsProjection["nativeOutputArtifacts"];
  if (value.nativeOutputArtifacts !== undefined) {
    const summary = object(value.nativeOutputArtifacts, ["nonces", "truncated"]);
    if (!Array.isArray(summary.nonces) || summary.nonces.length > 32 || typeof summary.truncated !== "boolean" ||
        summary.nonces.some(nonce => typeof nonce !== "string" || !/^[0-9a-f]{64}$/u.test(nonce) || /^0+$/u.test(nonce)) ||
        new Set(summary.nonces).size !== summary.nonces.length || (summary.truncated && summary.nonces.length !== 32)) throw invalid();
    nativeOutputArtifacts = Object.freeze({ nonces: Object.freeze([...summary.nonces]), truncated: summary.truncated });
  }
  let nativeFileArtifacts: RemoteWorkerArtifactsAndEffectsProjection["nativeFileArtifacts"];
  if (value.nativeFileArtifacts !== undefined) {
    const summary = object(value.nativeFileArtifacts, ["nonces", "truncated"]);
    if (!Array.isArray(summary.nonces) || summary.nonces.length > 32 || typeof summary.truncated !== "boolean" ||
        summary.nonces.some(nonce => typeof nonce !== "string" || !/^[0-9a-f]{64}$/u.test(nonce) || /^0+$/u.test(nonce)) ||
        new Set(summary.nonces).size !== summary.nonces.length || (summary.truncated && summary.nonces.length !== 32)) throw invalid();
    nativeFileArtifacts = Object.freeze({ nonces: Object.freeze([...summary.nonces]), truncated: summary.truncated });
  }
  const uploadCount = number(value.uploadCount), committedUploadCount = number(value.committedUploadCount);
  const quarantinedUploadCount = number(value.quarantinedUploadCount), cleanupPendingCount = number(value.cleanupPendingCount);
  const effectIntentCount = number(value.effectIntentCount), effectReceiptCount = number(value.effectReceiptCount);
  const effectReconciliationCount = number(value.effectReconciliationCount);
  const manifestFileCount = value.manifestFileCount === null ? null : number(value.manifestFileCount);
  const manifestTotalBytes = value.manifestTotalBytes === null ? null : number(value.manifestTotalBytes);
  const verificationState = value.verificationState === null ? null : choice(value.verificationState, ["not_required", "pending", "satisfied"] as const);
  if (committedUploadCount + quarantinedUploadCount > uploadCount || cleanupPendingCount > uploadCount ||
    effectReceiptCount > effectIntentCount || effectReconciliationCount > effectReceiptCount ||
    (manifestFileCount === null) !== (manifestTotalBytes === null) || (manifestFileCount === null) !== (verificationState === null) ||
    (manifestFileCount !== null && !committedUploadCount)) throw invalid();
  return Object.freeze({ uploadCount, committedUploadCount, quarantinedUploadCount, cleanupPendingCount,
    manifestFileCount, manifestTotalBytes, verificationState, effectIntentCount, effectReceiptCount, effectReconciliationCount,
    ...(nativeOutputArtifacts ? { nativeOutputArtifacts } : {}), ...(nativeFileArtifacts ? { nativeFileArtifacts } : {}) });
}
export function normalizeRemoteWorkerAssignmentRuntime(input: unknown): RemoteWorkerAssignmentRuntime {
  const value = object(input, ["schemaVersion", "readOnly", "mutationSemantics", "workspaceId", "assignmentId", "assignmentGeneration",
    "workerId", "workerGeneration", "observedAt", "usageAndCost", "resourceCell", "artifactAndEffects", "connectionHealth"]);
  if (value.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_RUNTIME_SCHEMA_VERSION || value.readOnly !== true || value.mutationSemantics !== "none") throw invalid();
  const observedAt = timestamp(value.observedAt), workspaceId = text(value.workspaceId), assignmentId = text(value.assignmentId);
  const generation = value.assignmentGeneration === null ? null : number(value.assignmentGeneration, true);
  const workerId = value.workerId === null ? null : text(value.workerId);
  const workerGeneration = value.workerGeneration === null ? null : number(value.workerGeneration, true);
  if ((generation === null) !== (workerId === null) || (generation === null) !== (workerGeneration === null)) throw invalid();
  const truth = <T>(input: unknown, owner: string, authority: "canonical_record" | "derived_projection" | "unavailable", normalize: (input: unknown) => T): RemoteWorkerTruth<T> => {
    const record = object(input, ["value", "owner", "authorityClass", "observedAt"]);
    if (record.owner !== owner || record.authorityClass !== authority || record.observedAt !== observedAt ||
      ((!generation || authority === "unavailable") && record.value !== null)) throw invalid();
    return Object.freeze({ value: record.value === null ? null : normalize(record.value), owner, authorityClass: authority, observedAt });
  };
  const usageAndCost = truth(value.usageAndCost, "storage.remoteWorkerRuntimeReads", "derived_projection", normalizeRemoteWorkerUsageAndCostProjection);
  const resourceCell = truth(value.resourceCell, "storage.remoteWorkerCells", "canonical_record", normalizeRemoteWorkerCellRuntimeProjection);
  const artifactAndEffects = truth(value.artifactAndEffects, "storage.remoteWorkerRuntimeReads", "derived_projection", normalizeRemoteWorkerArtifactsAndEffectsProjection);
  if (generation && (!usageAndCost.value || !artifactAndEffects.value)) throw invalid();
  const contact = object(value.connectionHealth, ["value", "owner", "authorityClass", "observedAt"]);
  const connectionHealth = contact.authorityClass === "unavailable"
    ? truth<RemoteWorkerContactProjection>(contact, "gateway.remoteWorkerListener", "unavailable", () => { throw invalid(); })
    : truth(contact, "storage.remoteWorkerNonces", "derived_projection", normalizeRemoteWorkerContactProjection);
  if (connectionHealth.authorityClass === "derived_projection" && (!generation || !connectionHealth.value)) throw invalid();
  return Object.freeze({ schemaVersion: REMOTE_WORKER_ASSIGNMENT_RUNTIME_SCHEMA_VERSION, readOnly: true, mutationSemantics: "none",
    workspaceId, assignmentId, assignmentGeneration: generation, workerId, workerGeneration, observedAt, usageAndCost, resourceCell, artifactAndEffects,
    connectionHealth });
}
