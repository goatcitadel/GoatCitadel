import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_DOMAIN } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createWindowsProtectedAdmissionEvidence,
  inspectWindowsProtectedAdmissionSignerPin,
  type WindowsProtectedAdmissionEvidenceInput,
  type WindowsProtectedAdmissionEvidenceRuntime,
} from "./protected-admission-evidence.js";
import {
  WINDOWS_HELPER_CALLABLE_OPCODE_BITMAP,
  WINDOWS_HELPER_ORDINARY_MAX_BYTES,
  WINDOWS_HELPER_PE_MACHINE,
  WINDOWS_HELPER_RECOGNIZED_OPCODE_BITMAP,
  WINDOWS_HELPER_SECRET_MAX_BYTES,
  WINDOWS_PROTECTED_CALLABLE_OPCODE_BITMAP,
  decodeWindowsProtectedAdmissionEvidenceEnvelope,
  encodeWindowsProtectedAdmissionEvidenceEnvelope,
  encodeWindowsProtectedSignAdmissionEvidenceRequest,
  type WindowsProtectedInspect,
} from "./windows-helper-protocol.js";

const digest = (value: string | Uint8Array): string =>
  createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");

function fixture() {
  const signer = generateKeyPairSync("ed25519");
  const signerSpki = signer.publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(signerSpki)) throw new Error("expected DER signer key");
  const worker = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(worker)) throw new Error("expected DER worker key");
  const inspect: WindowsProtectedInspect = {
    schemaVersion: 1,
    machine: WINDOWS_HELPER_PE_MACHINE.X64,
    ordinaryMaximumBytes: WINDOWS_HELPER_ORDINARY_MAX_BYTES,
    secretMaximumBytes: WINDOWS_HELPER_SECRET_MAX_BYTES,
    flags: 0,
    recognizedOpcodeBitmap: WINDOWS_HELPER_RECOGNIZED_OPCODE_BITMAP,
    callableOpcodeBitmap: WINDOWS_HELPER_CALLABLE_OPCODE_BITMAP,
    protectedSchemaVersion: 1,
    custodyPosture: "active",
    protectedFlags: 1,
    protectedCallableOpcodeBitmap: WINDOWS_PROTECTED_CALLABLE_OPCODE_BITMAP,
    stateSha256: Buffer.from(digest("state"), "hex"),
    activeGeneration: 1n,
    highestBurnedGeneration: 0n,
    committedGenerationCount: 1,
    burnedGenerationCount: 0,
    totalOperationIdCount: 1,
    quarantinedOperationCount: 0,
    quarantineResidueCount: 0,
    remainingOperationCapacity: 255,
    remainingGenerationCapacity: 15,
    activeKeysetReceiptSha256: Buffer.from(digest("receipt"), "hex"),
    runtimeManifestSpkiSha256: Buffer.from(digest(worker), "hex"),
    admissionEvidenceSpkiSha256: Buffer.from(digest(signerSpki), "hex"),
    runtimeManifestSpki: worker,
    admissionEvidenceSpki: signerSpki,
  };
  const runtime: WindowsProtectedAdmissionEvidenceRuntime = {
    inspect: vi.fn(async () => inspect),
    sign: vi.fn(async (_path, request) => {
      const envelope = encodeWindowsProtectedAdmissionEvidenceEnvelope(request.envelope);
      const requestBody = encodeWindowsProtectedSignAdmissionEvidenceRequest(request).subarray(16);
      return {
        disposition: "signed" as const,
        operationId: request.operationId,
        generation: request.expectedGeneration,
        envelopeSha256: Buffer.from(digest(envelope), "hex"),
        keysetReceiptSha256: request.expectedKeysetReceiptSha256,
        admissionEvidenceSpkiSha256: Buffer.from(digest(signerSpki), "hex"),
        admissionEvidenceSpki: signerSpki,
        signature: sign(
          null,
          Buffer.concat([Buffer.from(`${REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_DOMAIN}\0`, "utf8"), envelope]),
          signer.privateKey,
        ),
        protectedStateSha256: request.expectedStateSha256,
        requestSha256: Buffer.from(digest(requestBody), "hex"),
      };
    }),
  };
  return { inspect, runtime, worker };
}

