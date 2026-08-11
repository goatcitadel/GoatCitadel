import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_DOMAIN,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  canonicalJsonString,
  remoteWorkerAuthenticatedOperatorActorSha256,
  remoteWorkerProtectedAdmissionContextSha256,
  type RemoteWorkerProtectedAdmissionEvidenceRecord,
  type RemoteWorkerProtectedAdmissionEvidenceWire,
  type RemoteWorkerProtectedAdmissionSignerPin,
  type RemoteWorkerRuntimeManifest,
} from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import type { RemoteWorkerAdmissionEvidenceVerificationInput } from "./remote-worker-admission-service.js";
import { RemoteWorkerProtectedAdmissionEvidenceVerifier } from "./remote-worker-protected-admission-evidence-verifier.js";

const digest = (value: string | Uint8Array): string =>
  createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");

interface Fixture {
  readonly input: RemoteWorkerAdmissionEvidenceVerificationInput;
  readonly wire: RemoteWorkerProtectedAdmissionEvidenceWire;
  readonly pin: RemoteWorkerProtectedAdmissionSignerPin;
}

function fixture(options: { readonly contextSha256?: string; readonly requestSha256?: string } = {}): Fixture {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signerSpki = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(signerSpki)) throw new Error("expected DER signer key");
  const workerSpki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 0x41)]);
  const runtimeManifest = manifest();
  const baseInput = {
    registryWorkspaceId: "default",
    bootstrapId: "bootstrap-a",
    workerId: "worker-a",
    nodeId: "node-a",
    targetWorkerGeneration: 1,
    platform: "windows",
    architecture: "x64",
    runtimeManifest,
    runtimeManifestSha256: digest(canonicalJsonString(runtimeManifest)),
    workspaceCeilingSha256: digest(canonicalJsonString(["default"])),
    capabilityCeilingSha256: digest(canonicalJsonString(["durable_compute"])),
    manifestVerificationReceipt: {
      signerKeyId: "release-key",
      signerSpkiSha256: digest("release-key"),
      payloadSha256: runtimeManifest.payloadSha256,
      manifestVerificationReceiptSha256: digest("manifest-verification"),
    },
    preparedBodySha256: digest("prepared-body"),
    exchangeIdempotencyKey: "exchange-a",
    publicKeySpkiBase64Url: workerSpki.toString("base64url"),
    publicKeySpkiSha256: digest(workerSpki),
    clientCertificateSha256: digest("client-certificate"),
    transportTrustAnchorSha256: digest("trust-anchor"),
    tlsExporterSha256: digest("tls-exporter"),
    transportReceiptSha256: digest("transport-receipt"),
    proofOfPossessionReceiptSha256: digest("proof-of-possession"),
    evidenceNonceSha256: digest("evidence-nonce"),
    contextSha256: digest("legacy-context"),
  } as const;
  const downloadReceipt = digest("download-receipt");
  const installedTreeAttestation = digest("installed-tree-attestation");
  const installedTreeReceipt = digest("installed-tree-receipt");
  const contextSha256 =
    options.contextSha256 ??
    remoteWorkerProtectedAdmissionContextSha256({
      registryWorkspaceId: baseInput.registryWorkspaceId,
      bootstrapId: baseInput.bootstrapId,
      workerId: baseInput.workerId,
      nodeId: baseInput.nodeId,
      targetWorkerGeneration: baseInput.targetWorkerGeneration,
      platform: baseInput.platform,
      architecture: baseInput.architecture,
      runtimeManifestSha256: baseInput.runtimeManifestSha256,
      runtimeManifestPayloadSha256: runtimeManifest.payloadSha256,
      workspaceCeilingSha256: baseInput.workspaceCeilingSha256,
      capabilityCeilingSha256: baseInput.capabilityCeilingSha256,
      workerPublicKeySpkiSha256: baseInput.publicKeySpkiSha256,
      clientCertificateSha256: baseInput.clientCertificateSha256,
      transportTrustAnchorSha256: baseInput.transportTrustAnchorSha256,
      tlsExporterSha256: baseInput.tlsExporterSha256,
      evidenceNonceSha256: baseInput.evidenceNonceSha256,
      downloadVerificationReceiptSha256: downloadReceipt,
      installedTreeAttestationSha256: installedTreeAttestation,
      installedTreeVerificationReceiptSha256: installedTreeReceipt,
    });
  const operationId = Buffer.alloc(16, 0x31);
  const envelope = Buffer.alloc(288);
  envelope.write("GCAE", 0, "ascii");
  envelope.writeUInt16LE(1, 4);
  envelope.writeUInt8(1, 6);
  envelope.writeUInt32LE(288, 8);
  operationId.copy(envelope, 16);
  Buffer.from(baseInput.evidenceNonceSha256, "hex").copy(envelope, 32);
  envelope.writeBigUInt64LE(1n, 64);
  Buffer.from(contextSha256, "hex").copy(envelope, 96);
  Buffer.from(baseInput.runtimeManifestSha256, "hex").copy(envelope, 128);
  Buffer.from(baseInput.publicKeySpkiSha256, "hex").copy(envelope, 160);
  Buffer.from(downloadReceipt, "hex").copy(envelope, 192);
  Buffer.from(installedTreeAttestation, "hex").copy(envelope, 224);
  Buffer.from(installedTreeReceipt, "hex").copy(envelope, 256);
  const keysetReceiptSha256 = digest("keyset-receipt");
  const protectedStateSha256 = digest("protected-state");
  const requestBody = Buffer.alloc(384);
  operationId.copy(requestBody, 0);
  Buffer.from(protectedStateSha256, "hex").copy(requestBody, 16);
  requestBody.writeUInt16LE(1, 48);
  requestBody.writeUInt8(2, 50);
  requestBody.writeBigUInt64LE(1n, 52);
  Buffer.from(keysetReceiptSha256, "hex").copy(requestBody, 60);
  requestBody.writeUInt32LE(288, 92);
  envelope.copy(requestBody, 96);
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(`${REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_DOMAIN}\0`, "utf8"), envelope]),
    privateKey,
  );
  const pin: RemoteWorkerProtectedAdmissionSignerPin = {
    schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
    signatureAlgorithm: "ed25519",
    keysetGeneration: 1,
    keysetReceiptSha256,
    signerSpkiSha256: digest(signerSpki),
    signerSpkiBase64Url: signerSpki.toString("base64url"),
  };
  const wire: RemoteWorkerProtectedAdmissionEvidenceWire = {
    schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION,
    envelopeBase64Url: envelope.toString("base64url"),
    signerResult: {
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION,
      disposition: "signed",
      operationIdBase64Url: operationId.toString("base64url"),
      workerGeneration: 1,
      envelopeSha256: digest(envelope),
      keysetReceiptSha256,
      signerSpkiSha256: pin.signerSpkiSha256,
      signerSpkiBase64Url: pin.signerSpkiBase64Url,
      signatureBase64Url: signature.toString("base64url"),
      protectedStateSha256,
      requestSha256: options.requestSha256 ?? digest(requestBody),
    },
  };
  return {
    pin,
    wire,
    input: { ...baseInput, protectedAdmissionSignerPin: pin, protectedAdmissionEvidenceWire: wire },
  };
}

