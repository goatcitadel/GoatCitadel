import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import {
  REMOTE_WORKER_PROTECTED_ADMISSION_CONTEXT_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_ENVELOPE_BYTES,
  REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_DOMAIN,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_SPKI_BYTES,
  assertRemoteWorkerProtectedAdmissionEvidenceRecord,
  normalizeRemoteWorkerProtectedAdmissionEvidenceWire,
  normalizeRemoteWorkerProtectedAdmissionSignerPin,
  remoteWorkerProtectedAdmissionRemoteCallerBindingSha256,
  remoteWorkerProtectedAdmissionContextSha256,
  type RemoteWorkerProtectedAdmissionEvidenceRecord,
  type RemoteWorkerProtectedAdmissionSignerPin,
  type RemoteWorkerVerifiedProtectedAdmissionEvidence,
} from "@goatcitadel/contracts";
import type {
  RemoteWorkerAdmissionEvidenceVerificationInput,
  RemoteWorkerAdmissionEvidenceVerificationResult,
  RemoteWorkerAdmissionEvidenceVerifierPort,
} from "./remote-worker-admission-service.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ENVELOPE_MAGIC = "GCAE";

interface DecodedEnvelope {
  readonly operationId: Buffer;
  readonly evidenceNonceSha256: string;
  readonly workerGeneration: number;
  readonly contextSha256: string;
  readonly runtimeManifestSha256: string;
  readonly workerPublicKeySpkiSha256: string;
  readonly downloadVerificationReceiptSha256: string;
  readonly installedTreeAttestationSha256: string;
  readonly installedTreeVerificationReceiptSha256: string;
}

/**
 * Verifies that a protected Windows key authorized the exact fixed envelope
 * under the operator-pinned keyset. This does not independently rescan the
 * remote installed tree; the signed receipt bindings remain the asserted
 * evidence boundary.
 */
