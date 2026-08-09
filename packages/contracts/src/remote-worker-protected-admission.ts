import { canonicalJsonString } from "./canonical-json.js";
import { sha256BytesHex, sha256Hex } from "./sha256.js";

export const REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION =
  "goatcitadel.remote-worker-protected-admission-signer-pin.v1" as const;
export const REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION =
  "goatcitadel.remote-worker-protected-admission-evidence-wire.v1" as const;
export const REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION =
  "goatcitadel.remote-worker-protected-admission-signer-result.v1" as const;
export const REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION =
  "goatcitadel.remote-worker-protected-admission-evidence.v1" as const;
export const REMOTE_WORKER_PROTECTED_ADMISSION_CONTEXT_SCHEMA_VERSION =
  "goatcitadel.remote-worker-protected-admission-context.v1" as const;
export const REMOTE_WORKER_PROTECTED_ADMISSION_REMOTE_CALLER_BINDING_SCHEMA_VERSION =
  "goatcitadel.remote-worker-protected-admission-remote-caller-binding.v1" as const;
export const REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_DOMAIN =
  "goatcitadel.remote-worker.provisioning-evidence.signature.v1" as const;

export const REMOTE_WORKER_PROTECTED_ADMISSION_ENVELOPE_BYTES = 288;
export const REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_SPKI_BYTES = 44;
export const REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_BYTES = 64;
export const REMOTE_WORKER_PROTECTED_ADMISSION_OPERATION_ID_BYTES = 16;

export interface RemoteWorkerProtectedAdmissionSignerPin {
  readonly schemaVersion: typeof REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION;
  readonly signatureAlgorithm: "ed25519";
  readonly keysetGeneration: number;
  readonly keysetReceiptSha256: string;
  readonly signerSpkiSha256: string;
  readonly signerSpkiBase64Url: string;
}

export interface RemoteWorkerProtectedAdmissionSignerResult {
  readonly schemaVersion: typeof REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION;
  readonly disposition: "signed" | "exact_replay";
  readonly operationIdBase64Url: string;
  readonly workerGeneration: number;
  readonly envelopeSha256: string;
  readonly keysetReceiptSha256: string;
  readonly signerSpkiSha256: string;
  readonly signerSpkiBase64Url: string;
  readonly signatureBase64Url: string;
  /** Unsigned native-protocol diagnostic; never part of Gateway admission authority. */
  readonly protectedStateSha256: string;
  /** Unsigned native-protocol diagnostic; never part of Gateway admission authority. */
  readonly requestSha256: string;
}

export interface RemoteWorkerProtectedAdmissionEvidenceWire {
  readonly schemaVersion: typeof REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION;
  readonly envelopeBase64Url: string;
  readonly signerResult: RemoteWorkerProtectedAdmissionSignerResult;
}

/**
 * Secret-free evidence verified by the Gateway before durable settlement.
 * The protected signature authorizes these exact bindings under the pinned
 * keyset. It is not an independent rescan of the installed tree.
 *
 * The native service authenticates the local Windows caller and fences exact
 * replay by SID, but v1 does not export a signed SID digest. Consequently this
 * authority makes no claim about the local signer caller. The explicit caller
 * binding below is only the remote mTLS/PoP connection authenticated by the
 * Gateway. Possession of the pinned protected signing key is the signer-side
 * authority visible to the Gateway.
 */
export interface RemoteWorkerVerifiedProtectedAdmissionEvidence {
  readonly schemaVersion: typeof REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION;
  readonly operationIdBase64Url: string;
  readonly evidenceNonceSha256: string;
  readonly workerGeneration: number;
  readonly envelopeSha256: string;
  readonly envelopeBase64Url: string;
  readonly keysetReceiptSha256: string;
  readonly signerSpkiSha256: string;
  readonly signerSpkiBase64Url: string;
  readonly signatureBase64Url: string;
  readonly contextSha256: string;
  readonly runtimeManifestSha256: string;
  readonly runtimeManifestPayloadSha256: string;
  readonly workspaceCeilingSha256: string;
  readonly capabilityCeilingSha256: string;
  readonly workerPublicKeySpkiSha256: string;
  readonly workerPublicKeySpkiBase64Url: string;
  readonly clientCertificateSha256: string;
  readonly transportTrustAnchorSha256: string;
  readonly tlsExporterSha256: string;
  /** Authenticated remote mTLS/PoP caller; never the local Windows signer SID. */
  readonly authenticatedRemoteCallerBindingSha256: string;
  readonly downloadVerificationReceiptSha256: string;
  readonly installedTreeAttestationSha256: string;
  readonly installedTreeVerificationReceiptSha256: string;
}

