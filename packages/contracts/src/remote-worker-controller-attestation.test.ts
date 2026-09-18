import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encodeRemoteWorkerControllerAttestation, hashRemoteWorkerControllerPublicKey,
  normalizeRemoteWorkerControllerAttestation, normalizeRemoteWorkerControllerEnrollment } from "./remote-worker-controller-attestation.js";

const hex = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const input = { keySha256: hex(1), controllerInstanceHex: hex(2), authoritySha256: hex(3), challengeNonceHex: hex(4),
  installationNonce: hex(5), requestSha256: hex(6), ordinal: 513,
  window: { nonce: hex(7), connectionNonceHex: hex(8), poolSnapshotSha256: hex(9), hostCaptureSha256: hex(10), membersSha256: hex(11), referencesSha256: hex(12) } };
describe("native controller attestation wire", () => {
  it("snapshots the operator pin and refuses changed fingerprints or accessor enrollment", () => {
    const publicPointHex = `04${hex(1)}${hex(2)}`;
    const pin = { publicPointHex, keySha256: hashRemoteWorkerControllerPublicKey(publicPointHex) };
    const normalized = normalizeRemoteWorkerControllerEnrollment(pin);
    expect(normalized).toEqual(pin);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(normalized).not.toBe(pin);
    let invoked = false;
    for (const value of [null, { ...pin, keySha256: hex(3) }, { ...pin, extra: true },
      { ...pin, get publicPointHex() { invoked = true; return publicPointHex; } }])
      expect(() => normalizeRemoteWorkerControllerEnrollment(value)).toThrow();
    expect(invoked).toBe(false);
  });
  it("pins the version, little-endian ordinal and every exact digest offset", () => {
    const bytes = Buffer.from(encodeRemoteWorkerControllerAttestation(input));
    expect(bytes.length).toBe(396);
    expect(bytes.subarray(0, 8).toString("ascii")).toBe("GCCATT01");
    expect(bytes.readUInt32LE(8)).toBe(513);
    for (let index = 0; index < 12; index++) expect(bytes.subarray(12 + index * 32, 44 + index * 32).toString("hex")).toBe(hex(index + 1));
  });
  it("uses no Node globals and snapshots the nested native window", () => {
    const expected = encodeRemoteWorkerControllerAttestation(input);
    vi.stubGlobal("Buffer", undefined);
    try { expect(encodeRemoteWorkerControllerAttestation(input)).toEqual(expected); } finally { vi.unstubAllGlobals(); }
    const normalized = normalizeRemoteWorkerControllerAttestation(input);
    expect(normalized.window).not.toBe(input.window);
    expect(Object.isFrozen(normalized.window)).toBe(true);
  });
  it("rejects unknown fields, getters, invalid digests and ordinals", () => {
    let invoked = false;
    const getter = { ...input, get keySha256() { invoked = true; return hex(1); } };
    for (const value of [{ ...input, extra: true }, getter, { ...input, keySha256: hex(0) },
      ...[0, -1, 65537, 1.5, NaN].map(ordinal => ({ ...input, ordinal }))]) {
      expect(() => normalizeRemoteWorkerControllerAttestation(value)).toThrow();
    }
    expect(invoked).toBe(false);
  });
  it("domain-separates the public key fingerprint", () => {
    const point = `04${hex(1)}${hex(2)}`;
    expect(hashRemoteWorkerControllerPublicKey(point)).toBe(createHash("sha256")
      .update("goatcitadel.controller-attestation-key.v1\0").update(Buffer.from(point, "hex")).digest("hex"));
    expect(() => hashRemoteWorkerControllerPublicKey(`02${hex(1)}`)).toThrow();
  });
});
