/* eslint-disable max-lines -- Admission, claims, and route-ceiling invariants stay in one audited contract boundary. */
import { canonicalJsonString } from "./canonical-json.js";

export const REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION = "goatcitadel.remote-worker-runtime-manifest.v1" as const;
export const REMOTE_WORKER_PROTOCOL_VERSION = "goatcitadel.remote-worker.v1" as const;
export const REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE = "worker_runtime" as const;
export const REMOTE_WORKER_RUNTIME_CREDENTIAL_CLAIMS_SCHEMA_VERSION =
  "goatcitadel.remote-worker-runtime-credential-claims.v1" as const;
export const REMOTE_WORKER_ROUTE_ACCESS_CLASS = "remote-worker" as const;
export const REMOTE_WORKER_MAX_ALLOWED_WORKSPACES = 16;
export const REMOTE_WORKER_MAX_CAPABILITY_CLASSES = 9;
export const REMOTE_WORKER_MAX_BOOTSTRAP_TTL_SECONDS = 600;
export const REMOTE_WORKER_MAX_CREDENTIAL_TTL_SECONDS = 900;
export const REMOTE_WORKER_MAX_RUNTIME_MANIFEST_BYTES = 512 * 1024;
export const REMOTE_WORKER_MAX_RUNTIME_MANIFEST_FILES = 10_000;
export const REMOTE_WORKER_MAX_LABEL_LENGTH = 160;

export const REMOTE_WORKER_CAPABILITY_CLASSES = [
  "durable_compute",
  "gateway_inference",
  "governed_tool",
  "governed_code",
  "artifact_stage",
  "trusted_verification",
  "device_camera",
  "device_location",
  "device_notification",
] as const;

export type RemoteWorkerCapabilityClass = (typeof REMOTE_WORKER_CAPABILITY_CLASSES)[number];
export type RemoteWorkerTransportIdentitySource = "native_mtls" | "trusted_terminator";
export type RemoteWorkerGenerationControlAction = "quarantine" | "revoke";
export type RemoteWorkerBootstrapState = "pending" | "consumed" | "expired";
export type RemoteWorkerEvaluatedRouteAccessClass = typeof REMOTE_WORKER_ROUTE_ACCESS_CLASS | "generic" | "operator";
export type RemoteWorkerRoutePolicyReasonCode =
  | "allowed_by_remote_worker_ceiling"
  | "invalid_credential_claims"
  | "invalid_route_policy_request"
  | "route_access_class_denied"
  | "workspace_ceiling_denied"
  | "capability_ceiling_denied";

export function compareRemoteWorkerCanonicalIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface RemoteWorkerRuntimeManifestPayload {
  schemaVersion: typeof REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION;
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  bundleSha256: string;
  dependencyLockSha256: string;
  vendorTreeSha256: string;
  launcherSha256: string;
  installedTreeManifestSha256: string;
  installedTreeFileCount: number;
  platform: string;
  architecture: string;
}

export interface RemoteWorkerRuntimeManifest {
  payload: RemoteWorkerRuntimeManifestPayload;
  payloadSha256: string;
  signatureAlgorithm: "ed25519";
  signerKeyId: string;
  signatureBase64Url: string;
}

export interface RemoteWorkerBootstrapRecord {
  registryWorkspaceId: string;
  bootstrapId: string;
  workerId: string;
  nodeId: string;
  targetWorkerGeneration: number;
  workerLabel: string;
  platform: string;
  architecture: string;
  runtimeManifest: RemoteWorkerRuntimeManifest;
  allowedWorkspaceIds: string[];
  workspaceCeilingSha256: string;
  capabilityClasses: RemoteWorkerCapabilityClass[];
  capabilityCeilingSha256: string;
  state: RemoteWorkerBootstrapState;
  expiresAt: string;
  createdByActorId: string;
  idempotencyKey: string;
  requestSha256: string;
  createdAt: string;
}

export interface RemoteWorkerGenerationRecord {
  registryWorkspaceId: string;
  workerId: string;
  nodeId: string;
  workerGeneration: number;
  bootstrapId: string;
  publicKeySpkiSha256: string;
  clientCertificateSha256: string;
  runtimeManifestSha256: string;
  workspaceCeilingSha256: string;
  capabilityCeilingSha256: string;
  transportIdentitySource: RemoteWorkerTransportIdentitySource;
  transportTrustAnchorSha256: string;
  transportVerificationReceiptSha256: string;
  proofOfPossessionReceiptSha256: string;
  downloadVerificationReceiptSha256: string;
  installedTreeAttestationSha256: string;
  installedTreeVerificationReceiptSha256: string;
  exchangeIdempotencyKey: string;
  exchangeRequestSha256: string;
  admittedAt: string;
}

export interface RemoteWorkerRuntimeCredentialRecord {
  registryWorkspaceId: string;
  workerId: string;
  workerGeneration: number;
  credentialGeneration: number;
  credentialId: string;
  purpose: typeof REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE;
  claims: RemoteWorkerRuntimeCredentialClaims;
  claimsSha256: string;
  issuanceProofSha256: string;
  idempotencyKey: string;
  requestSha256: string;
  issuedAt: string;
  expiresAt: string;
}

export interface RemoteWorkerGenerationControlRecord {
  registryWorkspaceId: string;
  workerId: string;
  workerGeneration: number;
  controlRevision: number;
  action: RemoteWorkerGenerationControlAction;
  reasonCode: string;
  reasonSha256: string;
  actorId: string;
  idempotencyKey: string;
  requestSha256: string;
  createdAt: string;
}

export interface CreateRemoteWorkerBootstrapRequest {
  readonly registryWorkspaceId: string;
  readonly existingWorkerId?: string;
  readonly workerLabel: string;
  readonly platform: string;
  readonly architecture: string;
  readonly runtimeManifest: RemoteWorkerRuntimeManifest;
  readonly allowedWorkspaceIds: readonly string[];
  readonly capabilityClasses: readonly RemoteWorkerCapabilityClass[];
  readonly expiresInSeconds: number;
  readonly idempotencyKey: string;
}