export interface RemoteWorkerProtectedAdmissionEvidenceRecord extends RemoteWorkerVerifiedProtectedAdmissionEvidence {
  readonly registryWorkspaceId: string;
  readonly bootstrapId: string;
  readonly workerId: string;
  readonly authenticatedOperatorActorId: string;
  readonly authenticatedOperatorActorSha256: string;
  readonly admittedAt: string;
  readonly revokedAt?: string;
}

export interface RemoteWorkerProtectedAdmissionContextInput {
  readonly registryWorkspaceId: string;
  readonly bootstrapId: string;
  readonly workerId: string;
  readonly nodeId: string;
  readonly targetWorkerGeneration: number;
  readonly platform: string;
  readonly architecture: string;
  readonly runtimeManifestSha256: string;
  readonly runtimeManifestPayloadSha256: string;
  readonly workspaceCeilingSha256: string;
  readonly capabilityCeilingSha256: string;
  readonly workerPublicKeySpkiSha256: string;
  readonly clientCertificateSha256: string;
  readonly transportTrustAnchorSha256: string;
  readonly tlsExporterSha256: string;
  readonly evidenceNonceSha256: string;
  readonly downloadVerificationReceiptSha256: string;
  readonly installedTreeAttestationSha256: string;
  readonly installedTreeVerificationReceiptSha256: string;
}

export interface RemoteWorkerProtectedAdmissionRemoteCallerBindingInput {
  readonly workerPublicKeySpkiSha256: string;
  readonly clientCertificateSha256: string;
  readonly transportTrustAnchorSha256: string;
  readonly tlsExporterSha256: string;
}

export function normalizeRemoteWorkerProtectedAdmissionSignerPin(
  value: unknown,
): RemoteWorkerProtectedAdmissionSignerPin {
  const fields = exactDataFields(
    value,
    [
      "schemaVersion",
      "signatureAlgorithm",
      "keysetGeneration",
      "keysetReceiptSha256",
      "signerSpkiSha256",
      "signerSpkiBase64Url",
    ],
    "protected admission signer pin",
  );
  if (
    fields.schemaVersion !== REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION ||
    fields.signatureAlgorithm !== "ed25519"
  ) {
    throw invalid("protected admission signer pin");
  }
  const signerSpkiSha256 = sha256(fields.signerSpkiSha256, "signer SPKI");
  const signerSpkiBase64Url = canonicalBase64Url(
    fields.signerSpkiBase64Url,
    REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_SPKI_BYTES,
    "signer SPKI",
  );
  assertCanonicalEd25519SpkiBinding(signerSpkiBase64Url, signerSpkiSha256, "signer SPKI");
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
    signatureAlgorithm: "ed25519",
    keysetGeneration: positiveInteger(fields.keysetGeneration, "keyset generation"),
    keysetReceiptSha256: nonzeroSha256(fields.keysetReceiptSha256, "keyset receipt"),
    signerSpkiSha256,
    signerSpkiBase64Url,
  });
}

