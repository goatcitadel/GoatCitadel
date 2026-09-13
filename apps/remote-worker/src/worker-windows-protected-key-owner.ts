import {
  REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION,
  normalizeRemoteWorkerProtectedAdmissionEvidenceWire,
} from "@goatcitadel/contracts";
import {
  signWindowsProtectedAdmissionEvidence,
  signWindowsProtectedRuntimePopV2,
} from "@goatcitadel/remote-worker-provisioner/windows-service-client";
import { decodeWindowsProtectedAdmissionEvidenceEnvelope } from "@goatcitadel/remote-worker-provisioner/windows-helper-protocol";
import { decodeWindowsTlsKeyIdentifier } from "@goatcitadel/remote-worker-provisioner/windows-tls-key-identifier";
import {
  normalizeWorkerProtectedKeyReference,
  requireWorkerProtectedKeyOwner,
  workerProtectedPublicSpki,
  type WorkerProtectedKeyOwner,
} from "./worker-protected-key-owner.js";

/** The installed owner provides these public pins alongside its already-admitted TLS context. */
export function createWindowsProtectedWorkerKeyOwner(input: {
  readonly tlsKeyIdentifier: string;
  readonly admissionSignerSpkiBase64Url: string;
}): WorkerProtectedKeyOwner {
  if (process.platform !== "win32") throw new Error("Windows protected key custody requires Windows.");
  const descriptor = decodeWindowsTlsKeyIdentifier(input.tlsKeyIdentifier);
  const reference = normalizeWorkerProtectedKeyReference({
    kind: "windows_provisioner",
    keysetGeneration: descriptor.keysetGeneration,
    protectedStateSha256: descriptor.stateSha256,
    keysetReceiptSha256: descriptor.keysetReceiptSha256,
    workerPublicKeySpkiBase64Url: descriptor.workerPublicKeySpkiBase64Url,
  });
  const admissionSignerSpkiBase64Url = workerProtectedPublicSpki(input.admissionSignerSpkiBase64Url).toString(
    "base64url",
  );
  const authority = () => ({
    expectedStateSha256: Buffer.from(reference.protectedStateSha256, "hex"),
    expectedGeneration: BigInt(reference.keysetGeneration),
    expectedKeysetReceiptSha256: Buffer.from(reference.keysetReceiptSha256, "hex"),
  });
  const owner: WorkerProtectedKeyOwner = Object.freeze<WorkerProtectedKeyOwner>({
    reference,
    admissionSignerSpkiBase64Url,
    async signPopV2(operation) {
      requireWorkerProtectedKeyOwner(operation.reference, owner);
      const signal = operation.signal;
      signal.throwIfAborted();
      const request = { ...authority(), preimage: Buffer.from(operation.preimage) };
      const result = await signWindowsProtectedRuntimePopV2(descriptor.helperExecutablePath, request, { signal });
      signal.throwIfAborted();
      if (result.disposition !== "signed") throw new Error(`Native runtime proof was refused (${result.disposition}).`);
      return Buffer.from(result.signature).toString("base64url");
    },
    async signAdmissionEnvelope(operation) {
      requireWorkerProtectedKeyOwner(operation.reference, owner);
      const signal = operation.signal;
      signal.throwIfAborted();
      const bytes = Buffer.from(operation.envelope);
      const envelope = decodeWindowsProtectedAdmissionEvidenceEnvelope(bytes);
      const request = { ...authority(), operationId: Buffer.from(envelope.operationId), envelope };
      const result = await signWindowsProtectedAdmissionEvidence(descriptor.helperExecutablePath, request, { signal });
      signal.throwIfAborted();
      if (
        (result.disposition !== "signed" && result.disposition !== "exact_replay") ||
        Buffer.from(result.admissionEvidenceSpki).toString("base64url") !== admissionSignerSpkiBase64Url
      )
        throw new Error("Native admission evidence was refused or used a different signer.");
      return normalizeRemoteWorkerProtectedAdmissionEvidenceWire({
        schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION,
        envelopeBase64Url: bytes.toString("base64url"),
        signerResult: {
          schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION,
          disposition: result.disposition,
          operationIdBase64Url: Buffer.from(result.operationId).toString("base64url"),
          workerGeneration: Number(result.generation),
          envelopeSha256: Buffer.from(result.envelopeSha256).toString("hex"),
          keysetReceiptSha256: Buffer.from(result.keysetReceiptSha256).toString("hex"),
          signerSpkiSha256: Buffer.from(result.admissionEvidenceSpkiSha256).toString("hex"),
          signerSpkiBase64Url: admissionSignerSpkiBase64Url,
          signatureBase64Url: Buffer.from(result.signature).toString("base64url"),
          protectedStateSha256: Buffer.from(result.protectedStateSha256).toString("hex"),
          requestSha256: Buffer.from(result.requestSha256).toString("hex"),
        },
      });
    },
  });
  return owner;
}
