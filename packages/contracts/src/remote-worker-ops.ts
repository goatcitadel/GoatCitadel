import { compareRemoteWorkerCanonicalIdentifiers } from "./remote-worker-admission.js";
import {
  REMOTE_WORKER_ASSIGNMENT_EVENT_TYPES,
  type RemoteWorkerAssignmentControlAction,
  type RemoteWorkerAssignmentEventType,
  type RemoteWorkerAssignmentSettlementOrigin,
  type RemoteWorkerAssignmentSettlementOutcome,
} from "./remote-worker-assignment.js";

export const REMOTE_WORKER_REGISTRY_ITEM_SCHEMA_VERSION = "goatcitadel.remote-worker-registry-item.v1" as const;
export const REMOTE_WORKER_REGISTRY_PAGE_SCHEMA_VERSION = "goatcitadel.remote-worker-registry-page.v1" as const;
export const REMOTE_WORKER_REGISTRY_DETAIL_SCHEMA_VERSION = "goatcitadel.remote-worker-registry-detail.v1" as const;
export const REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION = "goatcitadel.remote-worker-registry-cursor.v1" as const;
export const REMOTE_WORKER_REGISTRY_DEFAULT_LIMIT = 25;
export const REMOTE_WORKER_REGISTRY_MAX_LIMIT = 100;
export const REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES = 2_048;

export type RemoteWorkerTruthAuthorityClass =
  | "canonical_record"
  | "derived_projection"
  | "retained_signal"
  | "unavailable";

export interface RemoteWorkerTruth<T> {
  readonly value: T | null;
  readonly authorityClass: RemoteWorkerTruthAuthorityClass;
  readonly owner: string;
  readonly observedAt: string;
  readonly caveat?: string;
}

export interface RemoteWorkerRegistryAdmission {
  readonly registryWorkspaceId: string;
  readonly workerId: string;
  readonly nodeId: string;
  readonly workerGeneration: number;
  readonly workerLabel: string;
  readonly platform: "windows" | "linux" | "darwin";
  readonly architecture: "x64" | "arm64";
  readonly allowedWorkspaceCount: number;
  readonly workspaceCeilingSha256: string;
  readonly capabilityClassCount: number;
  readonly capabilityCeilingSha256: string;
  readonly publicKeySpkiSha256: string;
  readonly clientCertificateSha256: string;
  readonly runtimeManifestSha256: string;
  readonly transportIdentitySource: "native_mtls" | "trusted_terminator";
  readonly transportTrustAnchorSha256: string;
  readonly transportVerificationReceiptSha256: string;
  readonly proofOfPossessionReceiptSha256: string;
  readonly downloadVerificationReceiptSha256: string;
  readonly installedTreeAttestationSha256: string;
  readonly installedTreeVerificationReceiptSha256: string;
  readonly admittedAt: string;
}

export interface RemoteWorkerRegistryControl {
  readonly workerGeneration: number;
  readonly controlRevision: number;
  readonly action: "quarantine" | "revoke";
  readonly createdAt: string;
}

export type RemoteWorkerRegistryPosture = "active" | "quarantined" | "revoked";

export interface RemoteWorkerRegistryUnavailableSections {
  readonly connectionHealth: RemoteWorkerTruth<never>;
  readonly assignments: RemoteWorkerTruth<never>;
  readonly usageAndCost: RemoteWorkerTruth<never>;
  readonly resourceCell: RemoteWorkerTruth<never>;
  readonly artifactAndEffects: RemoteWorkerTruth<never>;
}

export interface RemoteWorkerRegistryItem {
  readonly schemaVersion: typeof REMOTE_WORKER_REGISTRY_ITEM_SCHEMA_VERSION;
  readonly workerId: string;
  readonly admission: RemoteWorkerTruth<RemoteWorkerRegistryAdmission>;
  readonly control: RemoteWorkerTruth<RemoteWorkerRegistryControl>;
  readonly posture: RemoteWorkerTruth<RemoteWorkerRegistryPosture>;
  readonly unavailable: RemoteWorkerRegistryUnavailableSections;
}

export interface RemoteWorkerRegistryPage {
  readonly schemaVersion: typeof REMOTE_WORKER_REGISTRY_PAGE_SCHEMA_VERSION;
  readonly readOnly: true;
  readonly mutationSemantics: "none";
  readonly workspaceId: string;
  readonly items: readonly RemoteWorkerRegistryItem[];
  readonly nextCursor?: string;
  readonly observedAt: string;
}

export interface RemoteWorkerRegistryDetail {
  readonly schemaVersion: typeof REMOTE_WORKER_REGISTRY_DETAIL_SCHEMA_VERSION;
  readonly readOnly: true;
  readonly mutationSemantics: "none";
  readonly workspaceId: string;
  readonly item: RemoteWorkerRegistryItem;
  readonly observedAt: string;
}

export interface RemoteWorkerRegistryCursorV1 {
  readonly schemaVersion: typeof REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly lastWorkerId: string;
}

export function normalizeRemoteWorkerRegistryCursor(value: unknown): RemoteWorkerRegistryCursorV1 {
  const record = strictRecord(value, "remote worker registry cursor", ["schemaVersion", "workspaceId", "lastWorkerId"]);
  if (record.schemaVersion !== REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION) {
    throw invalid("Remote worker registry cursor schema is invalid.");
  }
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
    workspaceId: identifier(record.workspaceId, "cursor workspace ID", 256),
    lastWorkerId: identifier(record.lastWorkerId, "cursor worker ID", 256),
  });
}

