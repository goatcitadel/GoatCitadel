import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION,
  normalizeRemoteWorkerRuntimeBundleManifest,
  remoteWorkerRuntimeBundleManifestBytes,
  remoteWorkerRuntimeBundleManifestSha256,
} from "./remote-worker-runtime-bundle.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const file = (relativePath: string, text = "") => ({ relativePath, bytes: Buffer.byteLength(text), sha256: hash(text) });
const manifest = (files = [file("a.txt", "abc"), file("lib/empty.txt")]) => ({ schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files });

describe("native runtime bundle manifest", () => {
  it("matches the independently executed native and Node binary digest vector", () => {
    const bytes = remoteWorkerRuntimeBundleManifestBytes(manifest());
    const digest = "a24c402af69c2d0de4a70c5d82cc946b47f73e202df216f68a57ee0adf989e78";
    expect(hash(REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION)).not.toBe(digest);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
    expect(remoteWorkerRuntimeBundleManifestSha256(manifest())).toBe(digest);
  });

  it("snapshots metadata and binds every byte size, path and digest", () => {
    const input = manifest();
    const normalized = normalizeRemoteWorkerRuntimeBundleManifest(input);
    const original = remoteWorkerRuntimeBundleManifestSha256(normalized);
    expect(Object.isFrozen(normalized.files[0])).toBe(true);
    input.files[0]!.bytes++;
    expect(normalized.files[0]!.bytes).toBe(3);
    expect(remoteWorkerRuntimeBundleManifestSha256(input)).not.toBe(original);
    expect(remoteWorkerRuntimeBundleManifestSha256(manifest([file("b.txt", "abc"), file("lib/empty.txt")]))).not.toBe(original);
    expect(remoteWorkerRuntimeBundleManifestSha256(manifest([file("a.txt", "xyz"), file("lib/empty.txt")]))).not.toBe(original);
  });

  it.each(["", "/entry.exe", "../entry.exe", "dir/../entry.exe", "dir//entry.exe", "dir/", "C:/entry.exe",
    "entry.exe:stream", "NUL.txt", "COM1.exe", "entry.exe.", "entry.exe ", "dir\\entry.exe", "nonascii-é.txt"])(
    "rejects native alias or unsupported path %s", (name) => {
      expect(() => normalizeRemoteWorkerRuntimeBundleManifest(manifest([file(name)]))).toThrow();
    },
  );

  it.each([[file("b"), file("a")], [file("a"), file("a")], [file("Dir/a"), file("dir/b")], [file("a"), file("a/b")]])(
    "rejects unordered, duplicate, case-colliding and conflicting nodes", (...files) => {
      expect(() => normalizeRemoteWorkerRuntimeBundleManifest(manifest(files))).toThrow();
    },
  );

  it("rejects malformed and oversized inventories", () => {
    for (const input of [manifest([]), manifest(Array.from({ length: 4097 }, (_, index) => file(String(index)))),
      manifest([{ ...file("a"), bytes: -1 }]), manifest([{ ...file("a"), bytes: 0.5 }]),
      manifest([{ ...file("a"), bytes: 256 * 1024 * 1024 + 1 }]),
      manifest(["a", "b", "c", "d", "e"].map((name) => ({ ...file(name), bytes: 256 * 1024 * 1024 }))),
      manifest([{ ...file("a"), sha256: "A".repeat(64) }]), { ...manifest(), callerApproved: true },
      { ...manifest(), schemaVersion: "future" }, { ...manifest(), files: [{ ...file("a"), executable: true }] },
      manifest(Array.from({ length: 2049 }, (_, index) => file(`d${String(index).padStart(4, "0")}/inner/a`)))])
      expect(() => normalizeRemoteWorkerRuntimeBundleManifest(input)).toThrow();
  });

  it("rejects accessor-bearing entries and sparse/custom arrays before invoking them", () => {
    const get = vi.fn(() => "a.txt");
    const input = manifest();
    Object.defineProperty(input.files[0], "relativePath", { get, enumerable: true });
    expect(() => normalizeRemoteWorkerRuntimeBundleManifest(input)).toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(() => normalizeRemoteWorkerRuntimeBundleManifest(manifest(new Array(1)))).toThrow();
    const custom = [file("a")]; Object.setPrototypeOf(custom, Object.create(Array.prototype));
    expect(() => normalizeRemoteWorkerRuntimeBundleManifest(manifest(custom))).toThrow();
  });
});