export interface CreateRemoteWorkerBootstrapCommand extends CreateRemoteWorkerBootstrapRequest {
  readonly createdByActorId: string;
  readonly bootstrapSecretSha256: string;
}

export interface FinalizeRemoteWorkerBootstrapAdmissionCommand {
  readonly expectedRegistryWorkspaceId: string;
  readonly expectedBootstrapId: string;
  readonly expectedTargetWorkerGeneration: number;
  readonly bootstrapSecretSha256: string;
  readonly verifiedPublicKeySpkiSha256: string;
  readonly verifiedClientCertificateSha256: string;
  readonly verifiedRuntimeManifestSha256: string;
  readonly verifiedWorkspaceCeilingSha256: string;
  readonly verifiedCapabilityCeilingSha256: string;
  readonly verifiedTransportIdentitySource: RemoteWorkerTransportIdentitySource;
  readonly verifiedTransportTrustAnchorSha256: string;
  readonly verifiedTransportReceiptSha256: string;
  readonly verifiedProofOfPossessionReceiptSha256: string;
  readonly verifiedDownloadReceiptSha256: string;
  readonly verifiedInstalledTreeAttestationSha256: string;
  readonly verifiedInstalledTreeReceiptSha256: string;
  readonly credentialIssuanceProofSha256: string;
  readonly credentialExpiresInSeconds: number;
  readonly credentialTokenSha256: string;
  readonly exchangeIdempotencyKey: string;
}

export interface RotateRemoteWorkerRuntimeCredentialCommand {
  readonly registryWorkspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly expectedCredentialId: string;
  readonly expectedCredentialGeneration: number;
  readonly verifiedTransportReceiptSha256: string;
  readonly verifiedProofOfPossessionReceiptSha256: string;
  readonly credentialIssuanceProofSha256: string;
  readonly expiresInSeconds: number;
  readonly credentialTokenSha256: string;
  readonly idempotencyKey: string;
}

export interface BuildRemoteWorkerRuntimeCredentialClaimsInput {
  readonly registryWorkspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly allowedWorkspaceIds: readonly string[];
  readonly capabilityClasses: readonly RemoteWorkerCapabilityClass[];
}

export interface RemoteWorkerRuntimeCredentialClaims {
  readonly schemaVersion: typeof REMOTE_WORKER_RUNTIME_CREDENTIAL_CLAIMS_SCHEMA_VERSION;
  readonly protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  readonly purpose: typeof REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE;
  readonly routeAccessClass: typeof REMOTE_WORKER_ROUTE_ACCESS_CLASS;
  readonly registryWorkspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly allowedWorkspaceIds: readonly string[];
  readonly workspaceCeilingSha256: string;
  readonly capabilityClasses: readonly RemoteWorkerCapabilityClass[];
  readonly capabilityCeilingSha256: string;
}

export interface RemoteWorkerRoutePolicyRequest {
  readonly routeAccessClass: RemoteWorkerEvaluatedRouteAccessClass;
  readonly workspaceId: string;
  readonly requiredCapabilityClasses: readonly RemoteWorkerCapabilityClass[];
}

export interface RemoteWorkerRoutePolicyDecision {
  readonly allowed: boolean;
  readonly reasonCode: RemoteWorkerRoutePolicyReasonCode;
  readonly capabilityActivationGranted: false;
}

export interface RemoteWorkerGenerationControlInput {
  registryWorkspaceId: string;
  workerId: string;
  workerGeneration: number;
  reasonCode: string;
  reasonSha256: string;
  actorId: string;
  idempotencyKey: string;
}

export function assertRemoteWorkerRuntimeManifest(manifest: unknown): asserts manifest is RemoteWorkerRuntimeManifest {
  assertRecord(manifest, "runtimeManifest");
  assertExactKeys(
    manifest,
    ["payload", "payloadSha256", "signatureAlgorithm", "signerKeyId", "signatureBase64Url"],
    "runtimeManifest",
  );
  assertRecord(manifest.payload, "runtimeManifest.payload");
  assertExactKeys(
    manifest.payload,
    [
      "schemaVersion",
      "protocolVersion",
      "bundleSha256",
      "dependencyLockSha256",
      "vendorTreeSha256",
      "launcherSha256",
      "installedTreeManifestSha256",
      "installedTreeFileCount",
      "platform",
      "architecture",
    ],
    "runtimeManifest.payload",
  );
  if (manifest.payload.schemaVersion !== REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION) {
    throw new TypeError("Remote worker runtime manifest schema version is unsupported.");
  }
  if (manifest.payload.protocolVersion !== REMOTE_WORKER_PROTOCOL_VERSION) {
    throw new TypeError("Remote worker protocol version is unsupported.");
  }
  assertPlatform(manifest.payload.platform, "runtimeManifest.payload.platform");
  assertArchitecture(manifest.payload.architecture, "runtimeManifest.payload.architecture");
  for (const field of [
    "bundleSha256",
    "dependencyLockSha256",
    "vendorTreeSha256",
    "launcherSha256",
    "installedTreeManifestSha256",
  ] as const) {
    assertSha256(manifest.payload[field], `runtimeManifest.payload.${field}`);
  }
  assertPositiveInteger(
    manifest.payload.installedTreeFileCount,
    "runtimeManifest.payload.installedTreeFileCount",
    REMOTE_WORKER_MAX_RUNTIME_MANIFEST_FILES,
  );
  assertSha256(manifest.payloadSha256, "runtimeManifest.payloadSha256");
  if (sha256CanonicalJson(manifest.payload) !== manifest.payloadSha256) {
    throw new TypeError("Remote worker runtime manifest payload digest does not match its canonical payload bytes.");
  }
  if (manifest.signatureAlgorithm !== "ed25519") {
    throw new TypeError("Remote worker runtime manifest signature algorithm is unsupported.");
  }
  assertIdentifier(manifest.signerKeyId, "runtimeManifest.signerKeyId", 256);
  assertEd25519Signature(manifest.signatureBase64Url);
  const encoded = canonicalJsonString(manifest);
  if (new TextEncoder().encode(encoded).byteLength > REMOTE_WORKER_MAX_RUNTIME_MANIFEST_BYTES) {
    throw new TypeError("Remote worker runtime manifest exceeds its byte limit.");
  }
}

