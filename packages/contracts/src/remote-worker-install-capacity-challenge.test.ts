import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { assertRemoteWorkerInstallCapacityChallenge, encodeRemoteWorkerInstallCapacityChallenge,
  hashRemoteWorkerInstallCapacityCapture, normalizeRemoteWorkerInstallCapacityBinding } from "./remote-worker-install-capacity-challenge.js";
import { REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES } from "./remote-worker-native-pool-capacity-response.js";

const capture = Uint8Array.from({ length: 1013 }, (_, i) => i % 251);
const binding = { connectionNonceHex: "11".repeat(32), installationNonce: "22".repeat(32), requestSha256: "33".repeat(32),
  captureSha256: hashRemoteWorkerInstallCapacityCapture(capture), byteLength: capture.length };
describe("live installation capacity challenge", () => {
  it("hashes, encodes and checks the same protocol without Node globals", () => {
    const expected = encodeRemoteWorkerInstallCapacityChallenge(binding, 65536);
    vi.stubGlobal("Buffer", undefined);
    try {
      expect(hashRemoteWorkerInstallCapacityCapture(capture)).toBe(binding.captureSha256);
      const encoded = encodeRemoteWorkerInstallCapacityChallenge(binding, 65536);
      expect(encoded).toEqual(expected);
      assertRemoteWorkerInstallCapacityChallenge(encoded, binding, 65536);
      encoded[143] = 1;
      expect(() => assertRemoteWorkerInstallCapacityChallenge(encoded, binding, 65536)).toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("matches independent bytes and domain-separated capture hashing", () => {
    expect(binding.captureSha256).toBe(createHash("sha256").update(Buffer.concat([
      Buffer.from("goatcitadel.worker-install-capacity-capture.v1\0"), Buffer.from(capture) ])).digest("hex"));
    for (const ordinal of [1, 65536]) {
      const expected = Buffer.alloc(144);
      expected.fill(0x11, 0, 32); expected.fill(0x22, 32, 64); expected.fill(0x33, 64, 96);
      Buffer.from(binding.captureSha256, "hex").copy(expected, 96);
      expected.writeUInt32LE(ordinal, 128); expected.writeUInt32LE(1, 132); expected.writeUInt32LE(1013, 136);
      expect(Buffer.from(encodeRemoteWorkerInstallCapacityChallenge(binding, ordinal))).toEqual(expected);
      expect(() => assertRemoteWorkerInstallCapacityChallenge(expected, binding, ordinal)).not.toThrow();
    }
  });
  it("rejects every changed byte, truncation, trailing bytes and replayed ordinal", () => {
    const bytes = encodeRemoteWorkerInstallCapacityChallenge(binding, 2);
    for (let i = 0; i < bytes.length; ++i) {
      const changed = bytes.slice(); changed[i] = changed[i]! ^ 1;
      expect(() => assertRemoteWorkerInstallCapacityChallenge(changed, binding, 2)).toThrow();
      expect(() => assertRemoteWorkerInstallCapacityChallenge(bytes.subarray(0, i), binding, 2)).toThrow();
    }
    expect(() => assertRemoteWorkerInstallCapacityChallenge(Buffer.concat([bytes, Buffer.alloc(1)]), binding, 2)).toThrow();
    expect(() => assertRemoteWorkerInstallCapacityChallenge(bytes, binding, 1)).toThrow();
    expect(() => assertRemoteWorkerInstallCapacityChallenge(bytes, { ...binding, connectionNonceHex: "44".repeat(32) }, 2)).toThrow();
    const disguised = bytes.slice(); disguised[0] = disguised[0]! ^ 1;
    Object.defineProperty(disguised, "length", { value: 0 });
    expect(() => assertRemoteWorkerInstallCapacityChallenge(disguised, binding, 2)).toThrow();
  });
  it("rejects missing/extra/accessor fields and out-of-bound counters without reading getters", () => {
    for (const field of ["connectionNonceHex", "installationNonce", "requestSha256", "captureSha256"] as const)
      for (const bad of ["00".repeat(32), "AA".repeat(32), "", null])
        expect(() => normalizeRemoteWorkerInstallCapacityBinding({ ...binding, [field]: bad } as typeof binding)).toThrow();
    for (const byteLength of [0, -1, 1.5, REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES + 1])
      expect(() => normalizeRemoteWorkerInstallCapacityBinding({ ...binding, byteLength })).toThrow();
    for (const ordinal of [0, -1, 1.5, 65537, NaN]) expect(() => encodeRemoteWorkerInstallCapacityChallenge(binding, ordinal)).toThrow();
    let reads = 0; const accessor = { ...binding };
    Object.defineProperty(accessor, "requestSha256", { get() { reads++; return binding.requestSha256; } });
    expect(() => normalizeRemoteWorkerInstallCapacityBinding(accessor)).toThrow(); expect(reads).toBe(0);
    expect(() => normalizeRemoteWorkerInstallCapacityBinding({ ...binding, extra: 1 } as typeof binding)).toThrow();
    expect(() => hashRemoteWorkerInstallCapacityCapture(new Uint8Array())).toThrow();
    expect(() => hashRemoteWorkerInstallCapacityCapture(new Uint8Array(REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES + 1))).toThrow();
  });
  it("returns a frozen independent binding and hashes every payload byte", () => {
    const supplied = { ...binding }, retained = normalizeRemoteWorkerInstallCapacityBinding(supplied);
    supplied.installationNonce = "44".repeat(32);
    expect(Object.isFrozen(retained)).toBe(true); expect(retained).toEqual(binding);
    for (const index of [0, 500, 1012]) {
      const changed = capture.slice(); changed[index] = changed[index]! ^ 1;
      expect(hashRemoteWorkerInstallCapacityCapture(changed)).not.toBe(binding.captureSha256);
    }
  });
});