function input(worker: Buffer): Omit<WindowsProtectedAdmissionEvidenceInput, "protectedAdmissionSignerPin"> {
  return {
    operationIdBase64Url: Buffer.alloc(16, 0x42).toString("base64url"),
    registryWorkspaceId: "default",
    bootstrapId: "bootstrap-a",
    workerId: "worker-a",
    nodeId: "node-a",
    targetWorkerGeneration: 1,
    platform: "windows",
    architecture: "x64",
    runtimeManifestSha256: digest("manifest"),
    runtimeManifestPayloadSha256: digest("manifest-payload"),
    workspaceCeilingSha256: digest("workspace-ceiling"),
    capabilityCeilingSha256: digest("capability-ceiling"),
    workerPublicKeySpkiSha256: digest(worker),
    clientCertificateSha256: digest("certificate"),
    transportTrustAnchorSha256: digest("trust-anchor"),
    tlsExporterSha256: digest("tls-exporter"),
    evidenceNonceSha256: digest("nonce"),
    downloadVerificationReceiptSha256: digest("download"),
    installedTreeAttestationSha256: digest("installed-tree"),
    installedTreeVerificationReceiptSha256: digest("installed-tree-receipt"),
  };
}

describe("Windows protected admission evidence production helper", () => {
  it("pins inspect authority before signing the exact fixed envelope", async () => {
    const { runtime, worker } = fixture();
    const pin = await inspectWindowsProtectedAdmissionSignerPin("C:\\gc\\provisioner.exe", {}, runtime);
    const context = input(worker);
    const wire = await createWindowsProtectedAdmissionEvidence(
      "C:\\gc\\provisioner.exe",
      { ...context, protectedAdmissionSignerPin: pin },
      {},
      runtime,
    );

    const envelope = Buffer.from(wire.envelopeBase64Url, "base64url");
    expect(envelope.byteLength).toBe(288);
    const decoded = decodeWindowsProtectedAdmissionEvidenceEnvelope(envelope);
    expect(decoded.workerGeneration).toBe(1n);
    expect(Buffer.from(decoded.workerPublicKeySpkiSha256).toString("hex")).toBe(context.workerPublicKeySpkiSha256);
    expect(wire.signerResult.signerSpkiSha256).toBe(pin.signerSpkiSha256);
    expect(runtime.sign).toHaveBeenCalledOnce();
  });

  it("fails before signing on key drift or generation conflation", async () => {
    const { runtime, worker } = fixture();
    const pin = await inspectWindowsProtectedAdmissionSignerPin("C:\\gc\\provisioner.exe", {}, runtime);
    await expect(
      createWindowsProtectedAdmissionEvidence(
        "C:\\gc\\provisioner.exe",
        { ...input(worker), protectedAdmissionSignerPin: { ...pin, keysetReceiptSha256: digest("drift") } },
        {},
        runtime,
      ),
    ).rejects.toThrow(/drifted/u);
    await expect(
      createWindowsProtectedAdmissionEvidence(
        "C:\\gc\\provisioner.exe",
        { ...input(worker), targetWorkerGeneration: 2, protectedAdmissionSignerPin: pin },
        {},
        runtime,
      ),
    ).rejects.toThrow(/drifted/u);
    await expect(
      createWindowsProtectedAdmissionEvidence(
        "C:\\gc\\provisioner.exe",
        {
          ...input(generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }) as Buffer),
          protectedAdmissionSignerPin: pin,
        },
        {},
        runtime,
      ),
    ).rejects.toThrow(/protected runtime-manifest key/u);
    expect(runtime.sign).not.toHaveBeenCalled();
  });
});