export function normalizeCreateRemoteWorkerBootstrapRequest(
  input: CreateRemoteWorkerBootstrapRequest,
): CreateRemoteWorkerBootstrapRequest {
  assertRecord(input, "bootstrap request");
  assertExactKeys(
    input,
    [
      "registryWorkspaceId",
      "existingWorkerId",
      "workerLabel",
      "platform",
      "architecture",
      "runtimeManifest",
      "allowedWorkspaceIds",
      "capabilityClasses",
      "expiresInSeconds",
      "idempotencyKey",
    ],
    "bootstrap request",
    ["existingWorkerId"],
  );
  const registryWorkspaceId = assertIdentifier(input.registryWorkspaceId, "registryWorkspaceId", 256);
  const existingWorkerId =
    input.existingWorkerId === undefined
      ? undefined
      : assertIdentifier(input.existingWorkerId, "existingWorkerId", 256);
  const workerLabel = assertSafeText(input.workerLabel, "workerLabel", REMOTE_WORKER_MAX_LABEL_LENGTH);
  const platform = assertPlatform(input.platform, "platform");
  const architecture = assertArchitecture(input.architecture, "architecture");
  assertRemoteWorkerRuntimeManifest(input.runtimeManifest);
  if (
    input.runtimeManifest.payload.platform !== platform ||
    input.runtimeManifest.payload.architecture !== architecture
  ) {
    throw new TypeError("Remote worker runtime manifest platform and architecture must match the bootstrap request.");
  }
  const allowedWorkspaceIds = normalizeSortedUniqueIdentifiers(
    input.allowedWorkspaceIds,
    "allowedWorkspaceIds",
    REMOTE_WORKER_MAX_ALLOWED_WORKSPACES,
  );
  if (!allowedWorkspaceIds.includes(registryWorkspaceId)) {
    throw new TypeError("Remote worker allowedWorkspaceIds must include registryWorkspaceId.");
  }
  const capabilityClasses = normalizeCapabilityClasses(input.capabilityClasses);
  const expiresInSeconds = assertPositiveInteger(
    input.expiresInSeconds,
    "expiresInSeconds",
    REMOTE_WORKER_MAX_BOOTSTRAP_TTL_SECONDS,
  );
  const idempotencyKey = assertIdentifier(input.idempotencyKey, "idempotencyKey", 512);
  return Object.freeze({
    registryWorkspaceId,
    ...(existingWorkerId === undefined ? {} : { existingWorkerId }),
    workerLabel,
    platform,
    architecture,
    runtimeManifest: freezeRemoteWorkerRuntimeManifest(input.runtimeManifest),
    allowedWorkspaceIds: Object.freeze(allowedWorkspaceIds),
    capabilityClasses: Object.freeze(capabilityClasses),
    expiresInSeconds,
    idempotencyKey,
  });
}

export function normalizeCreateRemoteWorkerBootstrapCommand(
  command: CreateRemoteWorkerBootstrapCommand,
): CreateRemoteWorkerBootstrapCommand {
  assertRecord(command, "bootstrap persistence command");
  assertExactKeys(
    command,
    [
      "registryWorkspaceId",
      "existingWorkerId",
      "workerLabel",
      "platform",
      "architecture",
      "runtimeManifest",
      "allowedWorkspaceIds",
      "capabilityClasses",
      "expiresInSeconds",
      "idempotencyKey",
      "createdByActorId",
      "bootstrapSecretSha256",
    ],
    "bootstrap persistence command",
    ["existingWorkerId"],
  );
  const request = normalizeCreateRemoteWorkerBootstrapRequest({
    registryWorkspaceId: command.registryWorkspaceId,
    ...(command.existingWorkerId === undefined ? {} : { existingWorkerId: command.existingWorkerId }),
    workerLabel: command.workerLabel,
    platform: command.platform,
    architecture: command.architecture,
    runtimeManifest: command.runtimeManifest,
    allowedWorkspaceIds: command.allowedWorkspaceIds,
    capabilityClasses: command.capabilityClasses,
    expiresInSeconds: command.expiresInSeconds,
    idempotencyKey: command.idempotencyKey,
  });
  assertSha256(command.bootstrapSecretSha256, "bootstrapSecretSha256");
  return Object.freeze({
    ...request,
    createdByActorId: assertIdentifier(command.createdByActorId, "createdByActorId", 256),
    bootstrapSecretSha256: command.bootstrapSecretSha256,
  });
}