export function normalizeRemoteWorkerProtectedAdmissionEvidenceWire(
  value: unknown,
): RemoteWorkerProtectedAdmissionEvidenceWire {
  const fields = exactDataFields(
    value,
    ["schemaVersion", "envelopeBase64Url", "signerResult"],
    "protected admission evidence wire value",
  );
  if (fields.schemaVersion !== REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION) {
    throw invalid("protected admission evidence wire value");
  }
  const resultFields = exactDataFields(
    fields.signerResult,
    [
      "schemaVersion",
      "disposition",
      "operationIdBase64Url",
      "workerGeneration",
      "envelopeSha256",
      "keysetReceiptSha256",
      "signerSpkiSha256",
      "signerSpkiBase64Url",
      "signatureBase64Url",
      "protectedStateSha256",
      "requestSha256",
    ],
    "protected admission signer result",
  );
  if (
    resultFields.schemaVersion !== REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION ||
    (resultFields.disposition !== "signed" && resultFields.disposition !== "exact_replay")
  ) {
    throw invalid("protected admission signer result");
  }
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION,
    envelopeBase64Url: canonicalBase64Url(
      fields.envelopeBase64Url,
      REMOTE_WORKER_PROTECTED_ADMISSION_ENVELOPE_BYTES,
      "protected admission envelope",
    ),
    signerResult: Object.freeze({
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION,
      disposition: resultFields.disposition,
      operationIdBase64Url: canonicalBase64Url(
        resultFields.operationIdBase64Url,
        REMOTE_WORKER_PROTECTED_ADMISSION_OPERATION_ID_BYTES,
        "protected admission operation ID",
      ),
      workerGeneration: positiveInteger(resultFields.workerGeneration, "worker generation"),
      envelopeSha256: sha256(resultFields.envelopeSha256, "envelope"),
      keysetReceiptSha256: nonzeroSha256(resultFields.keysetReceiptSha256, "keyset receipt"),
      signerSpkiSha256: sha256(resultFields.signerSpkiSha256, "signer SPKI"),
      signerSpkiBase64Url: canonicalBase64Url(
        resultFields.signerSpkiBase64Url,
        REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_SPKI_BYTES,
        "signer SPKI",
      ),
      signatureBase64Url: canonicalBase64Url(
        resultFields.signatureBase64Url,
        REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_BYTES,
        "protected admission signature",
      ),
      protectedStateSha256: nonzeroSha256(resultFields.protectedStateSha256, "protected state"),
      requestSha256: nonzeroSha256(resultFields.requestSha256, "protected signer request"),
    }),
  });
}

export function normalizeRemoteWorkerVerifiedProtectedAdmissionEvidence(
  value: unknown,
): RemoteWorkerVerifiedProtectedAdmissionEvidence {
  const fields = exactDataFields(
    value,
    [
      "schemaVersion",
      "operationIdBase64Url",
      "evidenceNonceSha256",
      "workerGeneration",
      "envelopeSha256",
      "envelopeBase64Url",
      "keysetReceiptSha256",
      "signerSpkiSha256",
      "signerSpkiBase64Url",
      "signatureBase64Url",
      "contextSha256",
      "runtimeManifestSha256",
      "runtimeManifestPayloadSha256",
      "workspaceCeilingSha256",
      "capabilityCeilingSha256",
      "workerPublicKeySpkiSha256",
      "workerPublicKeySpkiBase64Url",
      "clientCertificateSha256",
      "transportTrustAnchorSha256",
      "tlsExporterSha256",
      "authenticatedRemoteCallerBindingSha256",
      "downloadVerificationReceiptSha256",
      "installedTreeAttestationSha256",
      "installedTreeVerificationReceiptSha256",
    ],
    "verified protected admission evidence",
  );
  if (fields.schemaVersion !== REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION) {
    throw invalid("verified protected admission evidence");
  }
  const workerPublicKeySpkiSha256 = sha256(fields.workerPublicKeySpkiSha256, "worker public key");
  const workerPublicKeySpkiBase64Url = canonicalBase64Url(
    fields.workerPublicKeySpkiBase64Url,
    REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_SPKI_BYTES,
    "worker public key",
  );
  assertCanonicalEd25519SpkiBinding(workerPublicKeySpkiBase64Url, workerPublicKeySpkiSha256, "worker public key");
  const normalized: RemoteWorkerVerifiedProtectedAdmissionEvidence = Object.freeze({
    schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION,
    operationIdBase64Url: canonicalBase64Url(
      fields.operationIdBase64Url,
      REMOTE_WORKER_PROTECTED_ADMISSION_OPERATION_ID_BYTES,
      "protected admission operation ID",
    ),
    evidenceNonceSha256: sha256(fields.evidenceNonceSha256, "evidence nonce"),
    workerGeneration: positiveInteger(fields.workerGeneration, "worker generation"),
    envelopeSha256: sha256(fields.envelopeSha256, "envelope"),
    envelopeBase64Url: canonicalBase64Url(
      fields.envelopeBase64Url,
      REMOTE_WORKER_PROTECTED_ADMISSION_ENVELOPE_BYTES,
      "protected admission envelope",
    ),
    keysetReceiptSha256: sha256(fields.keysetReceiptSha256, "keyset receipt"),
    signerSpkiSha256: sha256(fields.signerSpkiSha256, "signer SPKI"),
    signerSpkiBase64Url: canonicalBase64Url(
      fields.signerSpkiBase64Url,
      REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_SPKI_BYTES,
      "signer SPKI",
    ),
    signatureBase64Url: canonicalBase64Url(
      fields.signatureBase64Url,
      REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_BYTES,
      "protected admission signature",
    ),
    contextSha256: sha256(fields.contextSha256, "protected admission context"),
    runtimeManifestSha256: sha256(fields.runtimeManifestSha256, "runtime manifest"),
    runtimeManifestPayloadSha256: sha256(fields.runtimeManifestPayloadSha256, "runtime manifest payload"),
    workspaceCeilingSha256: sha256(fields.workspaceCeilingSha256, "workspace ceiling"),
    capabilityCeilingSha256: sha256(fields.capabilityCeilingSha256, "capability ceiling"),
    workerPublicKeySpkiSha256,
    workerPublicKeySpkiBase64Url,
    clientCertificateSha256: sha256(fields.clientCertificateSha256, "client certificate"),
    transportTrustAnchorSha256: sha256(fields.transportTrustAnchorSha256, "transport trust anchor"),
    tlsExporterSha256: sha256(fields.tlsExporterSha256, "TLS exporter"),
    authenticatedRemoteCallerBindingSha256: sha256(
      fields.authenticatedRemoteCallerBindingSha256,
      "authenticated remote caller binding",
    ),
    downloadVerificationReceiptSha256: sha256(fields.downloadVerificationReceiptSha256, "download receipt"),
    installedTreeAttestationSha256: sha256(fields.installedTreeAttestationSha256, "installed-tree attestation"),
    installedTreeVerificationReceiptSha256: sha256(
      fields.installedTreeVerificationReceiptSha256,
      "installed-tree verification receipt",
    ),
  });
  if (
    normalized.authenticatedRemoteCallerBindingSha256 !==
    remoteWorkerProtectedAdmissionRemoteCallerBindingSha256({
      workerPublicKeySpkiSha256: normalized.workerPublicKeySpkiSha256,
      clientCertificateSha256: normalized.clientCertificateSha256,
      transportTrustAnchorSha256: normalized.transportTrustAnchorSha256,
      tlsExporterSha256: normalized.tlsExporterSha256,
    })
  ) {
    throw invalid("verified protected admission evidence");
  }
  return normalized;
}