export function assertRemoteWorkerRegistryPage(value: unknown): asserts value is RemoteWorkerRegistryPage {
  const record = strictRecord(
    value,
    "remote worker registry page",
    ["schemaVersion", "readOnly", "mutationSemantics", "workspaceId", "items", "observedAt"],
    ["nextCursor"],
  );
  if (
    record.schemaVersion !== REMOTE_WORKER_REGISTRY_PAGE_SCHEMA_VERSION ||
    record.readOnly !== true ||
    record.mutationSemantics !== "none"
  ) {
    throw invalid("Remote worker registry page contract is invalid.");
  }
  const workspaceId = identifier(record.workspaceId, "page workspace ID", 256);
  timestamp(record.observedAt, "page observedAt");
  if (!Array.isArray(record.items) || record.items.length > REMOTE_WORKER_REGISTRY_MAX_LIMIT) {
    throw invalid("Remote worker registry page items are invalid.");
  }
  let previousWorkerId: string | undefined;
  for (const item of record.items) {
    assertRemoteWorkerRegistryItem(item);
    if (item.admission.value?.registryWorkspaceId !== workspaceId) {
      throw invalid("Remote worker registry page contains a foreign workspace item.");
    }
    if (
      previousWorkerId !== undefined &&
      compareRemoteWorkerCanonicalIdentifiers(previousWorkerId, item.workerId) >= 0
    ) {
      throw invalid("Remote worker registry page worker order is invalid.");
    }
    previousWorkerId = item.workerId;
  }
  if (record.nextCursor !== undefined)
    boundedString(record.nextCursor, "next cursor", REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES);
}

export function assertRemoteWorkerRegistryDetail(value: unknown): asserts value is RemoteWorkerRegistryDetail {
  const record = strictRecord(value, "remote worker registry detail", [
    "schemaVersion",
    "readOnly",
    "mutationSemantics",
    "workspaceId",
    "item",
    "observedAt",
  ]);
  if (
    record.schemaVersion !== REMOTE_WORKER_REGISTRY_DETAIL_SCHEMA_VERSION ||
    record.readOnly !== true ||
    record.mutationSemantics !== "none"
  ) {
    throw invalid("Remote worker registry detail contract is invalid.");
  }
  const workspaceId = identifier(record.workspaceId, "detail workspace ID", 256);
  timestamp(record.observedAt, "detail observedAt");
  assertRemoteWorkerRegistryItem(record.item);
  if (record.item.admission.value?.registryWorkspaceId !== workspaceId) {
    throw invalid("Remote worker registry detail contains a foreign workspace item.");
  }
}

export function assertRemoteWorkerRegistryItem(value: unknown): asserts value is RemoteWorkerRegistryItem {
  const record = strictRecord(value, "remote worker registry item", [
    "schemaVersion",
    "workerId",
    "admission",
    "control",
    "posture",
    "unavailable",
  ]);
  if (record.schemaVersion !== REMOTE_WORKER_REGISTRY_ITEM_SCHEMA_VERSION) {
    throw invalid("Remote worker registry item schema is invalid.");
  }
  const workerId = identifier(record.workerId, "item worker ID", 256);
  const admission = truth<RemoteWorkerRegistryAdmission>(
    record.admission,
    "admission",
    assertRemoteWorkerRegistryAdmission,
    false,
  );
  const control = truth<RemoteWorkerRegistryControl>(
    record.control,
    "control",
    assertRemoteWorkerRegistryControl,
    true,
  );
  const posture = truth<RemoteWorkerRegistryPosture>(
    record.posture,
    "posture",
    assertRemoteWorkerRegistryPosture,
    false,
  );
  if (
    admission.authorityClass !== "canonical_record" ||
    admission.value === null ||
    admission.value.workerId !== workerId ||
    control.authorityClass !== "canonical_record" ||
    posture.authorityClass !== "derived_projection" ||
    posture.value === null ||
    (control.value !== null && control.value.workerGeneration !== admission.value.workerGeneration) ||
    posture.value !== postureFromControl(control.value)
  ) {
    throw invalid("Remote worker registry item authority is inconsistent.");
  }
  const unavailable = strictRecord(record.unavailable, "unavailable sections", [
    "connectionHealth",
    "assignments",
    "usageAndCost",
    "resourceCell",
    "artifactAndEffects",
  ]);
  for (const [name, section] of Object.entries(unavailable)) {
    const projected = truth(section, name, () => undefined, true);
    if (projected.authorityClass !== "unavailable" || projected.value !== null) {
      throw invalid(`Remote worker registry ${name} section must remain unavailable.`);
    }
  }
}

export function freezeRemoteWorkerRegistryPage(value: unknown): RemoteWorkerRegistryPage {
  assertRemoteWorkerRegistryPage(value);
  return deepFreeze(value, new Set<object>()) as RemoteWorkerRegistryPage;
}

export function freezeRemoteWorkerRegistryDetail(value: unknown): RemoteWorkerRegistryDetail {
  assertRemoteWorkerRegistryDetail(value);
  return deepFreeze(value, new Set<object>()) as RemoteWorkerRegistryDetail;
}