export function normalizeFinalizeRemoteWorkerBootstrapAdmissionCommand(
  command: FinalizeRemoteWorkerBootstrapAdmissionCommand,
): FinalizeRemoteWorkerBootstrapAdmissionCommand {
  assertRecord(command, "trusted bootstrap admission command");
  assertExactKeys(
    command,
    [
      "expectedRegistryWorkspaceId",
      "expectedBootstrapId",
      "expectedTargetWorkerGeneration",
      "bootstrapSecretSha256",
      "verifiedPublicKeySpkiSha256",
      "verifiedClientCertificateSha256",
      "verifiedRuntimeManifestSha256",
      "verifiedWorkspaceCeilingSha256",
      "verifiedCapabilityCeilingSha256",
      "verifiedTransportIdentitySource",
      "verifiedTransportTrustAnchorSha256",
      "verifiedTransportReceiptSha256",
      "verifiedProofOfPossessionReceiptSha256",
      "verifiedDownloadReceiptSha256",
      "verifiedInstalledTreeAttestationSha256",
      "verifiedInstalledTreeReceiptSha256",
      "credentialIssuanceProofSha256",
      "credentialExpiresInSeconds",
      "credentialTokenSha256",
      "exchangeIdempotencyKey",
    ],
    "trusted bootstrap admission command",
  );
  assertSha256(command.bootstrapSecretSha256, "bootstrapSecretSha256");
  assertEnum(
    command.verifiedTransportIdentitySource,
    ["native_mtls", "trusted_terminator"],
    "verifiedTransportIdentitySource",
  );
  for (const field of [
    "verifiedPublicKeySpkiSha256",
    "verifiedClientCertificateSha256",
    "verifiedRuntimeManifestSha256",
    "verifiedWorkspaceCeilingSha256",
    "verifiedCapabilityCeilingSha256",
    "verifiedTransportTrustAnchorSha256",
    "verifiedTransportReceiptSha256",
    "verifiedProofOfPossessionReceiptSha256",
    "verifiedDownloadReceiptSha256",
    "verifiedInstalledTreeAttestationSha256",
    "verifiedInstalledTreeReceiptSha256",
    "credentialIssuanceProofSha256",
    "credentialTokenSha256",
  ] as const) {
    assertSha256(command[field], field);
  }
  const credentialExpiresInSeconds = assertPositiveInteger(
    command.credentialExpiresInSeconds,
    "credentialExpiresInSeconds",
    REMOTE_WORKER_MAX_CREDENTIAL_TTL_SECONDS,
  );
  return Object.freeze({
    ...command,
    expectedRegistryWorkspaceId: assertIdentifier(
      command.expectedRegistryWorkspaceId,
      "expectedRegistryWorkspaceId",
      256,
    ),
    expectedBootstrapId: assertIdentifier(command.expectedBootstrapId, "expectedBootstrapId", 256),
    expectedTargetWorkerGeneration: assertPositiveInteger(
      command.expectedTargetWorkerGeneration,
      "expectedTargetWorkerGeneration",
    ),
    credentialExpiresInSeconds,
    exchangeIdempotencyKey: assertIdentifier(command.exchangeIdempotencyKey, "exchangeIdempotencyKey", 512),
  });
}

export function normalizeRotateRemoteWorkerRuntimeCredentialCommand(
  command: RotateRemoteWorkerRuntimeCredentialCommand,
): RotateRemoteWorkerRuntimeCredentialCommand {
  assertRecord(command, "trusted credential rotation command");
  assertExactKeys(
    command,
    [
      "registryWorkspaceId",
      "workerId",
      "workerGeneration",
      "expectedCredentialId",
      "expectedCredentialGeneration",
      "verifiedTransportReceiptSha256",
      "verifiedProofOfPossessionReceiptSha256",
      "credentialIssuanceProofSha256",
      "expiresInSeconds",
      "credentialTokenSha256",
      "idempotencyKey",
    ],
    "trusted credential rotation command",
  );
  for (const field of [
    "verifiedTransportReceiptSha256",
    "verifiedProofOfPossessionReceiptSha256",
    "credentialIssuanceProofSha256",
    "credentialTokenSha256",
  ] as const) {
    assertSha256(command[field], field);
  }
  return Object.freeze({
    ...command,
    registryWorkspaceId: assertIdentifier(command.registryWorkspaceId, "registryWorkspaceId", 256),
    workerId: assertIdentifier(command.workerId, "workerId", 256),
    workerGeneration: assertPositiveInteger(command.workerGeneration, "workerGeneration"),
    expectedCredentialId: assertIdentifier(command.expectedCredentialId, "expectedCredentialId", 256),
    expectedCredentialGeneration: assertPositiveInteger(
      command.expectedCredentialGeneration,
      "expectedCredentialGeneration",
    ),
    expiresInSeconds: assertPositiveInteger(
      command.expiresInSeconds,
      "expiresInSeconds",
      REMOTE_WORKER_MAX_CREDENTIAL_TTL_SECONDS,
    ),
    idempotencyKey: assertIdentifier(command.idempotencyKey, "idempotencyKey", 512),
  });
}

export function remoteWorkerBootstrapReplayMaterial(command: CreateRemoteWorkerBootstrapCommand): object {
  const normalized = normalizeCreateRemoteWorkerBootstrapCommand(command);
  return Object.freeze({
    registryWorkspaceId: normalized.registryWorkspaceId,
    existingWorkerId: normalized.existingWorkerId ?? null,
    workerLabel: normalized.workerLabel,
    platform: normalized.platform,
    architecture: normalized.architecture,
    runtimeManifest: normalized.runtimeManifest,
    allowedWorkspaceIds: normalized.allowedWorkspaceIds,
    capabilityClasses: normalized.capabilityClasses,
    expiresInSeconds: normalized.expiresInSeconds,
    createdByActorId: normalized.createdByActorId,
    idempotencyKey: normalized.idempotencyKey,
  });
}