export function assertRemoteWorkerProtectedAdmissionEvidenceRecord(
  value: unknown,
): asserts value is RemoteWorkerProtectedAdmissionEvidenceRecord {
  const fields = exactDataFields(
    value,
    [
      "schemaVersion",
      "operationIdBase64Url",
      "evidenceNonceSha256",
      "workerGeneration",
      "envelopeSha256",
      "envelopeBase64Url",
      "keysetReceiptSha256",
      "signerSpkiSha256",
      "signerSpkiBase64Url",
      "signatureBase64Url",
      "contextSha256",
      "runtimeManifestSha256",
      "runtimeManifestPayloadSha256",
      "workspaceCeilingSha256",
      "capabilityCeilingSha256",
      "workerPublicKeySpkiSha256",
      "workerPublicKeySpkiBase64Url",
      "clientCertificateSha256",
      "transportTrustAnchorSha256",
      "tlsExporterSha256",
      "authenticatedRemoteCallerBindingSha256",
      "downloadVerificationReceiptSha256",
      "installedTreeAttestationSha256",
      "installedTreeVerificationReceiptSha256",
      "registryWorkspaceId",
      "bootstrapId",
      "workerId",
      "authenticatedOperatorActorId",
      "authenticatedOperatorActorSha256",
      "admittedAt",
    ],
    "protected admission evidence record",
    ["revokedAt"],
  );
  normalizeRemoteWorkerVerifiedProtectedAdmissionEvidence(
    Object.freeze({
      schemaVersion: fields.schemaVersion,
      operationIdBase64Url: fields.operationIdBase64Url,
      evidenceNonceSha256: fields.evidenceNonceSha256,
      workerGeneration: fields.workerGeneration,
      envelopeSha256: fields.envelopeSha256,
      envelopeBase64Url: fields.envelopeBase64Url,
      keysetReceiptSha256: fields.keysetReceiptSha256,
      signerSpkiSha256: fields.signerSpkiSha256,
      signerSpkiBase64Url: fields.signerSpkiBase64Url,
      signatureBase64Url: fields.signatureBase64Url,
      contextSha256: fields.contextSha256,
      runtimeManifestSha256: fields.runtimeManifestSha256,
      runtimeManifestPayloadSha256: fields.runtimeManifestPayloadSha256,
      workspaceCeilingSha256: fields.workspaceCeilingSha256,
      capabilityCeilingSha256: fields.capabilityCeilingSha256,
      workerPublicKeySpkiSha256: fields.workerPublicKeySpkiSha256,
      workerPublicKeySpkiBase64Url: fields.workerPublicKeySpkiBase64Url,
      clientCertificateSha256: fields.clientCertificateSha256,
      transportTrustAnchorSha256: fields.transportTrustAnchorSha256,
      tlsExporterSha256: fields.tlsExporterSha256,
      authenticatedRemoteCallerBindingSha256: fields.authenticatedRemoteCallerBindingSha256,
      downloadVerificationReceiptSha256: fields.downloadVerificationReceiptSha256,
      installedTreeAttestationSha256: fields.installedTreeAttestationSha256,
      installedTreeVerificationReceiptSha256: fields.installedTreeVerificationReceiptSha256,
    }),
  );
  identifier(fields.registryWorkspaceId, "registry workspace ID");
  identifier(fields.bootstrapId, "bootstrap ID");
  identifier(fields.workerId, "worker ID");
  const actorId = identifier(fields.authenticatedOperatorActorId, "authenticated operator actor ID");
  if (sha256(fields.authenticatedOperatorActorSha256, "authenticated operator actor") !== sha256Hex(actorId)) {
    throw invalid("protected admission evidence record");
  }
  canonicalTimestamp(fields.admittedAt, "admitted timestamp");
  if (fields.revokedAt !== undefined) canonicalTimestamp(fields.revokedAt, "revoked timestamp");
}