export class RemoteWorkerProtectedAdmissionEvidenceVerifier implements RemoteWorkerAdmissionEvidenceVerifierPort {
  public async assertAvailable(): Promise<void> {
    const probe = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.alloc(32, 0x01)]);
    const key = createPublicKey({ key: probe, format: "der", type: "spki" });
    const canonical = key.export({ format: "der", type: "spki" });
    if (!Buffer.isBuffer(canonical) || !safeBytesEqual(canonical, probe)) {
      throw new Error("Protected admission Ed25519 verifier preflight failed.");
    }
    if (REMOTE_WORKER_PROTECTED_ADMISSION_CONTEXT_SCHEMA_VERSION.length < 1) {
      throw new Error("Protected admission context contract is unavailable.");
    }
  }

  public verify(
    input: RemoteWorkerAdmissionEvidenceVerificationInput,
  ): RemoteWorkerAdmissionEvidenceVerificationResult {
    const pinValue = input.protectedAdmissionSignerPin;
    const wireValue = input.protectedAdmissionEvidenceWire;
    if (pinValue === undefined || wireValue === undefined) {
      throw rejected();
    }
    const pin = normalizeRemoteWorkerProtectedAdmissionSignerPin(pinValue);
    const wire = normalizeRemoteWorkerProtectedAdmissionEvidenceWire(wireValue);
    const envelopeBytes = decodeCanonicalBase64Url(
      wire.envelopeBase64Url,
      REMOTE_WORKER_PROTECTED_ADMISSION_ENVELOPE_BYTES,
    );
    const envelope = decodeEnvelope(envelopeBytes);
    const result = wire.signerResult;
    const signerSpki = decodeCanonicalBase64Url(
      result.signerSpkiBase64Url,
      REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_SPKI_BYTES,
    );
    const workerSpki = decodeCanonicalBase64Url(
      input.publicKeySpkiBase64Url,
      REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_SPKI_BYTES,
    );
    const signature = decodeCanonicalBase64Url(result.signatureBase64Url, 64);
    if (
      pin.keysetGeneration !== input.targetWorkerGeneration ||
      result.workerGeneration !== input.targetWorkerGeneration ||
      envelope.workerGeneration !== input.targetWorkerGeneration ||
      result.operationIdBase64Url !== envelope.operationId.toString("base64url") ||
      !safeDigestEqual(result.envelopeSha256, sha256(envelopeBytes)) ||
      !safeDigestEqual(result.keysetReceiptSha256, pin.keysetReceiptSha256) ||
      !safeDigestEqual(result.signerSpkiSha256, pin.signerSpkiSha256) ||
      result.signerSpkiBase64Url !== pin.signerSpkiBase64Url ||
      !safeDigestEqual(result.signerSpkiSha256, sha256(signerSpki)) ||
      !safeDigestEqual(input.publicKeySpkiSha256, sha256(workerSpki)) ||
      !safeDigestEqual(envelope.evidenceNonceSha256, input.evidenceNonceSha256) ||
      !safeDigestEqual(envelope.runtimeManifestSha256, input.runtimeManifestSha256) ||
      !safeDigestEqual(envelope.workerPublicKeySpkiSha256, input.publicKeySpkiSha256)
    ) {
      throw rejected();
    }
    assertCanonicalEd25519Spki(signerSpki);
    assertCanonicalEd25519Spki(workerSpki);
    const expectedContextSha256 = remoteWorkerProtectedAdmissionContextSha256({
      registryWorkspaceId: input.registryWorkspaceId,
      bootstrapId: input.bootstrapId,
      workerId: input.workerId,
      nodeId: input.nodeId,
      targetWorkerGeneration: input.targetWorkerGeneration,
      platform: input.platform,
      architecture: input.architecture,
      runtimeManifestSha256: input.runtimeManifestSha256,
      runtimeManifestPayloadSha256: input.runtimeManifest.payloadSha256,
      workspaceCeilingSha256: input.workspaceCeilingSha256,
      capabilityCeilingSha256: input.capabilityCeilingSha256,
      workerPublicKeySpkiSha256: input.publicKeySpkiSha256,
      clientCertificateSha256: input.clientCertificateSha256,
      transportTrustAnchorSha256: input.transportTrustAnchorSha256,
      tlsExporterSha256: input.tlsExporterSha256,
      evidenceNonceSha256: input.evidenceNonceSha256,
      downloadVerificationReceiptSha256: envelope.downloadVerificationReceiptSha256,
      installedTreeAttestationSha256: envelope.installedTreeAttestationSha256,
      installedTreeVerificationReceiptSha256: envelope.installedTreeVerificationReceiptSha256,
    });
    if (!safeDigestEqual(envelope.contextSha256, expectedContextSha256)) {
      throw rejected();
    }
    const authenticatedRemoteCallerBindingSha256 = remoteWorkerProtectedAdmissionRemoteCallerBindingSha256({
      workerPublicKeySpkiSha256: input.publicKeySpkiSha256,
      clientCertificateSha256: input.clientCertificateSha256,
      transportTrustAnchorSha256: input.transportTrustAnchorSha256,
      tlsExporterSha256: input.tlsExporterSha256,
    });
    let publicKey;
    try {
      publicKey = createPublicKey({ key: signerSpki, format: "der", type: "spki" });
    } catch {
      throw rejected();
    }
    const signingBytes = Buffer.concat([
      Buffer.from(`${REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_DOMAIN}\0`, "utf8"),
      envelopeBytes,
    ]);
    if (!verify(null, signingBytes, publicKey, signature)) {
      throw rejected();
    }
    const verifiedProtectedAdmissionEvidence: RemoteWorkerVerifiedProtectedAdmissionEvidence = Object.freeze({
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION,
      operationIdBase64Url: result.operationIdBase64Url,
      evidenceNonceSha256: envelope.evidenceNonceSha256,
      workerGeneration: envelope.workerGeneration,
      envelopeSha256: result.envelopeSha256,
      envelopeBase64Url: wire.envelopeBase64Url,
      keysetReceiptSha256: result.keysetReceiptSha256,
      signerSpkiSha256: result.signerSpkiSha256,
      signerSpkiBase64Url: result.signerSpkiBase64Url,
      signatureBase64Url: result.signatureBase64Url,
      contextSha256: envelope.contextSha256,
      runtimeManifestSha256: envelope.runtimeManifestSha256,
      runtimeManifestPayloadSha256: input.runtimeManifest.payloadSha256,
      workspaceCeilingSha256: input.workspaceCeilingSha256,
      capabilityCeilingSha256: input.capabilityCeilingSha256,
      workerPublicKeySpkiSha256: envelope.workerPublicKeySpkiSha256,
      workerPublicKeySpkiBase64Url: input.publicKeySpkiBase64Url,
      clientCertificateSha256: input.clientCertificateSha256,
      transportTrustAnchorSha256: input.transportTrustAnchorSha256,
      tlsExporterSha256: input.tlsExporterSha256,
      authenticatedRemoteCallerBindingSha256,
      downloadVerificationReceiptSha256: envelope.downloadVerificationReceiptSha256,
      installedTreeAttestationSha256: envelope.installedTreeAttestationSha256,
      installedTreeVerificationReceiptSha256: envelope.installedTreeVerificationReceiptSha256,
    });
    return Object.freeze({
      contextSha256: envelope.contextSha256,
      downloadVerificationReceiptSha256: envelope.downloadVerificationReceiptSha256,
      installedTreeAttestationSha256: envelope.installedTreeAttestationSha256,
      installedTreeVerificationReceiptSha256: envelope.installedTreeVerificationReceiptSha256,
      verifiedProtectedAdmissionEvidence,
    });
  }

  /**
   * Revalidates the cryptographic portion of an immutable persisted record.
   * Relational bootstrap/context bindings and current-generation/control state
   * remain the responsibility of the composed authority service.
   */
  public verifyPersisted(
    record: RemoteWorkerProtectedAdmissionEvidenceRecord,
    expectedPin: RemoteWorkerProtectedAdmissionSignerPin,
  ): RemoteWorkerProtectedAdmissionEvidenceRecord {
    assertRemoteWorkerProtectedAdmissionEvidenceRecord(record);
    const pin = normalizeRemoteWorkerProtectedAdmissionSignerPin(expectedPin);
    const envelopeBytes = decodeCanonicalBase64Url(
      record.envelopeBase64Url,
      REMOTE_WORKER_PROTECTED_ADMISSION_ENVELOPE_BYTES,
    );
    const envelope = decodeEnvelope(envelopeBytes);
    const signerSpki = decodeCanonicalBase64Url(
      record.signerSpkiBase64Url,
      REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_SPKI_BYTES,
    );
    const signature = decodeCanonicalBase64Url(record.signatureBase64Url, 64);
    if (
      pin.keysetGeneration !== record.workerGeneration ||
      !safeDigestEqual(pin.keysetReceiptSha256, record.keysetReceiptSha256) ||
      !safeDigestEqual(pin.signerSpkiSha256, record.signerSpkiSha256) ||
      pin.signerSpkiBase64Url !== record.signerSpkiBase64Url ||
      record.operationIdBase64Url !== envelope.operationId.toString("base64url") ||
      record.workerGeneration !== envelope.workerGeneration ||
      !safeDigestEqual(record.envelopeSha256, sha256(envelopeBytes)) ||
      !safeDigestEqual(record.evidenceNonceSha256, envelope.evidenceNonceSha256) ||
      !safeDigestEqual(record.contextSha256, envelope.contextSha256) ||
      !safeDigestEqual(record.runtimeManifestSha256, envelope.runtimeManifestSha256) ||
      !safeDigestEqual(record.workerPublicKeySpkiSha256, envelope.workerPublicKeySpkiSha256) ||
      !safeDigestEqual(record.downloadVerificationReceiptSha256, envelope.downloadVerificationReceiptSha256) ||
      !safeDigestEqual(record.installedTreeAttestationSha256, envelope.installedTreeAttestationSha256) ||
      !safeDigestEqual(
        record.installedTreeVerificationReceiptSha256,
        envelope.installedTreeVerificationReceiptSha256,
      ) ||
      !safeDigestEqual(
        record.authenticatedRemoteCallerBindingSha256,
        remoteWorkerProtectedAdmissionRemoteCallerBindingSha256({
          workerPublicKeySpkiSha256: record.workerPublicKeySpkiSha256,
          clientCertificateSha256: record.clientCertificateSha256,
          transportTrustAnchorSha256: record.transportTrustAnchorSha256,
          tlsExporterSha256: record.tlsExporterSha256,
        }),
      ) ||
      !safeDigestEqual(record.signerSpkiSha256, sha256(signerSpki))
    ) {
      throw rejected();
    }
    assertCanonicalEd25519Spki(signerSpki);
    let publicKey;
    try {
      publicKey = createPublicKey({ key: signerSpki, format: "der", type: "spki" });
    } catch {
      throw rejected();
    }
    if (
      !verify(
        null,
        Buffer.concat([Buffer.from(`${REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_DOMAIN}\0`, "utf8"), envelopeBytes]),
        publicKey,
        signature,
      )
    ) {
      throw rejected();
    }
    return record;
  }
}