export function remoteWorkerBootstrapAdmissionReplayMaterial(
  command: FinalizeRemoteWorkerBootstrapAdmissionCommand,
  bootstrapId: string,
  claims: RemoteWorkerRuntimeCredentialClaims,
): object {
  const normalized = normalizeFinalizeRemoteWorkerBootstrapAdmissionCommand(command);
  assertRemoteWorkerRuntimeCredentialClaims(claims);
  return Object.freeze({
    bootstrapId: assertIdentifier(bootstrapId, "bootstrapId", 256),
    expectedRegistryWorkspaceId: normalized.expectedRegistryWorkspaceId,
    expectedBootstrapId: normalized.expectedBootstrapId,
    expectedTargetWorkerGeneration: normalized.expectedTargetWorkerGeneration,
    verifiedPublicKeySpkiSha256: normalized.verifiedPublicKeySpkiSha256,
    verifiedClientCertificateSha256: normalized.verifiedClientCertificateSha256,
    verifiedRuntimeManifestSha256: normalized.verifiedRuntimeManifestSha256,
    verifiedWorkspaceCeilingSha256: normalized.verifiedWorkspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: normalized.verifiedCapabilityCeilingSha256,
    verifiedTransportIdentitySource: normalized.verifiedTransportIdentitySource,
    verifiedTransportTrustAnchorSha256: normalized.verifiedTransportTrustAnchorSha256,
    verifiedTransportReceiptSha256: normalized.verifiedTransportReceiptSha256,
    verifiedProofOfPossessionReceiptSha256: normalized.verifiedProofOfPossessionReceiptSha256,
    verifiedDownloadReceiptSha256: normalized.verifiedDownloadReceiptSha256,
    verifiedInstalledTreeAttestationSha256: normalized.verifiedInstalledTreeAttestationSha256,
    verifiedInstalledTreeReceiptSha256: normalized.verifiedInstalledTreeReceiptSha256,
    claims: freezeRemoteWorkerRuntimeCredentialClaims(claims),
    credentialIssuanceProofSha256: normalized.credentialIssuanceProofSha256,
    credentialExpiresInSeconds: normalized.credentialExpiresInSeconds,
    exchangeIdempotencyKey: normalized.exchangeIdempotencyKey,
  });
}

export function remoteWorkerRuntimeCredentialRotationReplayMaterial(
  command: RotateRemoteWorkerRuntimeCredentialCommand,
  claims: RemoteWorkerRuntimeCredentialClaims,
): object {
  const normalized = normalizeRotateRemoteWorkerRuntimeCredentialCommand(command);
  assertRemoteWorkerRuntimeCredentialClaims(claims);
  return Object.freeze({
    registryWorkspaceId: normalized.registryWorkspaceId,
    workerId: normalized.workerId,
    workerGeneration: normalized.workerGeneration,
    expectedCredentialId: normalized.expectedCredentialId,
    expectedCredentialGeneration: normalized.expectedCredentialGeneration,
    verifiedTransportReceiptSha256: normalized.verifiedTransportReceiptSha256,
    verifiedProofOfPossessionReceiptSha256: normalized.verifiedProofOfPossessionReceiptSha256,
    claims: freezeRemoteWorkerRuntimeCredentialClaims(claims),
    credentialIssuanceProofSha256: normalized.credentialIssuanceProofSha256,
    expiresInSeconds: normalized.expiresInSeconds,
    idempotencyKey: normalized.idempotencyKey,
  });
}

export function buildRemoteWorkerRuntimeCredentialClaims(
  input: BuildRemoteWorkerRuntimeCredentialClaimsInput,
): RemoteWorkerRuntimeCredentialClaims {
  assertRecord(input, "credential claims derivation input");
  assertExactKeys(
    input,
    ["registryWorkspaceId", "workerId", "workerGeneration", "allowedWorkspaceIds", "capabilityClasses"],
    "credential claims derivation input",
  );
  const registryWorkspaceId = assertIdentifier(input.registryWorkspaceId, "registryWorkspaceId", 256);
  const allowedWorkspaceIds = normalizeSortedUniqueIdentifiers(
    input.allowedWorkspaceIds,
    "allowedWorkspaceIds",
    REMOTE_WORKER_MAX_ALLOWED_WORKSPACES,
  );
  if (!allowedWorkspaceIds.includes(registryWorkspaceId)) {
    throw new TypeError("Remote worker allowedWorkspaceIds must include registryWorkspaceId.");
  }
  const capabilityClasses = normalizeCapabilityClasses(input.capabilityClasses);
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_RUNTIME_CREDENTIAL_CLAIMS_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    purpose: REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE,
    routeAccessClass: REMOTE_WORKER_ROUTE_ACCESS_CLASS,
    registryWorkspaceId,
    workerId: assertIdentifier(input.workerId, "workerId", 256),
    workerGeneration: assertPositiveInteger(input.workerGeneration, "workerGeneration"),
    allowedWorkspaceIds: Object.freeze(allowedWorkspaceIds),
    workspaceCeilingSha256: sha256CanonicalJson(allowedWorkspaceIds),
    capabilityClasses: Object.freeze(capabilityClasses),
    capabilityCeilingSha256: sha256CanonicalJson(capabilityClasses),
  });
}

export function assertRemoteWorkerRuntimeCredentialClaims(
  claims: unknown,
): asserts claims is RemoteWorkerRuntimeCredentialClaims {
  assertRecord(claims, "runtime credential claims");
  assertExactKeys(
    claims,
    [
      "schemaVersion",
      "protocolVersion",
      "purpose",
      "routeAccessClass",
      "registryWorkspaceId",
      "workerId",
      "workerGeneration",
      "allowedWorkspaceIds",
      "workspaceCeilingSha256",
      "capabilityClasses",
      "capabilityCeilingSha256",
    ],
    "runtime credential claims",
  );
  if (claims.schemaVersion !== REMOTE_WORKER_RUNTIME_CREDENTIAL_CLAIMS_SCHEMA_VERSION) {
    throw new TypeError("Remote worker runtime credential claims schema version is unsupported.");
  }
  if (claims.protocolVersion !== REMOTE_WORKER_PROTOCOL_VERSION) {
    throw new TypeError("Remote worker runtime credential claims protocol version is unsupported.");
  }
  if (claims.purpose !== REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE) {
    throw new TypeError("Remote worker runtime credential claims purpose is unsupported.");
  }
  if (claims.routeAccessClass !== REMOTE_WORKER_ROUTE_ACCESS_CLASS) {
    throw new TypeError("Remote worker runtime credential claims route access class is unsupported.");
  }
  const registryWorkspaceId = assertIdentifier(claims.registryWorkspaceId, "registryWorkspaceId", 256);
  assertIdentifier(claims.workerId, "workerId", 256);
  assertPositiveInteger(claims.workerGeneration, "workerGeneration");
  const allowedWorkspaceIds = normalizeSortedUniqueIdentifiers(
    claims.allowedWorkspaceIds as readonly string[],
    "allowedWorkspaceIds",
    REMOTE_WORKER_MAX_ALLOWED_WORKSPACES,
  );
  if (!allowedWorkspaceIds.includes(registryWorkspaceId)) {
    throw new TypeError("Remote worker allowedWorkspaceIds must include registryWorkspaceId.");
  }
  assertSha256(claims.workspaceCeilingSha256, "workspaceCeilingSha256");
  if (claims.workspaceCeilingSha256 !== sha256CanonicalJson(allowedWorkspaceIds)) {
    throw new TypeError("Remote worker runtime credential claims workspace ceiling digest does not match.");
  }
  const capabilityClasses = normalizeCapabilityClasses(
    claims.capabilityClasses as readonly RemoteWorkerCapabilityClass[],
  );
  assertSha256(claims.capabilityCeilingSha256, "capabilityCeilingSha256");
  if (claims.capabilityCeilingSha256 !== sha256CanonicalJson(capabilityClasses)) {
    throw new TypeError("Remote worker runtime credential claims capability ceiling digest does not match.");
  }
}

