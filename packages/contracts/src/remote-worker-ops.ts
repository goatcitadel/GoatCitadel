import { compareRemoteWorkerCanonicalIdentifiers } from "./remote-worker-admission.js";

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