export function remoteWorkerProtectedAdmissionContextSha256(input: RemoteWorkerProtectedAdmissionContextInput): string {
  const normalized = normalizeContextInput(input);
  return sha256Hex(
    canonicalJsonString({
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_CONTEXT_SCHEMA_VERSION,
      ...normalized,
    }),
  );
}

export function remoteWorkerAuthenticatedOperatorActorSha256(actorId: string): string {
  return sha256Hex(identifier(actorId, "authenticated operator actor ID"));
}

export function remoteWorkerProtectedAdmissionRemoteCallerBindingSha256(
  input: RemoteWorkerProtectedAdmissionRemoteCallerBindingInput,
): string {
  const fields = exactDataFields(
    input,
    ["workerPublicKeySpkiSha256", "clientCertificateSha256", "transportTrustAnchorSha256", "tlsExporterSha256"],
    "protected admission caller binding",
  );
  return sha256Hex(
    canonicalJsonString({
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_REMOTE_CALLER_BINDING_SCHEMA_VERSION,
      workerPublicKeySpkiSha256: sha256(fields.workerPublicKeySpkiSha256, "worker public key"),
      clientCertificateSha256: sha256(fields.clientCertificateSha256, "client certificate"),
      transportTrustAnchorSha256: sha256(fields.transportTrustAnchorSha256, "transport trust anchor"),
      tlsExporterSha256: sha256(fields.tlsExporterSha256, "TLS exporter"),
    }),
  );
}