export function remoteWorkerRuntimeCredentialClaimsSha256(claims: RemoteWorkerRuntimeCredentialClaims): string {
  assertRemoteWorkerRuntimeCredentialClaims(claims);
  return sha256CanonicalJson(claims);
}

export function evaluateRemoteWorkerRuntimeCredentialRoutePolicy(
  claims: unknown,
  request: unknown,
): RemoteWorkerRoutePolicyDecision {
  try {
    assertRemoteWorkerRuntimeCredentialClaims(claims);
  } catch {
    return remoteWorkerRoutePolicyDecision(false, "invalid_credential_claims");
  }
  if (!isRemoteWorkerRoutePolicyRequest(request)) {
    return remoteWorkerRoutePolicyDecision(false, "invalid_route_policy_request");
  }
  if (request.routeAccessClass !== REMOTE_WORKER_ROUTE_ACCESS_CLASS) {
    return remoteWorkerRoutePolicyDecision(false, "route_access_class_denied");
  }
  if (!claims.allowedWorkspaceIds.includes(request.workspaceId)) {
    return remoteWorkerRoutePolicyDecision(false, "workspace_ceiling_denied");
  }
  if (!request.requiredCapabilityClasses.every((item) => claims.capabilityClasses.includes(item))) {
    return remoteWorkerRoutePolicyDecision(false, "capability_ceiling_denied");
  }
  return remoteWorkerRoutePolicyDecision(true, "allowed_by_remote_worker_ceiling");
}

export function normalizeRemoteWorkerGenerationControlInput(
  input: RemoteWorkerGenerationControlInput,
): RemoteWorkerGenerationControlInput {
  assertRecord(input, "generation control input");
  assertExactKeys(
    input,
    ["registryWorkspaceId", "workerId", "workerGeneration", "reasonCode", "reasonSha256", "actorId", "idempotencyKey"],
    "generation control input",
  );
  assertSha256(input.reasonSha256, "reasonSha256");
  return {
    registryWorkspaceId: assertIdentifier(input.registryWorkspaceId, "registryWorkspaceId", 256),
    workerId: assertIdentifier(input.workerId, "workerId", 256),
    workerGeneration: assertPositiveInteger(input.workerGeneration, "workerGeneration"),
    reasonCode: assertReasonCode(input.reasonCode),
    reasonSha256: input.reasonSha256,
    actorId: assertIdentifier(input.actorId, "actorId", 256),
    idempotencyKey: assertIdentifier(input.idempotencyKey, "idempotencyKey", 512),
  };
}

export function assertRemoteWorkerBootstrapRecord(record: unknown): asserts record is RemoteWorkerBootstrapRecord {
  assertRecord(record, "bootstrap record");
  assertExactKeys(
    record,
    [
      "registryWorkspaceId",
      "bootstrapId",
      "workerId",
      "nodeId",
      "targetWorkerGeneration",
      "workerLabel",
      "platform",
      "architecture",
      "runtimeManifest",
      "allowedWorkspaceIds",
      "workspaceCeilingSha256",
      "capabilityClasses",
      "capabilityCeilingSha256",
      "state",
      "expiresAt",
      "createdByActorId",
      "idempotencyKey",
      "requestSha256",
      "createdAt",
    ],
    "bootstrap record",
  );
  assertIdentifier(record.registryWorkspaceId, "registryWorkspaceId", 256);
  assertIdentifier(record.bootstrapId, "bootstrapId", 256);
  assertIdentifier(record.workerId, "workerId", 256);
  assertIdentifier(record.nodeId, "nodeId", 256);
  assertPositiveInteger(record.targetWorkerGeneration, "targetWorkerGeneration");
  assertSafeText(record.workerLabel, "workerLabel", REMOTE_WORKER_MAX_LABEL_LENGTH);
  assertPlatform(record.platform, "platform");
  assertArchitecture(record.architecture, "architecture");
  assertRemoteWorkerRuntimeManifest(record.runtimeManifest);
  if (
    record.runtimeManifest.payload.platform !== record.platform ||
    record.runtimeManifest.payload.architecture !== record.architecture
  ) {
    throw new TypeError("Remote worker bootstrap record runtime target does not match its manifest.");
  }
  const allowedWorkspaceIds = normalizeSortedUniqueIdentifiers(
    record.allowedWorkspaceIds as string[],
    "allowedWorkspaceIds",
    REMOTE_WORKER_MAX_ALLOWED_WORKSPACES,
  );
  if (!allowedWorkspaceIds.includes(record.registryWorkspaceId as string)) {
    throw new TypeError("Remote worker allowedWorkspaceIds must include registryWorkspaceId.");
  }
  assertSha256(record.workspaceCeilingSha256, "workspaceCeilingSha256");
  if (record.workspaceCeilingSha256 !== sha256CanonicalJson(allowedWorkspaceIds)) {
    throw new TypeError("Remote worker bootstrap record workspace ceiling digest does not match.");
  }
  const capabilityClasses = normalizeCapabilityClasses(record.capabilityClasses as RemoteWorkerCapabilityClass[]);
  assertSha256(record.capabilityCeilingSha256, "capabilityCeilingSha256");
  if (record.capabilityCeilingSha256 !== sha256CanonicalJson(capabilityClasses)) {
    throw new TypeError("Remote worker bootstrap record capability ceiling digest does not match.");
  }
  assertEnum(record.state, ["pending", "consumed", "expired"], "state");
  assertIsoTimestamp(record.expiresAt, "expiresAt");
  assertIdentifier(record.createdByActorId, "createdByActorId", 256);
  assertIdentifier(record.idempotencyKey, "idempotencyKey", 512);
  assertSha256(record.requestSha256, "requestSha256");
  assertIsoTimestamp(record.createdAt, "createdAt");
}

