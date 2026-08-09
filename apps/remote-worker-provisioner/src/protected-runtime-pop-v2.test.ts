import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  REMOTE_WORKER_POP_V2_PREIMAGE_BYTES,
  REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
  buildRemoteWorkerPopV2Preimage,
  type RemoteWorkerPopV2Input,
} from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  signWindowsProtectedRemoteWorkerPopV2,
  type WindowsProtectedRuntimePopV2Runtime,
} from "./protected-runtime-pop-v2.js";
import { type WindowsProtectedSignRuntimePopV2Result } from "./windows-helper-protocol.js";

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");

function proof(workerPublicKeySpkiSha256: string): RemoteWorkerPopV2Input {
  return {
    schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
    method: "POST",
    rawPath: "/api/v1/remote-workers/mesh-node-admissions",
    operation: "mesh.node.admit",
    bodySha256: sha256("body"),
    nonce: Buffer.alloc(32, 0x31).toString("base64url"),
    timestamp: "2026-08-09T12:34:56.789Z",
    idempotencyKey: "mesh-node-admit-1",
    authorityKind: "credential",
    authorityId: "credential-1",
    authorityGeneration: 3,
    workerGeneration: 7,
    tlsExporterSha256: sha256("exporter"),
    clientCertificateSha256: sha256("certificate"),
    workerPublicKeySpkiSha256,
  };
}

function fixture() {
  const runtimeKey = generateKeyPairSync("ed25519");
  const runtimeSpki = runtimeKey.publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(runtimeSpki)) throw new Error("expected DER runtime key");
  const runtimeSpkiSha256 = Buffer.from(sha256(runtimeSpki), "hex");
  const receipt = Buffer.from(sha256("receipt"), "hex");
  const state = Buffer.from(sha256("state"), "hex");
  const runtime: WindowsProtectedRuntimePopV2Runtime = {
    sign: vi.fn(async (_path, request) => ({
      disposition: "signed" as const,
      keysetReceiptSha256: request.expectedKeysetReceiptSha256,
      runtimeManifestSpkiSha256: runtimeSpkiSha256,
      runtimeManifestSpki: runtimeSpki,
      signature: sign(null, request.preimage, runtimeKey.privateKey),
    })),
  };
  const protectedAuthority = {
    stateSha256: state.toString("hex"),
    generation: 7,
    keysetReceiptSha256: receipt.toString("hex"),
  };
  return { protectedAuthority, receipt, runtime, runtimeKey, runtimeSpki, runtimeSpkiSha256 };
}

describe("Windows protected remote-worker PoP-v2 helper", () => {
  it("signs exactly the contract-owned 285-byte preimage with the protected runtime key", async () => {
    const { protectedAuthority, runtime, runtimeKey, runtimeSpki, runtimeSpkiSha256 } = fixture();
    const input = proof(runtimeSpkiSha256.toString("hex"));
    const result = await signWindowsProtectedRemoteWorkerPopV2(
      "C:\\gc\\provisioner-client.exe",
      {
        proof: input,
        protectedAuthority,
      },
      {},
      runtime,
    );

    const expectedPreimage = Buffer.from(buildRemoteWorkerPopV2Preimage(input));
    expect(expectedPreimage).toHaveLength(REMOTE_WORKER_POP_V2_PREIMAGE_BYTES);
    expect(runtime.sign).toHaveBeenCalledOnce();
    const request = vi.mocked(runtime.sign).mock.calls[0]![1];
    expect(request.preimage).toEqual(expectedPreimage);
    expect(request.expectedGeneration).toBe(7n);
    expect(request.expectedStateSha256).toEqual(Buffer.from(protectedAuthority.stateSha256, "hex"));
    expect(request.expectedKeysetReceiptSha256).toEqual(Buffer.from(protectedAuthority.keysetReceiptSha256, "hex"));
    expect(result).toEqual({
      keysetReceiptSha256: Buffer.from(sha256("receipt"), "hex").toString("hex"),
      workerPublicKeySpkiSha256: runtimeSpkiSha256.toString("hex"),
      workerPublicKeySpkiBase64Url: runtimeSpki.toString("base64url"),
      signatureBase64Url: expect.any(String),
    });
    expect(
      verify(null, expectedPreimage, runtimeKey.publicKey, Buffer.from(result.signatureBase64Url, "base64url")),
    ).toBe(true);
  });

  it("fails closed on invalid pinned authority and returned key drift", async () => {
    const { protectedAuthority, runtime, runtimeSpkiSha256 } = fixture();
    const base = {
      proof: proof(runtimeSpkiSha256.toString("hex")),
      protectedAuthority,
    };

    await expect(
      signWindowsProtectedRemoteWorkerPopV2(
        "C:\\gc\\provisioner-client.exe",
        { ...base, protectedAuthority: { ...protectedAuthority, generation: 8 } },
        {},
        runtime,
      ),
    ).rejects.toThrow(/generation/u);
    await expect(
      signWindowsProtectedRemoteWorkerPopV2(
        "C:\\gc\\provisioner-client.exe",
        { ...base, protectedAuthority: { ...protectedAuthority, stateSha256: "00".repeat(32) } },
        {},
        runtime,
      ),
    ).rejects.toThrow(/protected state/u);
    expect(runtime.sign).not.toHaveBeenCalled();

    await expect(
      signWindowsProtectedRemoteWorkerPopV2(
        "C:\\gc\\provisioner-client.exe",
        { ...base, proof: proof(sha256("unprotected-key")) },
        {},
        runtime,
      ),
    ).rejects.toThrow(/authority drifted/u);
    expect(runtime.sign).toHaveBeenCalledOnce();
  });

  it("fails closed when the one-shot service reports rotation or returns a different receipt", async () => {
    const { protectedAuthority, receipt, runtime, runtimeSpkiSha256 } = fixture();
    const input = { proof: proof(runtimeSpkiSha256.toString("hex")), protectedAuthority };
    vi.mocked(runtime.sign).mockResolvedValueOnce({
      disposition: "keyset_unavailable",
      keysetReceiptSha256: Buffer.alloc(32),
      runtimeManifestSpkiSha256: Buffer.alloc(32),
      runtimeManifestSpki: Buffer.alloc(44),
      signature: Buffer.alloc(64),
    });
    await expect(
      signWindowsProtectedRemoteWorkerPopV2("C:\\gc\\provisioner-client.exe", input, {}, runtime),
    ).rejects.toThrow(/keyset_unavailable/u);

    const signed = await runtime.sign("C:\\gc\\provisioner-client.exe", {
      expectedStateSha256: Buffer.from(protectedAuthority.stateSha256, "hex"),
      expectedGeneration: 7n,
      expectedKeysetReceiptSha256: receipt,
      preimage: buildRemoteWorkerPopV2Preimage(input.proof),
    });
    vi.mocked(runtime.sign).mockResolvedValueOnce({
      ...(signed as WindowsProtectedSignRuntimePopV2Result),
      keysetReceiptSha256: Buffer.alloc(32, 0x7a),
    });
    await expect(
      signWindowsProtectedRemoteWorkerPopV2("C:\\gc\\provisioner-client.exe", input, {}, runtime),
    ).rejects.toThrow(/authority drifted/u);
  });
});
