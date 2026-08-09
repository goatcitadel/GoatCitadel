import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION,
  assertRemoteWorkerProtectedAdmissionEvidenceRecord,
  normalizeRemoteWorkerProtectedAdmissionEvidenceWire,
  normalizeRemoteWorkerProtectedAdmissionSignerPin,
  normalizeRemoteWorkerVerifiedProtectedAdmissionEvidence,
  remoteWorkerAuthenticatedOperatorActorSha256,
  remoteWorkerProtectedAdmissionRemoteCallerBindingSha256,
  remoteWorkerProtectedAdmissionContextSha256,
  type RemoteWorkerVerifiedProtectedAdmissionEvidence,
} from "./remote-worker-protected-admission.js";

const digest = (value: string | Uint8Array): string =>
  createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");
const b64 = (bytes: number, fill: number): string => Buffer.alloc(bytes, fill).toString("base64url");
const edSpki = (fill: number): Buffer =>
  Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, fill)]);

const workerSpki = edSpki(2);

const caller = Object.freeze({
  workerPublicKeySpkiSha256: digest(workerSpki),
  clientCertificateSha256: digest("certificate"),
  transportTrustAnchorSha256: digest("trust-anchor"),
  tlsExporterSha256: digest("tls-exporter"),
});

function verifiedEvidence(): RemoteWorkerVerifiedProtectedAdmissionEvidence {
  return {
    schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION,
    operationIdBase64Url: b64(16, 1),
    evidenceNonceSha256: digest("nonce"),
    workerGeneration: 3,
    envelopeSha256: digest("envelope"),
    envelopeBase64Url: b64(288, 2),
    keysetReceiptSha256: digest("keyset"),
    signerSpkiSha256: digest(edSpki(3)),
    signerSpkiBase64Url: edSpki(3).toString("base64url"),
    signatureBase64Url: b64(64, 4),
    contextSha256: digest("context"),
    runtimeManifestSha256: digest("manifest"),
    runtimeManifestPayloadSha256: digest("manifest-payload"),
    workspaceCeilingSha256: digest("workspace-ceiling"),
    capabilityCeilingSha256: digest("capability-ceiling"),
    ...caller,
    workerPublicKeySpkiBase64Url: workerSpki.toString("base64url"),
    authenticatedRemoteCallerBindingSha256: remoteWorkerProtectedAdmissionRemoteCallerBindingSha256(caller),
    downloadVerificationReceiptSha256: digest("download"),
    installedTreeAttestationSha256: digest("installed-tree"),
    installedTreeVerificationReceiptSha256: digest("installed-tree-receipt"),
  };
}

describe("remote worker protected admission contracts", () => {
  it("accepts only the fixed bounded pin and wire shapes", () => {
    const signerSpki = edSpki(5);
    const signerSpkiBase64Url = signerSpki.toString("base64url");
    const pin = {
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
      signatureAlgorithm: "ed25519",
      keysetGeneration: 3,
      keysetReceiptSha256: digest("keyset"),
      signerSpkiSha256: digest(signerSpki),
      signerSpkiBase64Url,
    } as const;
    expect(normalizeRemoteWorkerProtectedAdmissionSignerPin(pin)).toMatchObject({
      keysetGeneration: 3,
      signerSpkiBase64Url,
    });
    expect(normalizeRemoteWorkerProtectedAdmissionSignerPin(Object.assign(Object.create(null), pin))).toEqual(pin);

    const wire = {
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION,
      envelopeBase64Url: b64(288, 6),
      signerResult: {
        schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION,
        disposition: "signed",
        operationIdBase64Url: b64(16, 7),
        workerGeneration: 3,
        envelopeSha256: digest("envelope"),
        keysetReceiptSha256: digest("keyset"),
        signerSpkiSha256: digest(signerSpki),
        signerSpkiBase64Url,
        signatureBase64Url: b64(64, 8),
        protectedStateSha256: digest("state"),
        requestSha256: digest("request"),
      },
    } as const;
    expect(normalizeRemoteWorkerProtectedAdmissionEvidenceWire(wire)).toEqual(wire);
    expect(() => normalizeRemoteWorkerProtectedAdmissionEvidenceWire({ ...wire, extra: true })).toThrow();
    expect(() =>
      normalizeRemoteWorkerProtectedAdmissionEvidenceWire({
        ...wire,
        envelopeBase64Url: `${wire.envelopeBase64Url.slice(0, -1)}=`,
      }),
    ).toThrow();
    expect(() =>
      normalizeRemoteWorkerProtectedAdmissionEvidenceWire({
        ...wire,
        signerResult: { ...wire.signerResult, protectedStateSha256: "0".repeat(64) },
      }),
    ).toThrow();
  });

  it("binds every authenticated caller component and rejects a forged aggregate", () => {
    const evidence = verifiedEvidence();
    expect(normalizeRemoteWorkerVerifiedProtectedAdmissionEvidence(evidence)).toEqual(evidence);
    expect(() =>
      normalizeRemoteWorkerVerifiedProtectedAdmissionEvidence({
        ...evidence,
        tlsExporterSha256: digest("different-exporter"),
      }),
    ).toThrow(/invalid/u);
    expect(remoteWorkerProtectedAdmissionRemoteCallerBindingSha256(caller)).not.toBe(
      remoteWorkerProtectedAdmissionRemoteCallerBindingSha256({
        ...caller,
        clientCertificateSha256: digest("other-cert"),
      }),
    );
  });

  it("derives a stable no-cycle context and validates optional revocation lineage", () => {
    const context = {
      registryWorkspaceId: "default",
      bootstrapId: "bootstrap-3",
      workerId: "worker-3",
      nodeId: "node-3",
      targetWorkerGeneration: 3,
      platform: "windows",
      architecture: "x64",
      runtimeManifestSha256: digest("manifest"),
      runtimeManifestPayloadSha256: digest("manifest-payload"),
      workspaceCeilingSha256: digest("workspace-ceiling"),
      capabilityCeilingSha256: digest("capability-ceiling"),
      ...caller,
      evidenceNonceSha256: digest("nonce"),
      downloadVerificationReceiptSha256: digest("download"),
      installedTreeAttestationSha256: digest("installed-tree"),
      installedTreeVerificationReceiptSha256: digest("installed-tree-receipt"),
    } as const;
    expect(remoteWorkerProtectedAdmissionContextSha256(context)).toBe(
      remoteWorkerProtectedAdmissionContextSha256({ ...context }),
    );
    expect(remoteWorkerProtectedAdmissionContextSha256(context)).not.toBe(
      remoteWorkerProtectedAdmissionContextSha256({ ...context, evidenceNonceSha256: digest("other-nonce") }),
    );

    const record = {
      ...verifiedEvidence(),
      registryWorkspaceId: "default",
      bootstrapId: "bootstrap-3",
      workerId: "worker-3",
      authenticatedOperatorActorId: "operator-a",
      authenticatedOperatorActorSha256: remoteWorkerAuthenticatedOperatorActorSha256("operator-a"),
      admittedAt: "2026-08-08T12:00:00.000Z",
      revokedAt: "2026-08-08T12:01:00.000Z",
    };
    expect(() => assertRemoteWorkerProtectedAdmissionEvidenceRecord(record)).not.toThrow();
    expect(() =>
      assertRemoteWorkerProtectedAdmissionEvidenceRecord({
        ...record,
        authenticatedOperatorActorSha256: digest("wrong-operator"),
      }),
    ).toThrow();
  });
});
