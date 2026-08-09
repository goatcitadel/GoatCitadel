import { createHash, createPublicKey, verify } from "node:crypto";
import {
  REMOTE_WORKER_POP_V2_PREIMAGE_BYTES,
  buildRemoteWorkerPopV2Preimage,
  type RemoteWorkerPopV2Input,
} from "@goatcitadel/contracts";
import { signWindowsProtectedRuntimePopV2, type WindowsServiceClientRunOptions } from "./windows-service-client.js";
import type {
  WindowsProtectedSignRuntimePopV2Request,
  WindowsProtectedSignRuntimePopV2Result,
} from "./windows-helper-protocol.js";

export interface WindowsProtectedRemoteWorkerPopV2Input {
  /** Contract-owned purpose material. Only the closed ten-route v2 table is accepted. */
  readonly proof: RemoteWorkerPopV2Input;
  /** Authority pinned by the admitted protected-key owner before this one-shot call. */
  readonly protectedAuthority: {
    readonly stateSha256: string;
    readonly generation: number;
    readonly keysetReceiptSha256: string;
  };
}

export interface WindowsProtectedRemoteWorkerPopV2Signature {
  readonly keysetReceiptSha256: string;
  readonly workerPublicKeySpkiSha256: string;
  readonly workerPublicKeySpkiBase64Url: string;
  readonly signatureBase64Url: string;
}

export interface WindowsProtectedRuntimePopV2Runtime {
  readonly sign: (
    executablePath: string,
    request: WindowsProtectedSignRuntimePopV2Request,
    options?: WindowsServiceClientRunOptions,
  ) => Promise<WindowsProtectedSignRuntimePopV2Result>;
}

const productionRuntime: WindowsProtectedRuntimePopV2Runtime = {
  sign: signWindowsProtectedRuntimePopV2,
};

/**
 * Signs one contract-owned remote-worker PoP-v2 preimage with the active
 * protected runtime-manifest key. This module intentionally has no Gateway
 * caller: ingress remains dark until the remote-worker transport can supply
 * the TLS exporter and client-certificate bindings in production. It also
 * does not inspect, start, or restart the one-shot Windows service: an
 * administrator-owned runtime must make one service incarnation available,
 * and the admitted authority owner must pin the exact state, generation, and
 * receipt supplied here before activation.
 */
export async function signWindowsProtectedRemoteWorkerPopV2(
  executablePath: string,
  input: WindowsProtectedRemoteWorkerPopV2Input,
  options: WindowsServiceClientRunOptions = {},
  runtime: WindowsProtectedRuntimePopV2Runtime = productionRuntime,
): Promise<WindowsProtectedRemoteWorkerPopV2Signature> {
  const preimage = Buffer.from(buildRemoteWorkerPopV2Preimage(input.proof));
  if (preimage.byteLength !== REMOTE_WORKER_POP_V2_PREIMAGE_BYTES) {
    throw new Error("Windows protected remote-worker PoP-v2 preimage length drifted from the contract.");
  }
  const expectedState = decodeCanonicalSha256Hex(input.protectedAuthority.stateSha256, "protected state");
  const expectedReceipt = decodeCanonicalSha256Hex(input.protectedAuthority.keysetReceiptSha256, "keyset receipt");
  if (
    !Number.isSafeInteger(input.protectedAuthority.generation) ||
    input.protectedAuthority.generation <= 0 ||
    input.protectedAuthority.generation !== input.proof.workerGeneration
  ) {
    throw new Error("Windows protected remote-worker PoP-v2 worker generation drifted from the active keyset.");
  }
  const request: WindowsProtectedSignRuntimePopV2Request = {
    expectedStateSha256: expectedState,
    expectedGeneration: BigInt(input.protectedAuthority.generation),
    expectedKeysetReceiptSha256: expectedReceipt,
    preimage,
  };
  const result = await runtime.sign(executablePath, request, options);
  if (result.disposition !== "signed") {
    throw new Error(`Windows protected remote-worker PoP-v2 signer rejected the request: ${result.disposition}`);
  }
  const protectedKey = validateProtectedRuntimeManifestKey(result);
  if (
    !bytesEqual(result.keysetReceiptSha256, expectedReceipt) ||
    protectedKey.sha256 !== input.proof.workerPublicKeySpkiSha256
  ) {
    throw new Error("Windows protected remote-worker PoP-v2 signing authority drifted during the request.");
  }
  const signature = exactBytes(result.signature, 64, "signature", true);
  let verified: boolean;
  try {
    verified = verify(
      null,
      preimage,
      createPublicKey({ key: protectedKey.spki, format: "der", type: "spki" }),
      signature,
    );
  } catch (error) {
    throw new Error("Windows protected remote-worker PoP-v2 receipt is invalid.", { cause: error });
  }
  if (!verified) {
    throw new Error("Windows protected remote-worker PoP-v2 signature does not verify over the exact preimage.");
  }
  return {
    keysetReceiptSha256: Buffer.from(result.keysetReceiptSha256).toString("hex"),
    workerPublicKeySpkiSha256: protectedKey.sha256,
    workerPublicKeySpkiBase64Url: protectedKey.spki.toString("base64url"),
    signatureBase64Url: signature.toString("base64url"),
  };
}

function validateProtectedRuntimeManifestKey(result: WindowsProtectedSignRuntimePopV2Result): {
  readonly spki: Buffer;
  readonly sha256: string;
} {
  const spki = exactBytes(result.runtimeManifestSpki, 44, "runtime-manifest SPKI", true);
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  if (!spki.subarray(0, prefix.byteLength).equals(prefix)) {
    throw new Error("Windows protected remote-worker PoP-v2 runtime-manifest SPKI is not canonical Ed25519.");
  }
  const sha256 = createHash("sha256").update(spki).digest("hex");
  const claimedSha256 = exactBytes(result.runtimeManifestSpkiSha256, 32, "runtime-manifest SPKI hash", true).toString(
    "hex",
  );
  if (claimedSha256 !== sha256) {
    throw new Error("Windows protected remote-worker PoP-v2 runtime-manifest SPKI hash is invalid.");
  }
  return { spki, sha256 };
}

function decodeCanonicalSha256Hex(value: string, label: string): Buffer {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`Windows protected remote-worker PoP-v2 ${label} is invalid.`);
  }
  const bytes = Buffer.from(value, "hex");
  if (bytes.every((byte) => byte === 0)) {
    throw new Error(`Windows protected remote-worker PoP-v2 ${label} is invalid.`);
  }
  return bytes;
}

function exactBytes(value: Uint8Array, length: number, label: string, nonzero = false): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new Error(`Windows protected remote-worker PoP-v2 ${label} must be exactly ${String(length)} bytes.`);
  }
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (nonzero && bytes.every((byte) => byte === 0)) {
    throw new Error(`Windows protected remote-worker PoP-v2 ${label} must be populated.`);
  }
  return bytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}