export function assertRemoteWorkerRegistryAdmission(value: unknown): asserts value is RemoteWorkerRegistryAdmission {
  const record = strictRecord(value, "registry admission", [
    "registryWorkspaceId",
    "workerId",
    "nodeId",
    "workerGeneration",
    "workerLabel",
    "platform",
    "architecture",
    "allowedWorkspaceCount",
    "workspaceCeilingSha256",
    "capabilityClassCount",
    "capabilityCeilingSha256",
    "publicKeySpkiSha256",
    "clientCertificateSha256",
    "runtimeManifestSha256",
    "transportIdentitySource",
    "transportTrustAnchorSha256",
    "transportVerificationReceiptSha256",
    "proofOfPossessionReceiptSha256",
    "downloadVerificationReceiptSha256",
    "installedTreeAttestationSha256",
    "installedTreeVerificationReceiptSha256",
    "admittedAt",
  ]);
  identifier(record.registryWorkspaceId, "registry workspace ID", 256);
  identifier(record.workerId, "worker ID", 256);
  identifier(record.nodeId, "node ID", 256);
  positiveInteger(record.workerGeneration, "worker generation");
  identifier(record.workerLabel, "worker label", 160);
  if (record.platform !== "windows" && record.platform !== "linux" && record.platform !== "darwin") {
    throw invalid("Remote worker registry platform is invalid.");
  }
  if (record.architecture !== "x64" && record.architecture !== "arm64") {
    throw invalid("Remote worker registry architecture is invalid.");
  }
  positiveInteger(record.allowedWorkspaceCount, "allowed workspace count", 16);
  positiveInteger(record.capabilityClassCount, "capability class count", 9);
  for (const field of [
    "workspaceCeilingSha256",
    "capabilityCeilingSha256",
    "publicKeySpkiSha256",
    "clientCertificateSha256",
    "runtimeManifestSha256",
    "transportTrustAnchorSha256",
    "transportVerificationReceiptSha256",
    "proofOfPossessionReceiptSha256",
    "downloadVerificationReceiptSha256",
    "installedTreeAttestationSha256",
    "installedTreeVerificationReceiptSha256",
  ] as const) {
    digest(record[field], field);
  }
  if (record.transportIdentitySource !== "native_mtls" && record.transportIdentitySource !== "trusted_terminator") {
    throw invalid("Remote worker registry transport identity source is invalid.");
  }
  timestamp(record.admittedAt, "admittedAt");
}

export function assertRemoteWorkerRegistryControl(value: unknown): asserts value is RemoteWorkerRegistryControl {
  const record = strictRecord(value, "registry control", [
    "workerGeneration",
    "controlRevision",
    "action",
    "createdAt",
  ]);
  positiveInteger(record.workerGeneration, "control worker generation");
  positiveInteger(record.controlRevision, "control revision");
  if (record.action !== "quarantine" && record.action !== "revoke") {
    throw invalid("Remote worker registry control action is invalid.");
  }
  timestamp(record.createdAt, "control createdAt");
}

export function assertRemoteWorkerRegistryPosture(value: unknown): asserts value is RemoteWorkerRegistryPosture {
  if (value !== "active" && value !== "quarantined" && value !== "revoked") {
    throw invalid("Remote worker registry posture is invalid.");
  }
}

function postureFromControl(value: RemoteWorkerRegistryControl | null): RemoteWorkerRegistryPosture {
  return value?.action === "quarantine" ? "quarantined" : value?.action === "revoke" ? "revoked" : "active";
}

function truth<T>(
  value: unknown,
  label: string,
  assertValue: (candidate: unknown) => void,
  nullable: boolean,
): RemoteWorkerTruth<T> {
  const record = strictRecord(value, `${label} truth`, ["value", "authorityClass", "owner", "observedAt"], ["caveat"]);
  if (
    record.authorityClass !== "canonical_record" &&
    record.authorityClass !== "derived_projection" &&
    record.authorityClass !== "retained_signal" &&
    record.authorityClass !== "unavailable"
  ) {
    throw invalid(`Remote worker registry ${label} authority class is invalid.`);
  }
  boundedString(record.owner, `${label} owner`, 128);
  timestamp(record.observedAt, `${label} observedAt`);
  if (record.caveat !== undefined) boundedString(record.caveat, `${label} caveat`, 512);
  if (record.value === null) {
    if (!nullable) throw invalid(`Remote worker registry ${label} value is required.`);
  } else {
    assertValue(record.value);
  }
  return record as unknown as RemoteWorkerTruth<T>;
}