export function assertRemoteWorkerGenerationRecord(record: unknown): asserts record is RemoteWorkerGenerationRecord {
  assertRecord(record, "worker generation record");
  assertExactKeys(
    record,
    [
      "registryWorkspaceId",
      "workerId",
      "nodeId",
      "workerGeneration",
      "bootstrapId",
      "publicKeySpkiSha256",
      "clientCertificateSha256",
      "runtimeManifestSha256",
      "workspaceCeilingSha256",
      "capabilityCeilingSha256",
      "transportIdentitySource",
      "transportTrustAnchorSha256",
      "transportVerificationReceiptSha256",
      "proofOfPossessionReceiptSha256",
      "downloadVerificationReceiptSha256",
      "installedTreeAttestationSha256",
      "installedTreeVerificationReceiptSha256",
      "exchangeIdempotencyKey",
      "exchangeRequestSha256",
      "admittedAt",
    ],
    "worker generation record",
  );
  for (const field of ["registryWorkspaceId", "workerId", "nodeId", "bootstrapId"] as const) {
    assertIdentifier(record[field], field, 256);
  }
  assertPositiveInteger(record.workerGeneration, "workerGeneration");
  for (const field of [
    "publicKeySpkiSha256",
    "clientCertificateSha256",
    "runtimeManifestSha256",
    "workspaceCeilingSha256",
    "capabilityCeilingSha256",
    "transportTrustAnchorSha256",
    "transportVerificationReceiptSha256",
    "proofOfPossessionReceiptSha256",
    "downloadVerificationReceiptSha256",
    "installedTreeAttestationSha256",
    "installedTreeVerificationReceiptSha256",
    "exchangeRequestSha256",
  ] as const) {
    assertSha256(record[field], field);
  }
  assertEnum(record.transportIdentitySource, ["native_mtls", "trusted_terminator"], "transportIdentitySource");
  assertIdentifier(record.exchangeIdempotencyKey, "exchangeIdempotencyKey", 512);
  assertIsoTimestamp(record.admittedAt, "admittedAt");
}

export function assertRemoteWorkerRuntimeCredentialRecord(
  record: unknown,
): asserts record is RemoteWorkerRuntimeCredentialRecord {
  assertRecord(record, "runtime credential record");
  assertExactKeys(
    record,
    [
      "registryWorkspaceId",
      "workerId",
      "workerGeneration",
      "credentialGeneration",
      "credentialId",
      "purpose",
      "claims",
      "claimsSha256",
      "issuanceProofSha256",
      "idempotencyKey",
      "requestSha256",
      "issuedAt",
      "expiresAt",
    ],
    "runtime credential record",
  );
  assertIdentifier(record.registryWorkspaceId, "registryWorkspaceId", 256);
  assertIdentifier(record.workerId, "workerId", 256);
  assertPositiveInteger(record.workerGeneration, "workerGeneration");
  assertPositiveInteger(record.credentialGeneration, "credentialGeneration");
  assertIdentifier(record.credentialId, "credentialId", 256);
  if (record.purpose !== REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE) {
    throw new TypeError("Remote worker credential purpose is unsupported.");
  }
  assertRemoteWorkerRuntimeCredentialClaims(record.claims);
  if (
    record.claims.registryWorkspaceId !== record.registryWorkspaceId ||
    record.claims.workerId !== record.workerId ||
    record.claims.workerGeneration !== record.workerGeneration ||
    record.claims.purpose !== record.purpose
  ) {
    throw new TypeError("Remote worker credential record metadata does not match its claims envelope.");
  }
  for (const field of ["claimsSha256", "issuanceProofSha256", "requestSha256"] as const) {
    assertSha256(record[field], field);
  }
  if (record.claimsSha256 !== remoteWorkerRuntimeCredentialClaimsSha256(record.claims)) {
    throw new TypeError("Remote worker credential record claims digest does not match its canonical claims bytes.");
  }
  assertIdentifier(record.idempotencyKey, "idempotencyKey", 512);
  assertIsoTimestamp(record.issuedAt, "issuedAt");
  assertIsoTimestamp(record.expiresAt, "expiresAt");
}

