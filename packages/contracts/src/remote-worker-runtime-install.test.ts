import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION as schemaVersion,
  encodeRemoteWorkerRuntimeInstallRequest as encode,
  decodeRemoteWorkerRuntimeInstallRequest as decode,
  normalizeRemoteWorkerRuntimeInstallRequest as normalize,
  remoteWorkerRuntimeInstallRequestSha256 as hash,
} from "./remote-worker-runtime-install.js";
import { REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION } from "./remote-worker-runtime-bundle.js";

const input = () => ({ schemaVersion, nonce: "11".repeat(32), journalIdentityHex: "22".repeat(24),
  preparedSha256: "33".repeat(32), checkpointSha256: "44".repeat(32), packageSha256: "55".repeat(32),
  runtimeBundle: { schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files: [
    { relativePath: "node.exe", bytes: 123456, sha256: "66".repeat(32) },
    { relativePath: "worker-host-receipt.json", bytes: 789, sha256: "77".repeat(32) },
  ] },
});
const digest = (bytes: Uint8Array) => createHash("sha256").update(`${schemaVersion}\0`).update(bytes).digest("hex");
const bound = (value = input()) => ({ nonce: value.nonce, requestSha256: hash(value) });

describe("runtime installation binding", () => {
  it("round trips the fixed layout and independently hashed domain", () => {
    const value = input(), bytes = encode(value);
    expect(bytes.length).toBe(272);
    expect(Buffer.from(bytes.subarray(0, 8)).toString()).toBe("GCRINST1");
    expect(new DataView(bytes.buffer).getBigUint64(192, true)).toBe(123456n);
    expect(new DataView(bytes.buffer).getBigUint64(232, true)).toBe(789n);
    expect(hash(value)).toBe(digest(bytes));
    expect(decode(bytes, bound(value))).toEqual(value);
    const decoded = decode(bytes, bound(value));
    expect(Object.isFrozen(decoded.runtimeBundle.files[0])).toBe(true);
    bytes.fill(0);
    expect(decoded.nonce).toBe(value.nonce);
  });

  it("rejects every altered byte, truncation and extra bytes against independent admission", () => {
    const bytes = encode(input()), expected = bound();
    for (let index = 0; index < bytes.length; index++) {
      const changed = bytes.slice(); changed[index]! ^= 1;
      expect(() => decode(changed, expected)).toThrow();
      expect(() => decode(bytes.slice(0, index), expected)).toThrow();
    }
    expect(() => decode(new Uint8Array([...bytes, 0]), expected)).toThrow();
    expect(() => decode(bytes, { ...expected, nonce: "88".repeat(32) })).toThrow();
  });

  it("rejects malformed fields even when an independently supplied digest matches", () => {
    const patches: ((bytes: Uint8Array) => void)[] = [
      (b) => { b[0] = 0; }, (b) => b.fill(0, 40, 48), (b) => b.fill(0, 48, 64),
      (b) => b.fill(0, 64, 96), (b) => b.fill(0, 96, 128), (b) => b.fill(0, 128, 160),
      (b) => b.fill(0, 160, 192), (b) => b.fill(0, 192, 200), (b) => b.fill(255, 192, 200),
      (b) => b.fill(0, 200, 232), (b) => b.fill(0, 232, 240), (b) => b.fill(0, 240, 272),
      (b) => { b[200]! ^= 1; },
    ];
    for (const patch of patches) {
      const bytes = encode(input()); patch(bytes);
      expect(() => decode(bytes, { nonce: input().nonce, requestSha256: digest(bytes) })).toThrow();
    }
  });

  it("rejects arbitrary payloads, unsupported runtimes and accessor properties without evaluating them", () => {
    expect(() => normalize({ ...input(), command: "execute" })).toThrow();
    const getter = vi.fn(() => input().nonce), value = input();
    Object.defineProperty(value, "nonce", { enumerable: true, get: getter });
    expect(() => normalize(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
    const unsupported = input(); unsupported.runtimeBundle.files[0]!.relativePath = "pwsh.exe";
    expect(() => normalize(unsupported)).toThrow();
    const missing = input(); missing.runtimeBundle.files.pop();
    expect(() => normalize(missing)).toThrow();
    expect(() => normalize({ ...input(), nonce: "AB".repeat(32) })).toThrow();
    expect(() => normalize(Object.assign(Object.create({ inherited: true }), input()))).toThrow();
  });
});