function strictRecord(
  value: unknown,
  label: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`Remote worker ${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(`Remote worker ${label} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) throw invalid(`Remote worker ${label} has invalid keys.`);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const stringKeys = keys as string[];
  if (
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key)) ||
    stringKeys.some((key) => !allowed.has(key)) ||
    stringKeys.some((key) => descriptors[key]?.get !== undefined || descriptors[key]?.set !== undefined)
  ) {
    throw invalid(`Remote worker ${label} fields are invalid.`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string, maximumBytes: number): string {
  const normalized = boundedString(value, label, maximumBytes);
  if (normalized.normalize("NFKC") !== normalized || normalized.trim() !== normalized) {
    throw invalid(`Remote worker registry ${label} is invalid.`);
  }
  return normalized;
}

function boundedString(value: unknown, label: string, maximumCharacters: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumCharacters || /\p{Cc}/u.test(value)) {
    throw invalid(`Remote worker registry ${label} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw invalid(`Remote worker registry ${label} is invalid.`);
  }
  return value as number;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw invalid(`Remote worker registry ${label} is invalid.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw invalid(`Remote worker registry ${label} is invalid.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw invalid(`Remote worker registry ${label} is invalid.`);
  }
  return value;
}

function deepFreeze<T>(value: T, seen: Set<object>): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  const object = value as object;
  if (seen.has(object)) throw invalid("Remote worker registry response contains a cycle.");
  seen.add(object);
  for (const child of Object.values(object)) deepFreeze(child, seen);
  seen.delete(object);
  return Object.freeze(value);
}

function invalid(message: string): TypeError {
  return new TypeError(message);
}

function nonNegativeInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw invalid(`Remote worker registry ${label} is invalid.`);
  }
  return value as number;
}

function nullableIdentifier(value: unknown, label: string, maximumBytes: number): string | null {
  return value === null ? null : identifier(value, label, maximumBytes);
}

// ============================================================================
// HX-507B assignment, event, and reconciliation projections.
//
// Every section carries a server-authored RemoteWorkerTruth descriptor and is
// SECRET-FREE: it never exposes lease tokens, credential hashes, dispatch
// authority, reason/request digests, idempotency keys, transcript deltas,
// tool arguments, terminal output, host paths, or raw event bodies. Missing
// downstream owners (HX-503 usage, HX-505 resource-cell/cleanup, HX-506
// artifact/effect) stay `unavailable` and are never projected as clean/$0.
// ============================================================================

export const REMOTE_WORKER_ASSIGNMENT_PROJECTION_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-projection.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_PAGE_SCHEMA_VERSION = "goatcitadel.remote-worker-assignment-page.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_CURSOR_SCHEMA_VERSION = "goatcitadel.remote-worker-assignment-cursor.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_EVENT_PAGE_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-event-page.v1" as const;
export const REMOTE_WORKER_RECONCILIATION_SCHEMA_VERSION = "goatcitadel.remote-worker-reconciliation.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_DEFAULT_LIMIT = 20;
export const REMOTE_WORKER_ASSIGNMENT_MAX_LIMIT = 100;
export const REMOTE_WORKER_ASSIGNMENT_EVENT_DEFAULT_LIMIT = 50;
export const REMOTE_WORKER_ASSIGNMENT_EVENT_MAX_LIMIT = 200;

export type RemoteWorkerAssignmentPhase = "created" | "leased" | "lease_expired" | "cancelling" | "settled";

export interface RemoteWorkerAssignmentLineage {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly durableRunId: string;
  readonly createdAt: string;
}

export interface RemoteWorkerAssignmentIdentity {
  readonly assignmentGeneration: number;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly nodeId: string;
  readonly startedAt: string;
}

export interface RemoteWorkerAssignmentLeaseProjection {
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
  readonly workerSentThrough: number;
  readonly serverAcknowledgedThrough: number;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

export interface RemoteWorkerAssignmentLeaseFreshness {
  readonly fresh: boolean;
  readonly expiresAt: string;
}

export interface RemoteWorkerAssignmentControlProjection {
  readonly assignmentGeneration: number;
  readonly controlRevision: number;
  readonly action: RemoteWorkerAssignmentControlAction;
  readonly createdAt: string;
}

export interface RemoteWorkerAssignmentSettlementProjection {
  readonly assignmentGeneration: number;
  readonly outcome: RemoteWorkerAssignmentSettlementOutcome;
  readonly origin: RemoteWorkerAssignmentSettlementOrigin;
  readonly finalEventSequence: number;
  readonly settledAt: string;
}

export interface RemoteWorkerAssignmentMaterializationProjection {
  readonly count: number;
  readonly chatTranscriptCount: number;
  readonly durableRunResultCount: number;
  readonly latestMaterializedAt: string;
}

export interface RemoteWorkerAssignmentUnavailableSections {
  readonly usageAndCost: RemoteWorkerTruth<never>;
  readonly resourceCell: RemoteWorkerTruth<never>;
  readonly artifactAndEffects: RemoteWorkerTruth<never>;
}

export interface RemoteWorkerAssignmentProjection {
  readonly schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_PROJECTION_SCHEMA_VERSION;
  readonly assignmentId: string;
  readonly lineage: RemoteWorkerTruth<RemoteWorkerAssignmentLineage>;
  readonly identity: RemoteWorkerTruth<RemoteWorkerAssignmentIdentity>;
  readonly lease: RemoteWorkerTruth<RemoteWorkerAssignmentLeaseProjection>;
  readonly leaseFreshness: RemoteWorkerTruth<RemoteWorkerAssignmentLeaseFreshness>;
  readonly control: RemoteWorkerTruth<RemoteWorkerAssignmentControlProjection>;
  readonly settlement: RemoteWorkerTruth<RemoteWorkerAssignmentSettlementProjection>;
  readonly materialization: RemoteWorkerTruth<RemoteWorkerAssignmentMaterializationProjection>;
  readonly phase: RemoteWorkerTruth<RemoteWorkerAssignmentPhase>;
  readonly unavailable: RemoteWorkerAssignmentUnavailableSections;
}

export interface RemoteWorkerAssignmentFilters {
  readonly workerId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export interface RemoteWorkerAssignmentPage {
  readonly schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_PAGE_SCHEMA_VERSION;
  readonly readOnly: true;
  readonly mutationSemantics: "none";
  readonly workspaceId: string;
  readonly filters: RemoteWorkerAssignmentFilters;
  readonly items: readonly RemoteWorkerAssignmentProjection[];
  readonly nextCursor?: string;
  readonly observedAt: string;
}

export interface RemoteWorkerAssignmentCursorV1 {
  readonly schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_CURSOR_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly workerId: string | null;
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly lastCreatedAt: string;
  readonly lastAssignmentId: string;
}

export interface RemoteWorkerAssignmentEventSummary {
  readonly sequence: number;
  readonly eventId: string;
  readonly eventType: RemoteWorkerAssignmentEventType;
  readonly receivedAt: string;
  readonly workerSentThrough: number;
}

export interface RemoteWorkerAssignmentEventOmittedCounts {
  readonly transcriptDeltas: number;
  readonly terminalOutputs: number;
  readonly diagnostics: number;
}

export interface RemoteWorkerAssignmentEventPage {
  readonly schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_EVENT_PAGE_SCHEMA_VERSION;
  readonly readOnly: true;
  readonly mutationSemantics: "none";
  readonly workspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly items: readonly RemoteWorkerAssignmentEventSummary[];
  readonly nextAfterSequence: number;
  readonly omitted: RemoteWorkerAssignmentEventOmittedCounts;
  readonly observedAt: string;
}

export interface RemoteWorkerReconciliationObservation {
  readonly status: "consistent" | "divergent" | "empty";
  readonly summary: string;
}

export interface RemoteWorkerReconciliation {
  readonly schemaVersion: typeof REMOTE_WORKER_RECONCILIATION_SCHEMA_VERSION;
  readonly readOnly: true;
  readonly mutationSemantics: "none";
  readonly workspaceId: string;
  readonly workerId: string;
  readonly posture: RemoteWorkerTruth<RemoteWorkerRegistryPosture>;
  readonly admissionControl: RemoteWorkerTruth<RemoteWorkerReconciliationObservation>;
  readonly assignmentLease: RemoteWorkerTruth<RemoteWorkerReconciliationObservation>;
  readonly settlementMaterialization: RemoteWorkerTruth<RemoteWorkerReconciliationObservation>;
  readonly resourceCell: RemoteWorkerTruth<never>;
  readonly cleanup: RemoteWorkerTruth<never>;
  readonly observedAt: string;
}

const REMOTE_WORKER_ASSIGNMENT_PHASES = new Set<RemoteWorkerAssignmentPhase>([
  "created",
  "leased",
  "lease_expired",
  "cancelling",
  "settled",
]);
const REMOTE_WORKER_ASSIGNMENT_CONTROL_ACTIONS = new Set<RemoteWorkerAssignmentControlAction>([
  "cancel_requested",
  "generation_abandoned",
  "recovery_exhausted",
]);
const REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_OUTCOMES = new Set<RemoteWorkerAssignmentSettlementOutcome>([
  "completed",
  "failed",
  "cancelled",
]);
const REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_ORIGINS = new Set<RemoteWorkerAssignmentSettlementOrigin>([
  "worker",
  "gateway_recovery",
]);
const REMOTE_WORKER_ASSIGNMENT_EVENT_TYPE_SET = new Set<RemoteWorkerAssignmentEventType>(
  REMOTE_WORKER_ASSIGNMENT_EVENT_TYPES,
);
const REMOTE_WORKER_RECONCILIATION_OBSERVATION_STATUSES = new Set(["consistent", "divergent", "empty"]);

export function normalizeRemoteWorkerAssignmentCursor(value: unknown): RemoteWorkerAssignmentCursorV1 {
  const record = strictRecord(value, "assignment cursor", [
    "schemaVersion",
    "workspaceId",
    "workerId",
    "sessionId",
    "turnId",
    "lastCreatedAt",
    "lastAssignmentId",
  ]);
  if (record.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_CURSOR_SCHEMA_VERSION) {
    throw invalid("Remote worker assignment cursor schema is invalid.");
  }
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_CURSOR_SCHEMA_VERSION,
    workspaceId: identifier(record.workspaceId, "cursor workspace ID", 256),
    workerId: nullableIdentifier(record.workerId, "cursor worker ID", 256),
    sessionId: nullableIdentifier(record.sessionId, "cursor session ID", 256),
    turnId: nullableIdentifier(record.turnId, "cursor turn ID", 256),
    lastCreatedAt: timestamp(record.lastCreatedAt, "cursor lastCreatedAt"),
    lastAssignmentId: identifier(record.lastAssignmentId, "cursor last assignment ID", 256),
  });
}

export function assertRemoteWorkerAssignmentProjection(
  value: unknown,
): asserts value is RemoteWorkerAssignmentProjection {
  const record = strictRecord(value, "assignment projection", [
    "schemaVersion",
    "assignmentId",
    "lineage",
    "identity",
    "lease",
    "leaseFreshness",
    "control",
    "settlement",
    "materialization",
    "phase",
    "unavailable",
  ]);
  if (record.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_PROJECTION_SCHEMA_VERSION) {
    throw invalid("Remote worker assignment projection schema is invalid.");
  }
  const assignmentId = identifier(record.assignmentId, "assignment ID", 256);
  const lineage = truth<RemoteWorkerAssignmentLineage>(
    record.lineage,
    "lineage",
    assertRemoteWorkerAssignmentLineage,
    false,
  );
  const identity = truth<RemoteWorkerAssignmentIdentity>(
    record.identity,
    "identity",
    assertRemoteWorkerAssignmentIdentity,
    true,
  );
  const lease = truth<RemoteWorkerAssignmentLeaseProjection>(
    record.lease,
    "lease",
    assertRemoteWorkerAssignmentLeaseProjection,
    true,
  );
  const leaseFreshness = truth<RemoteWorkerAssignmentLeaseFreshness>(
    record.leaseFreshness,
    "leaseFreshness",
    assertRemoteWorkerAssignmentLeaseFreshness,
    true,
  );
  const control = truth<RemoteWorkerAssignmentControlProjection>(
    record.control,
    "control",
    assertRemoteWorkerAssignmentControlProjection,
    true,
  );
  const settlement = truth<RemoteWorkerAssignmentSettlementProjection>(
    record.settlement,
    "settlement",
    assertRemoteWorkerAssignmentSettlementProjection,
    true,
  );
  const materialization = truth<RemoteWorkerAssignmentMaterializationProjection>(
    record.materialization,
    "materialization",
    assertRemoteWorkerAssignmentMaterializationProjection,
    true,
  );
  const phase = truth<RemoteWorkerAssignmentPhase>(record.phase, "phase", assertRemoteWorkerAssignmentPhase, false);
  if (
    lineage.authorityClass !== "canonical_record" ||
    lineage.value === null ||
    lineage.value.assignmentId !== assignmentId ||
    (identity.value !== null && identity.authorityClass !== "canonical_record") ||
    (lease.value !== null && lease.authorityClass !== "canonical_record") ||
    (leaseFreshness.value !== null && leaseFreshness.authorityClass !== "derived_projection") ||
    (control.value !== null && control.authorityClass !== "canonical_record") ||
    (settlement.value !== null && settlement.authorityClass !== "canonical_record") ||
    (materialization.value !== null && materialization.authorityClass !== "canonical_record") ||
    phase.authorityClass !== "derived_projection" ||
    phase.value === null
  ) {
    throw invalid("Remote worker assignment projection authority is inconsistent.");
  }
  const unavailable = strictRecord(record.unavailable, "assignment unavailable sections", [
    "usageAndCost",
    "resourceCell",
    "artifactAndEffects",
  ]);
  assertUnavailableTruthSections(unavailable, "assignment", ["usageAndCost", "resourceCell", "artifactAndEffects"]);
}

export function assertRemoteWorkerAssignmentPage(value: unknown): asserts value is RemoteWorkerAssignmentPage {
  const record = strictRecord(
    value,
    "assignment page",
    ["schemaVersion", "readOnly", "mutationSemantics", "workspaceId", "filters", "items", "observedAt"],
    ["nextCursor"],
  );
  if (
    record.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_PAGE_SCHEMA_VERSION ||
    record.readOnly !== true ||
    record.mutationSemantics !== "none"
  ) {
    throw invalid("Remote worker assignment page contract is invalid.");
  }
  identifier(record.workspaceId, "assignment page workspace ID", 256);
  timestamp(record.observedAt, "assignment page observedAt");
  assertRemoteWorkerAssignmentFilters(record.filters);
  if (!Array.isArray(record.items) || record.items.length > REMOTE_WORKER_ASSIGNMENT_MAX_LIMIT) {
    throw invalid("Remote worker assignment page items are invalid.");
  }
  for (const item of record.items) assertRemoteWorkerAssignmentProjection(item);
  if (record.nextCursor !== undefined) {
    boundedString(record.nextCursor, "assignment next cursor", REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES);
  }
}

export function assertRemoteWorkerAssignmentEventPage(
  value: unknown,
): asserts value is RemoteWorkerAssignmentEventPage {
  const record = strictRecord(value, "assignment event page", [
    "schemaVersion",
    "readOnly",
    "mutationSemantics",
    "workspaceId",
    "assignmentId",
    "assignmentGeneration",
    "items",
    "nextAfterSequence",
    "omitted",
    "observedAt",
  ]);
  if (
    record.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_EVENT_PAGE_SCHEMA_VERSION ||
    record.readOnly !== true ||
    record.mutationSemantics !== "none"
  ) {
    throw invalid("Remote worker assignment event page contract is invalid.");
  }
  identifier(record.workspaceId, "event page workspace ID", 256);
  identifier(record.assignmentId, "event page assignment ID", 256);
  positiveInteger(record.assignmentGeneration, "event page assignment generation");
  timestamp(record.observedAt, "event page observedAt");
  nonNegativeInteger(record.nextAfterSequence, "event page nextAfterSequence");
  if (!Array.isArray(record.items) || record.items.length > REMOTE_WORKER_ASSIGNMENT_EVENT_MAX_LIMIT) {
    throw invalid("Remote worker assignment event page items are invalid.");
  }
  let previousSequence = 0;
  for (const item of record.items) {
    assertRemoteWorkerAssignmentEventSummary(item);
    if ((item as RemoteWorkerAssignmentEventSummary).sequence <= previousSequence) {
      throw invalid("Remote worker assignment event page order is invalid.");
    }
    previousSequence = (item as RemoteWorkerAssignmentEventSummary).sequence;
  }
  const omitted = strictRecord(record.omitted, "event omitted counts", [
    "transcriptDeltas",
    "terminalOutputs",
    "diagnostics",
  ]);
  nonNegativeInteger(omitted.transcriptDeltas, "omitted transcriptDeltas");
  nonNegativeInteger(omitted.terminalOutputs, "omitted terminalOutputs");
  nonNegativeInteger(omitted.diagnostics, "omitted diagnostics");
}

export function assertRemoteWorkerReconciliation(value: unknown): asserts value is RemoteWorkerReconciliation {
  const record = strictRecord(value, "reconciliation", [
    "schemaVersion",
    "readOnly",
    "mutationSemantics",
    "workspaceId",
    "workerId",
    "posture",
    "admissionControl",
    "assignmentLease",
    "settlementMaterialization",
    "resourceCell",
    "cleanup",
    "observedAt",
  ]);
  if (
    record.schemaVersion !== REMOTE_WORKER_RECONCILIATION_SCHEMA_VERSION ||
    record.readOnly !== true ||
    record.mutationSemantics !== "none"
  ) {
    throw invalid("Remote worker reconciliation contract is invalid.");
  }
  identifier(record.workspaceId, "reconciliation workspace ID", 256);
  identifier(record.workerId, "reconciliation worker ID", 256);
  timestamp(record.observedAt, "reconciliation observedAt");
  const posture = truth<RemoteWorkerRegistryPosture>(
    record.posture,
    "posture",
    assertRemoteWorkerRegistryPosture,
    false,
  );
  if (posture.authorityClass !== "derived_projection") {
    throw invalid("Remote worker reconciliation posture authority is invalid.");
  }
  for (const name of ["admissionControl", "assignmentLease", "settlementMaterialization"] as const) {
    const section = truth<RemoteWorkerReconciliationObservation>(
      record[name],
      name,
      assertRemoteWorkerReconciliationObservation,
      false,
    );
    if (section.authorityClass !== "derived_projection" || section.value === null) {
      throw invalid(`Remote worker reconciliation ${name} authority is invalid.`);
    }
  }
  assertUnavailableTruthSections(record, "reconciliation", ["resourceCell", "cleanup"]);
}

export function freezeRemoteWorkerAssignmentPage(value: unknown): RemoteWorkerAssignmentPage {
  assertRemoteWorkerAssignmentPage(value);
  return deepFreeze(value, new Set<object>()) as RemoteWorkerAssignmentPage;
}

export function freezeRemoteWorkerAssignmentEventPage(value: unknown): RemoteWorkerAssignmentEventPage {
  assertRemoteWorkerAssignmentEventPage(value);
  return deepFreeze(value, new Set<object>()) as RemoteWorkerAssignmentEventPage;
}

export function freezeRemoteWorkerReconciliation(value: unknown): RemoteWorkerReconciliation {
  assertRemoteWorkerReconciliation(value);
  return deepFreeze(value, new Set<object>()) as RemoteWorkerReconciliation;
}

function assertRemoteWorkerAssignmentFilters(value: unknown): asserts value is RemoteWorkerAssignmentFilters {
  const record = strictRecord(value, "assignment filters", [], ["workerId", "sessionId", "turnId"]);
  if (record.workerId !== undefined) identifier(record.workerId, "filter worker ID", 256);
  if (record.sessionId !== undefined) identifier(record.sessionId, "filter session ID", 256);
  if (record.turnId !== undefined) identifier(record.turnId, "filter turn ID", 256);
}

function assertRemoteWorkerAssignmentLineage(value: unknown): asserts value is RemoteWorkerAssignmentLineage {
  const record = strictRecord(value, "assignment lineage", [
    "registryWorkspaceId",
    "assignmentId",
    "sessionId",
    "turnId",
    "durableRunId",
    "createdAt",
  ]);
  identifier(record.registryWorkspaceId, "lineage workspace ID", 256);
  identifier(record.assignmentId, "lineage assignment ID", 256);
  nullableIdentifier(record.sessionId, "lineage session ID", 256);
  nullableIdentifier(record.turnId, "lineage turn ID", 256);
  identifier(record.durableRunId, "lineage durable run ID", 256);
  timestamp(record.createdAt, "lineage createdAt");
}

function assertRemoteWorkerAssignmentIdentity(value: unknown): asserts value is RemoteWorkerAssignmentIdentity {
  const record = strictRecord(value, "assignment identity", [
    "assignmentGeneration",
    "workerId",
    "workerGeneration",
    "nodeId",
    "startedAt",
  ]);
  positiveInteger(record.assignmentGeneration, "identity assignment generation");
  identifier(record.workerId, "identity worker ID", 256);
  positiveInteger(record.workerGeneration, "identity worker generation");
  identifier(record.nodeId, "identity node ID", 256);
  timestamp(record.startedAt, "identity startedAt");
}

function assertRemoteWorkerAssignmentLeaseProjection(
  value: unknown,
): asserts value is RemoteWorkerAssignmentLeaseProjection {
  const record = strictRecord(value, "assignment lease", [
    "assignmentGeneration",
    "leaseRevision",
    "workerSentThrough",
    "serverAcknowledgedThrough",
    "heartbeatAt",
    "expiresAt",
  ]);
  positiveInteger(record.assignmentGeneration, "lease assignment generation");
  positiveInteger(record.leaseRevision, "lease revision");
  nonNegativeInteger(record.workerSentThrough, "lease workerSentThrough");
  nonNegativeInteger(record.serverAcknowledgedThrough, "lease serverAcknowledgedThrough");
  timestamp(record.heartbeatAt, "lease heartbeatAt");
  timestamp(record.expiresAt, "lease expiresAt");
}

function assertRemoteWorkerAssignmentLeaseFreshness(
  value: unknown,
): asserts value is RemoteWorkerAssignmentLeaseFreshness {
  const record = strictRecord(value, "lease freshness", ["fresh", "expiresAt"]);
  if (typeof record.fresh !== "boolean") throw invalid("Remote worker registry lease freshness is invalid.");
  timestamp(record.expiresAt, "lease freshness expiresAt");
}

function assertRemoteWorkerAssignmentControlProjection(
  value: unknown,
): asserts value is RemoteWorkerAssignmentControlProjection {
  const record = strictRecord(value, "assignment control", [
    "assignmentGeneration",
    "controlRevision",
    "action",
    "createdAt",
  ]);
  positiveInteger(record.assignmentGeneration, "control assignment generation");
  positiveInteger(record.controlRevision, "control revision");
  if (!REMOTE_WORKER_ASSIGNMENT_CONTROL_ACTIONS.has(record.action as RemoteWorkerAssignmentControlAction)) {
    throw invalid("Remote worker assignment control action is invalid.");
  }
  timestamp(record.createdAt, "control createdAt");
}

function assertRemoteWorkerAssignmentSettlementProjection(
  value: unknown,
): asserts value is RemoteWorkerAssignmentSettlementProjection {
  const record = strictRecord(value, "assignment settlement", [
    "assignmentGeneration",
    "outcome",
    "origin",
    "finalEventSequence",
    "settledAt",
  ]);
  positiveInteger(record.assignmentGeneration, "settlement assignment generation");
  if (!REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_OUTCOMES.has(record.outcome as RemoteWorkerAssignmentSettlementOutcome)) {
    throw invalid("Remote worker assignment settlement outcome is invalid.");
  }
  if (!REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_ORIGINS.has(record.origin as RemoteWorkerAssignmentSettlementOrigin)) {
    throw invalid("Remote worker assignment settlement origin is invalid.");
  }
  nonNegativeInteger(record.finalEventSequence, "settlement finalEventSequence");
  timestamp(record.settledAt, "settlement settledAt");
}

function assertRemoteWorkerAssignmentMaterializationProjection(
  value: unknown,
): asserts value is RemoteWorkerAssignmentMaterializationProjection {
  const record = strictRecord(value, "assignment materialization", [
    "count",
    "chatTranscriptCount",
    "durableRunResultCount",
    "latestMaterializedAt",
  ]);
  positiveInteger(record.count, "materialization count");
  nonNegativeInteger(record.chatTranscriptCount, "materialization chatTranscriptCount");
  nonNegativeInteger(record.durableRunResultCount, "materialization durableRunResultCount");
  timestamp(record.latestMaterializedAt, "materialization latestMaterializedAt");
}

function assertRemoteWorkerAssignmentPhase(value: unknown): asserts value is RemoteWorkerAssignmentPhase {
  if (!REMOTE_WORKER_ASSIGNMENT_PHASES.has(value as RemoteWorkerAssignmentPhase)) {
    throw invalid("Remote worker assignment phase is invalid.");
  }
}

function assertRemoteWorkerAssignmentEventSummary(value: unknown): asserts value is RemoteWorkerAssignmentEventSummary {
  const record = strictRecord(value, "assignment event summary", [
    "sequence",
    "eventId",
    "eventType",
    "receivedAt",
    "workerSentThrough",
  ]);
  positiveInteger(record.sequence, "event summary sequence");
  identifier(record.eventId, "event summary event ID", 256);
  if (!REMOTE_WORKER_ASSIGNMENT_EVENT_TYPE_SET.has(record.eventType as RemoteWorkerAssignmentEventType)) {
    throw invalid("Remote worker assignment event summary type is invalid.");
  }
  timestamp(record.receivedAt, "event summary receivedAt");
  nonNegativeInteger(record.workerSentThrough, "event summary workerSentThrough");
}

function assertRemoteWorkerReconciliationObservation(
  value: unknown,
): asserts value is RemoteWorkerReconciliationObservation {
  const record = strictRecord(value, "reconciliation observation", ["status", "summary"]);
  if (!REMOTE_WORKER_RECONCILIATION_OBSERVATION_STATUSES.has(record.status as string)) {
    throw invalid("Remote worker reconciliation observation status is invalid.");
  }
  boundedString(record.summary, "reconciliation observation summary", 256);
}

function assertUnavailableTruthSections(
  container: Record<string, unknown>,
  scope: string,
  names: readonly string[],
): void {
  for (const name of names) {
    const projected = truth(container[name], `${scope} ${name}`, () => undefined, true);
    if (projected.authorityClass !== "unavailable" || projected.value !== null) {
      throw invalid(`Remote worker ${scope} ${name} section must remain unavailable.`);
    }
  }
}