function manifest(): RemoteWorkerRuntimeManifest {
  const payload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: digest("bundle"),
    dependencyLockSha256: digest("lock"),
    vendorTreeSha256: digest("vendor"),
    launcherSha256: digest("launcher"),
    installedTreeManifestSha256: digest("tree"),
    installedTreeFileCount: 5,
    platform: "windows",
    architecture: "x64",
  } as const;
  return {
    payload,
    payloadSha256: digest(canonicalJsonString(payload)),
    signatureAlgorithm: "ed25519",
    signerKeyId: "release-key",
    signatureBase64Url: Buffer.alloc(64, 9).toString("base64url"),
  };
}

describe("RemoteWorkerProtectedAdmissionEvidenceVerifier", () => {
  it("preflights Ed25519 and verifies every fixed protected binding", async () => {
    const verifier = new RemoteWorkerProtectedAdmissionEvidenceVerifier();
    await expect(verifier.assertAvailable()).resolves.toBeUndefined();
    const valid = fixture();
    const result = verifier.verify(valid.input);
    expect(result.verifiedProtectedAdmissionEvidence).toMatchObject({
      envelopeBase64Url: valid.wire.envelopeBase64Url,
      signerSpkiSha256: valid.pin.signerSpkiSha256,
      clientCertificateSha256: valid.input.clientCertificateSha256,
      tlsExporterSha256: valid.input.tlsExporterSha256,
    });
    const persisted: RemoteWorkerProtectedAdmissionEvidenceRecord = {
      ...result.verifiedProtectedAdmissionEvidence!,
      registryWorkspaceId: valid.input.registryWorkspaceId,
      bootstrapId: valid.input.bootstrapId,
      workerId: valid.input.workerId,
      authenticatedOperatorActorId: "operator-a",
      authenticatedOperatorActorSha256: remoteWorkerAuthenticatedOperatorActorSha256("operator-a"),
      admittedAt: "2026-08-08T21:00:00.000Z",
    };
    expect(verifier.verifyPersisted(persisted, valid.pin)).toBe(persisted);

    const changedEnvelope = Buffer.from(persisted.envelopeBase64Url, "base64url");
    changedEnvelope[200] = (changedEnvelope[200] ?? 0) ^ 0xff;
    expect(() =>
      verifier.verifyPersisted(
        {
          ...persisted,
          envelopeBase64Url: changedEnvelope.toString("base64url"),
          envelopeSha256: digest(changedEnvelope),
        },
        valid.pin,
      ),
    ).toThrow(/invalid/u);
  });

  it("rejects context substitution, key drift, and signature tampering", () => {
    const verifier = new RemoteWorkerProtectedAdmissionEvidenceVerifier();
    expect(() => verifier.verify(fixture({ contextSha256: digest("wrong-context") }).input)).toThrow(/invalid/u);

    const keyDrift = fixture();
    expect(() =>
      verifier.verify({
        ...keyDrift.input,
        protectedAdmissionSignerPin: { ...keyDrift.pin, keysetReceiptSha256: digest("other-keyset") },
      }),
    ).toThrow(/invalid/u);

    const signatureDrift = fixture();
    const signature = Buffer.from(signatureDrift.wire.signerResult.signatureBase64Url, "base64url");
    signature[0] = (signature[0] ?? 0) ^ 0xff;
    expect(() =>
      verifier.verify({
        ...signatureDrift.input,
        protectedAdmissionEvidenceWire: {
          ...signatureDrift.wire,
          signerResult: {
            ...signatureDrift.wire.signerResult,
            signatureBase64Url: signature.toString("base64url"),
          },
        },
      }),
    ).toThrow(/invalid/u);
  });

  it("excludes forgeable native state and request echoes from verified authority", () => {
    const verifier = new RemoteWorkerProtectedAdmissionEvidenceVerifier();
    const valid = fixture();
    const protectedStateSha256 = digest("forged-protected-state");
    const envelope = Buffer.from(valid.wire.envelopeBase64Url, "base64url");
    const requestBody = Buffer.alloc(384);
    Buffer.from(valid.wire.signerResult.operationIdBase64Url, "base64url").copy(requestBody, 0);
    Buffer.from(protectedStateSha256, "hex").copy(requestBody, 16);
    requestBody.writeUInt16LE(1, 48);
    requestBody.writeUInt8(2, 50);
    requestBody.writeBigUInt64LE(BigInt(valid.wire.signerResult.workerGeneration), 52);
    Buffer.from(valid.wire.signerResult.keysetReceiptSha256, "hex").copy(requestBody, 60);
    requestBody.writeUInt32LE(288, 92);
    envelope.copy(requestBody, 96);
    const mutatedWire: RemoteWorkerProtectedAdmissionEvidenceWire = {
      ...valid.wire,
      signerResult: {
        ...valid.wire.signerResult,
        protectedStateSha256,
        requestSha256: digest(requestBody),
      },
    };

    const result = verifier.verify({ ...valid.input, protectedAdmissionEvidenceWire: mutatedWire });
    expect(result.verifiedProtectedAdmissionEvidence).not.toHaveProperty("protectedStateSha256");
    expect(result.verifiedProtectedAdmissionEvidence).not.toHaveProperty("signerRequestSha256");
  });
});