export function assertRemoteWorkerGenerationControlRecord(
  record: unknown,
): asserts record is RemoteWorkerGenerationControlRecord {
  assertRecord(record, "generation control record");
  assertExactKeys(
    record,
    [
      "registryWorkspaceId",
      "workerId",
      "workerGeneration",
      "controlRevision",
      "action",
      "reasonCode",
      "reasonSha256",
      "actorId",
      "idempotencyKey",
      "requestSha256",
      "createdAt",
    ],
    "generation control record",
  );
  assertIdentifier(record.registryWorkspaceId, "registryWorkspaceId", 256);
  assertIdentifier(record.workerId, "workerId", 256);
  assertPositiveInteger(record.workerGeneration, "workerGeneration");
  assertPositiveInteger(record.controlRevision, "controlRevision", 2);
  assertEnum(record.action, ["quarantine", "revoke"], "action");
  assertReasonCode(record.reasonCode);
  assertSha256(record.reasonSha256, "reasonSha256");
  assertIdentifier(record.actorId, "actorId", 256);
  assertIdentifier(record.idempotencyKey, "idempotencyKey", 512);
  assertSha256(record.requestSha256, "requestSha256");
  assertIsoTimestamp(record.createdAt, "createdAt");
}

function normalizeCapabilityClasses(value: readonly RemoteWorkerCapabilityClass[]): RemoteWorkerCapabilityClass[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > REMOTE_WORKER_MAX_CAPABILITY_CLASSES) {
    throw new TypeError("Remote worker capabilityClasses must contain between 1 and 9 values.");
  }
  const result = value.map((item) => {
    assertEnum(item, REMOTE_WORKER_CAPABILITY_CLASSES, "capabilityClasses");
    return item;
  });
  assertStrictlySortedUnique(result, "capabilityClasses");
  return [...result];
}

function normalizeSortedUniqueIdentifiers(value: readonly string[], field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) {
    throw new TypeError(`Remote worker ${field} must contain between 1 and ${maxItems} values.`);
  }
  const result = value.map((item) => assertIdentifier(item, field, 256));
  assertStrictlySortedUnique(result, field);
  return result;
}

function assertStrictlySortedUnique(value: string[], field: string): void {
  for (let index = 1; index < value.length; index += 1) {
    if (compareRemoteWorkerCanonicalIdentifiers(value[index - 1]!, value[index]!) >= 0) {
      throw new TypeError(`Remote worker ${field} must be sorted and unique by exact value.`);
    }
  }
}

function isRemoteWorkerRoutePolicyRequest(value: unknown): value is RemoteWorkerRoutePolicyRequest {
  try {
    assertRecord(value, "route policy request");
    assertExactKeys(value, ["routeAccessClass", "workspaceId", "requiredCapabilityClasses"], "route policy request");
    if (typeof value.routeAccessClass !== "string") return false;
    assertIdentifier(value.workspaceId, "workspaceId", 256);
    normalizeCapabilityClasses(value.requiredCapabilityClasses as readonly RemoteWorkerCapabilityClass[]);
    return true;
  } catch {
    return false;
  }
}

function remoteWorkerRoutePolicyDecision(
  allowed: boolean,
  reasonCode: RemoteWorkerRoutePolicyReasonCode,
): RemoteWorkerRoutePolicyDecision {
  return Object.freeze({ allowed, reasonCode, capabilityActivationGranted: false });
}

function freezeRemoteWorkerRuntimeManifest(manifest: RemoteWorkerRuntimeManifest): RemoteWorkerRuntimeManifest {
  return Object.freeze({
    payload: Object.freeze({ ...manifest.payload }),
    payloadSha256: manifest.payloadSha256,
    signatureAlgorithm: manifest.signatureAlgorithm,
    signerKeyId: manifest.signerKeyId,
    signatureBase64Url: manifest.signatureBase64Url,
  });
}

function freezeRemoteWorkerRuntimeCredentialClaims(
  claims: RemoteWorkerRuntimeCredentialClaims,
): RemoteWorkerRuntimeCredentialClaims {
  return Object.freeze({
    ...claims,
    allowedWorkspaceIds: Object.freeze([...claims.allowedWorkspaceIds]),
    capabilityClasses: Object.freeze([...claims.capabilityClasses]),
  });
}

function assertPlatform(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:windows|linux|darwin)$/u.test(value)) {
    throw new TypeError(`Remote worker ${field} is unsupported.`);
  }
  return value;
}

function assertArchitecture(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:x64|arm64)$/u.test(value)) {
    throw new TypeError(`Remote worker ${field} is unsupported.`);
  }
  return value;
}

function assertReasonCode(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(value)) {
    throw new TypeError("Remote worker reasonCode must be a canonical content-free code.");
  }
  return value;
}

function assertEd25519Signature(value: unknown): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{85}[AQgw]$/u.test(value)) {
    throw new TypeError("Remote worker runtime manifest signature must be canonical unpadded base64url Ed25519 bytes.");
  }
}

function assertIdentifier(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`Remote worker ${field} is not a canonical identifier.`);
  }
  return value;
}

function assertSafeText(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`Remote worker ${field} is invalid.`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`Remote worker ${field} must be a positive safe integer no greater than ${max}.`);
  }
  return value;
}

function assertSha256(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`Remote worker ${field} must be a lower-case SHA-256 digest.`);
  }
}

function assertIsoTimestamp(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError(`Remote worker ${field} must be a UTC ISO timestamp.`);
  }
}

function assertEnum<T extends string>(value: unknown, values: readonly T[], field: string): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new TypeError(`Remote worker ${field} is unsupported.`);
  }
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Remote worker ${field} must be an object.`);
  }
}

function assertExactKeys(value: object, allowed: string[], field: string, optional: string[] = []): void {
  const keys = Object.keys(value);
  const allowedSet = new Set(allowed);
  for (const key of keys) {
    if (!allowedSet.has(key)) throw new TypeError(`Remote worker ${field} contains unknown fields.`);
  }
  const optionalSet = new Set(optional);
  for (const key of allowed) {
    if (!optionalSet.has(key) && !Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`Remote worker ${field} is missing required field ${key}.`);
    }
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

function sha256CanonicalJson(value: unknown): string {
  return sha256Utf8(canonicalJsonString(value));
}

function sha256Utf8(value: string): string {
  const source = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((source.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(source);
  padded[source.byteLength] = 0x80;
  const bitLength = source.byteLength * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choose + SHA256_ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}
