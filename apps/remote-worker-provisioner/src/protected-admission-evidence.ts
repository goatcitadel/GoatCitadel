import {
  REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION,
  normalizeRemoteWorkerProtectedAdmissionEvidenceWire,
  normalizeRemoteWorkerProtectedAdmissionSignerPin,
  remoteWorkerProtectedAdmissionContextSha256,
  type RemoteWorkerProtectedAdmissionContextInput,
  type RemoteWorkerProtectedAdmissionEvidenceWire,
  type RemoteWorkerProtectedAdmissionSignerPin,
} from "@goatcitadel/contracts";
import {
  encodeWindowsProtectedAdmissionEvidenceEnvelope,
  type WindowsProtectedInspect,
  type WindowsProtectedSignAdmissionEvidenceRequest,
  type WindowsProtectedSignAdmissionEvidenceResult,
} from "./windows-helper-protocol.js";
import {
  inspectWindowsProtectedService,
  signWindowsProtectedAdmissionEvidence,
  type WindowsServiceClientRunOptions,
} from "./windows-service-client.js";

export interface WindowsProtectedAdmissionEvidenceInput extends RemoteWorkerProtectedAdmissionContextInput {
  /** Caller-owned stable operation ID; retrying must reuse these exact 16 bytes. */
  readonly operationIdBase64Url: string;
  /** Exact operator-provisioned pin persisted by the Gateway bootstrap. */
  readonly protectedAdmissionSignerPin: RemoteWorkerProtectedAdmissionSignerPin;
}

export interface WindowsProtectedAdmissionEvidenceRuntime {
  readonly inspect: (
    executablePath: string,
    options?: WindowsServiceClientRunOptions,
  ) => Promise<WindowsProtectedInspect>;
  readonly sign: (
    executablePath: string,
    request: WindowsProtectedSignAdmissionEvidenceRequest,
    options?: WindowsServiceClientRunOptions,
  ) => Promise<WindowsProtectedSignAdmissionEvidenceResult>;
}

const productionRuntime: WindowsProtectedAdmissionEvidenceRuntime = {
  inspect: inspectWindowsProtectedService,
  sign: signWindowsProtectedAdmissionEvidence,
};

/**
 * Reads the protected service authority that an operator must pin through the
 * loopback bootstrap route before any remote exchange begins.
 */
export async function inspectWindowsProtectedAdmissionSignerPin(
  executablePath: string,
  options: WindowsServiceClientRunOptions = {},
  runtime: WindowsProtectedAdmissionEvidenceRuntime = productionRuntime,
): Promise<RemoteWorkerProtectedAdmissionSignerPin> {
  return signerPinFromInspect(await runtime.inspect(executablePath, options));
}

/**
 * Produces the exact 288-byte protected-key-authorized binding submitted to the
 * Gateway exchange. The native decoder verifies its own signature receipt;
 * Gateway admission independently verifies the same signature against the
 * operator-pinned SPKI. This is not an independent installed-tree rescan.
 */