function normalizeContextInput(
  input: RemoteWorkerProtectedAdmissionContextInput,
): RemoteWorkerProtectedAdmissionContextInput {
  const fields = exactDataFields(
    input,
    [
      "registryWorkspaceId",
      "bootstrapId",
      "workerId",
      "nodeId",
      "targetWorkerGeneration",
      "platform",
      "architecture",
      "runtimeManifestSha256",
      "runtimeManifestPayloadSha256",
      "workspaceCeilingSha256",
      "capabilityCeilingSha256",
      "workerPublicKeySpkiSha256",
      "clientCertificateSha256",
      "transportTrustAnchorSha256",
      "tlsExporterSha256",
      "evidenceNonceSha256",
      "downloadVerificationReceiptSha256",
      "installedTreeAttestationSha256",
      "installedTreeVerificationReceiptSha256",
    ],
    "protected admission context",
  );
  return Object.freeze({
    registryWorkspaceId: identifier(fields.registryWorkspaceId, "registry workspace ID"),
    bootstrapId: identifier(fields.bootstrapId, "bootstrap ID"),
    workerId: identifier(fields.workerId, "worker ID"),
    nodeId: identifier(fields.nodeId, "node ID"),
    targetWorkerGeneration: positiveInteger(fields.targetWorkerGeneration, "target worker generation"),
    platform: identifier(fields.platform, "platform"),
    architecture: identifier(fields.architecture, "architecture"),
    runtimeManifestSha256: sha256(fields.runtimeManifestSha256, "runtime manifest"),
    runtimeManifestPayloadSha256: sha256(fields.runtimeManifestPayloadSha256, "runtime manifest payload"),
    workspaceCeilingSha256: sha256(fields.workspaceCeilingSha256, "workspace ceiling"),
    capabilityCeilingSha256: sha256(fields.capabilityCeilingSha256, "capability ceiling"),
    workerPublicKeySpkiSha256: sha256(fields.workerPublicKeySpkiSha256, "worker public key"),
    clientCertificateSha256: sha256(fields.clientCertificateSha256, "client certificate"),
    transportTrustAnchorSha256: sha256(fields.transportTrustAnchorSha256, "transport trust anchor"),
    tlsExporterSha256: sha256(fields.tlsExporterSha256, "TLS exporter"),
    evidenceNonceSha256: sha256(fields.evidenceNonceSha256, "evidence nonce"),
    downloadVerificationReceiptSha256: sha256(fields.downloadVerificationReceiptSha256, "download receipt"),
    installedTreeAttestationSha256: sha256(fields.installedTreeAttestationSha256, "installed-tree attestation"),
    installedTreeVerificationReceiptSha256: sha256(
      fields.installedTreeVerificationReceiptSha256,
      "installed-tree verification receipt",
    ),
  });
}

function exactDataFields(
  value: unknown,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  const prototype = value === null || typeof value !== "object" ? undefined : Object.getPrototypeOf(value);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    throw invalid(label);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key)) ||
    keys.some((key) => {
      const descriptor = descriptors[key as string];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw invalid(label);
  }
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) fields[key] = descriptors[key]?.value;
  return fields;
}

function canonicalBase64Url(value: unknown, byteLength: number, label: string): string {
  const encodedLength = Math.ceil((byteLength * 4) / 3);
  if (typeof value !== "string" || value.length !== encodedLength || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw invalid(label);
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalIndex = alphabet.indexOf(value.at(-1) ?? "");
  const remainder = byteLength % 3;
  if ((remainder === 1 && (finalIndex & 15) !== 0) || (remainder === 2 && (finalIndex & 3) !== 0)) {
    throw invalid(label);
  }
  return value;
}

function assertCanonicalEd25519SpkiBinding(encoded: string, expectedSha256: string, label: string): void {
  const bytes = decodeBase64Url(encoded);
  const prefix = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00] as const;
  if (
    bytes.byteLength !== REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_SPKI_BYTES ||
    prefix.some((value, index) => bytes[index] !== value) ||
    bytes.subarray(prefix.length).every((value) => value === 0) ||
    sha256BytesHex(bytes) !== expectedSha256
  ) {
    throw invalid(label);
  }
}

function decodeBase64Url(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const output = new Uint8Array(Math.floor((value.length * 6) / 8));
  let accumulator = 0;
  let availableBits = 0;
  let outputOffset = 0;
  for (const character of value) {
    accumulator = (accumulator << 6) | alphabet.indexOf(character);
    availableBits += 6;
    if (availableBits >= 8) {
      availableBits -= 8;
      output[outputOffset] = (accumulator >> availableBits) & 0xff;
      outputOffset += 1;
      accumulator &= availableBits === 0 ? 0 : (1 << availableBits) - 1;
    }
  }
  return output;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value !== value.normalize("NFKC").trim() ||
    /\p{Cc}/u.test(value)
  ) {
    throw invalid(label);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalid(label);
  return value as number;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw invalid(label);
  return value;
}

function nonzeroSha256(value: unknown, label: string): string {
  const digest = sha256(value, label);
  if (/^0{64}$/u.test(digest)) throw invalid(label);
  return digest;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw invalid(label);
  }
  return value;
}

function invalid(label: string): TypeError {
  return new TypeError(`Remote worker ${label} is invalid.`);
}