function decodeEnvelope(bytes: Buffer): DecodedEnvelope {
  if (
    bytes.toString("ascii", 0, 4) !== ENVELOPE_MAGIC ||
    bytes.readUInt16LE(4) !== 1 ||
    bytes.readUInt8(6) !== 1 ||
    bytes.readUInt8(7) !== 0 ||
    bytes.readUInt32LE(8) !== REMOTE_WORKER_PROTECTED_ADMISSION_ENVELOPE_BYTES ||
    bytes.readUInt32LE(12) !== 0 ||
    !bytes.subarray(72, 96).every((value) => value === 0)
  ) {
    throw rejected();
  }
  const workerGeneration = Number(bytes.readBigUInt64LE(64));
  const operationId = Buffer.from(bytes.subarray(16, 32));
  if (!Number.isSafeInteger(workerGeneration) || workerGeneration < 1 || operationId.every((value) => value === 0)) {
    throw rejected();
  }
  const digests = [
    bytes.subarray(32, 64),
    bytes.subarray(96, 128),
    bytes.subarray(128, 160),
    bytes.subarray(160, 192),
    bytes.subarray(192, 224),
    bytes.subarray(224, 256),
    bytes.subarray(256, 288),
  ];
  if (digests.some((digest) => digest.every((value) => value === 0))) throw rejected();
  return Object.freeze({
    operationId,
    evidenceNonceSha256: digests[0]!.toString("hex"),
    workerGeneration,
    contextSha256: digests[1]!.toString("hex"),
    runtimeManifestSha256: digests[2]!.toString("hex"),
    workerPublicKeySpkiSha256: digests[3]!.toString("hex"),
    downloadVerificationReceiptSha256: digests[4]!.toString("hex"),
    installedTreeAttestationSha256: digests[5]!.toString("hex"),
    installedTreeVerificationReceiptSha256: digests[6]!.toString("hex"),
  });
}

function assertCanonicalEd25519Spki(spki: Buffer): void {
  if (!spki.subarray(0, ED25519_SPKI_PREFIX.byteLength).equals(ED25519_SPKI_PREFIX)) throw rejected();
  try {
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    const canonical = key.export({ format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || !Buffer.isBuffer(canonical) || !safeBytesEqual(canonical, spki)) {
      throw rejected();
    }
  } catch {
    throw rejected();
  }
}

function decodeCanonicalBase64Url(value: string, byteLength: number): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== byteLength || decoded.toString("base64url") !== value) throw rejected();
  return decoded;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeDigestEqual(left: string, right: string): boolean {
  return /^[0-9a-f]{64}$/u.test(left) && /^[0-9a-f]{64}$/u.test(right)
    ? timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
    : false;
}

function safeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function rejected(): Error {
  return new Error("Protected remote worker admission evidence is invalid.");
}