export async function createWindowsProtectedAdmissionEvidence(
  executablePath: string,
  input: WindowsProtectedAdmissionEvidenceInput,
  options: WindowsServiceClientRunOptions = {},
  runtime: WindowsProtectedAdmissionEvidenceRuntime = productionRuntime,
): Promise<RemoteWorkerProtectedAdmissionEvidenceWire> {
  const expectedPin = normalizeRemoteWorkerProtectedAdmissionSignerPin(input.protectedAdmissionSignerPin);
  const inspect = await runtime.inspect(executablePath, options);
  const observedPin = signerPinFromInspect(inspect);
  if (!pinsEqual(observedPin, expectedPin) || expectedPin.keysetGeneration !== input.targetWorkerGeneration) {
    throw new Error("Windows protected admission signer authority drifted from the operator pin.");
  }
  const operationId = decodeCanonicalBase64Url(input.operationIdBase64Url, 16, "operation ID");
  const contextSha256 = remoteWorkerProtectedAdmissionContextSha256({
    registryWorkspaceId: input.registryWorkspaceId,
    bootstrapId: input.bootstrapId,
    workerId: input.workerId,
    nodeId: input.nodeId,
    targetWorkerGeneration: input.targetWorkerGeneration,
    platform: input.platform,
    architecture: input.architecture,
    runtimeManifestSha256: input.runtimeManifestSha256,
    runtimeManifestPayloadSha256: input.runtimeManifestPayloadSha256,
    workspaceCeilingSha256: input.workspaceCeilingSha256,
    capabilityCeilingSha256: input.capabilityCeilingSha256,
    workerPublicKeySpkiSha256: input.workerPublicKeySpkiSha256,
    clientCertificateSha256: input.clientCertificateSha256,
    transportTrustAnchorSha256: input.transportTrustAnchorSha256,
    tlsExporterSha256: input.tlsExporterSha256,
    evidenceNonceSha256: input.evidenceNonceSha256,
    downloadVerificationReceiptSha256: input.downloadVerificationReceiptSha256,
    installedTreeAttestationSha256: input.installedTreeAttestationSha256,
    installedTreeVerificationReceiptSha256: input.installedTreeVerificationReceiptSha256,
  });
  const envelopeInput = {
    operationId,
    evidenceNonceSha256: decodeDigest(input.evidenceNonceSha256, "evidence nonce"),
    // The native v1 contract deliberately makes protected keyset generation
    // identical to worker generation and rejects any unequal request/envelope.
    workerGeneration: BigInt(input.targetWorkerGeneration),
    contextSha256: decodeDigest(contextSha256, "protected context"),
    runtimeManifestSha256: decodeDigest(input.runtimeManifestSha256, "runtime manifest"),
    workerPublicKeySpkiSha256: decodeDigest(input.workerPublicKeySpkiSha256, "worker SPKI"),
    downloadVerificationReceiptSha256: decodeDigest(input.downloadVerificationReceiptSha256, "download receipt"),
    installedTreeAttestationSha256: decodeDigest(input.installedTreeAttestationSha256, "installed-tree attestation"),
    installedTreeVerificationReceiptSha256: decodeDigest(
      input.installedTreeVerificationReceiptSha256,
      "installed-tree receipt",
    ),
  };
  const envelope = encodeWindowsProtectedAdmissionEvidenceEnvelope(envelopeInput);
  const result = await runtime.sign(
    executablePath,
    {
      operationId,
      expectedStateSha256: inspect.stateSha256,
      expectedGeneration: BigInt(expectedPin.keysetGeneration),
      expectedKeysetReceiptSha256: decodeDigest(expectedPin.keysetReceiptSha256, "keyset receipt"),
      envelope: envelopeInput,
    },
    options,
  );
  if (result.disposition !== "signed" && result.disposition !== "exact_replay") {
    throw new Error(`Windows protected admission signer rejected the request: ${result.disposition}`);
  }
  return normalizeRemoteWorkerProtectedAdmissionEvidenceWire({
    schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION,
    envelopeBase64Url: envelope.toString("base64url"),
    signerResult: {
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION,
      disposition: result.disposition,
      operationIdBase64Url: Buffer.from(result.operationId).toString("base64url"),
      workerGeneration: safeGeneration(result.generation),
      envelopeSha256: Buffer.from(result.envelopeSha256).toString("hex"),
      keysetReceiptSha256: Buffer.from(result.keysetReceiptSha256).toString("hex"),
      signerSpkiSha256: Buffer.from(result.admissionEvidenceSpkiSha256).toString("hex"),
      signerSpkiBase64Url: Buffer.from(result.admissionEvidenceSpki).toString("base64url"),
      signatureBase64Url: Buffer.from(result.signature).toString("base64url"),
      // These native v1 echoes are forwarded for wire compatibility only. They
      // are unsigned and the Gateway deliberately excludes them from authority.
      protectedStateSha256: Buffer.from(result.protectedStateSha256).toString("hex"),
      requestSha256: Buffer.from(result.requestSha256).toString("hex"),
    },
  });
}

function signerPinFromInspect(inspect: WindowsProtectedInspect): RemoteWorkerProtectedAdmissionSignerPin {
  if (inspect.custodyPosture !== "active" && inspect.custodyPosture !== "capacity_exhausted_active") {
    throw new Error("Windows protected admission signer has no active keyset.");
  }
  return normalizeRemoteWorkerProtectedAdmissionSignerPin({
    schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
    signatureAlgorithm: "ed25519",
    keysetGeneration: safeGeneration(inspect.activeGeneration),
    keysetReceiptSha256: Buffer.from(inspect.activeKeysetReceiptSha256).toString("hex"),
    signerSpkiSha256: Buffer.from(inspect.admissionEvidenceSpkiSha256).toString("hex"),
    signerSpkiBase64Url: Buffer.from(inspect.admissionEvidenceSpki).toString("base64url"),
  });
}

function pinsEqual(
  left: RemoteWorkerProtectedAdmissionSignerPin,
  right: RemoteWorkerProtectedAdmissionSignerPin,
): boolean {
  return (
    left.keysetGeneration === right.keysetGeneration &&
    left.keysetReceiptSha256 === right.keysetReceiptSha256 &&
    left.signerSpkiSha256 === right.signerSpkiSha256 &&
    left.signerSpkiBase64Url === right.signerSpkiBase64Url
  );
}

function decodeCanonicalBase64Url(value: string, length: number, label: string): Buffer {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== length || bytes.toString("base64url") !== value || bytes.every((byte) => byte === 0)) {
    throw new Error(`Windows protected admission ${label} is invalid.`);
  }
  return bytes;
}

function decodeDigest(value: string, label: string): Buffer {
  if (!/^[0-9a-f]{64}$/u.test(value) || /^0{64}$/u.test(value)) {
    throw new Error(`Windows protected admission ${label} is invalid.`);
  }
  return Buffer.from(value, "hex");
}

function safeGeneration(value: bigint): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1 || BigInt(generation) !== value) {
    throw new Error("Windows protected admission generation is invalid.");
  }
  return generation;
}
