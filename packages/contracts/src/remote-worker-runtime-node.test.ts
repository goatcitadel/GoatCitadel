import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { remoteWorkerRuntimeBundleManifestSha256 } from "./remote-worker-runtime-bundle.js";
import { bindWindowsRuntimeDispatch, encodeWindowsRuntimeDispatch, prepareWindowsRuntimeDispatch, normalizeWindowsRuntimeDispatch, WINDOWS_RUNTIME_DISPATCH_MAX_BYTES } from "./remote-worker-runtime-node.js";
import { encodeWindowsWorkerStdioLaunch } from "./remote-worker-runtime-node.js";

function fixture() {
  const jobName = `gc-cell-${"1".repeat(32)}`, root = `C:\\cells\\${jobName}`;
  const identity = (digit: string) => "1".repeat(16) + digit.repeat(32);
  const runtimeBundle = { schemaVersion: "goatcitadel.worker-runtime-bundle.v1" as const,
    files: [{ relativePath: "entry.exe", bytes: 3, sha256: "a".repeat(64) }] };
  return { nonce: "9".repeat(64), anchor: { fileIdentity: identity("6"), preparedSha256: "7".repeat(64) }, checkpointSha256: "8".repeat(64),
    inventoryLimits: { maxEntries: 20000, maxDepth: 64, wallMs: 10000 },
    launch: { jobName, appContainerName: `GoatCitadel.Worker.${"1".repeat(32)}`, image: `${root}\\runtime\\entry.exe`,
      commandLine: `"${root}\\runtime\\entry.exe" serve`, directory: `${root}\\work`, runtimeRoot: `${root}\\runtime`,
      imageSha256: "a".repeat(64), directoryIdentity: identity("5"), runtimeRootIdentity: identity("4"), runtimeBundle,
      runtimeBundleSha256: remoteWorkerRuntimeBundleManifestSha256(runtimeBundle), environment: { SystemRoot: "C:\\Windows" },
      limits: { processLimit: 1, memoryBytes: 64 * 1024 * 1024, cpuMilli: 1000, wallMs: 150000, rawOutputBytes: 65536, diagnosticBytes: 1024, inputBytes: 4096 },
      protectedWorkspace: { parentPath: "C:\\cells", parentIdentity: identity("1"), rootIdentity: identity("2"), controlIdentity: identity("3"),
        runtimeIdentity: identity("4"), workIdentity: identity("5"), ownerSid: "S-1-5-21-1-2-3-1001", controllerSid: "S-1-5-80-1-2-3-4-5" } } };
}
describe("bound Windows runtime dispatch", () => {
  it("binds selected paths and byte ceilings to the exact approved request", () => {
    const fileStaging = { paths: ["report.txt", "nested/result.json"], maximumFileBytes: 1024, maximumTotalBytes: 2048 };
    const input = { ...fixture(), fileStaging }, normalized = normalizeWindowsRuntimeDispatch(input);
    const prepared = prepareWindowsRuntimeDispatch(normalized), { bytes, binding } = prepared;
    const offset = 144 + bytes.readUInt32LE(140);
    expect(bytes.subarray(0, 8).toString()).toBe("GCRUN002");
    expect(offset).toBe(935);
    expect(bytes.subarray(offset, offset + 8).toString()).toBe("GCFPLAN1");
    expect(bytes.length).toBe(991);
    expect(binding.requestSha256).toBe("1783e213b609cfe59493ad9c4eaaebd1b0119b8312ad54e68a9ac35753544040");
    expect(bindWindowsRuntimeDispatch(bytes, binding)).toEqual(bytes);
    expect(prepared.expectation.requestSha256).toBe(binding.requestSha256);
    expect(Object.keys(prepared.expectation)).not.toContain("fileStaging");
    for (let index = 0; index < bytes.length; ++index) {
      const changed = Buffer.from(bytes); changed[index] = changed[index]! ^ 1;
      expect(() => bindWindowsRuntimeDispatch(changed, binding)).toThrow();
    }
    input.fileStaging.paths[0] = "unreviewed.txt";
    expect(prepareWindowsRuntimeDispatch(normalized).binding).toEqual(binding);
    expect(prepareWindowsRuntimeDispatch(input).binding).not.toEqual(binding);
    for (const changes of [{ maximumFileBytes: 1025 }, { maximumTotalBytes: 2049 }])
      expect(prepareWindowsRuntimeDispatch({ ...normalized, fileStaging: { ...normalized.fileStaging, ...changes } }).binding).not.toEqual(binding);
  });
  it("rejects malformed collection trailers even with a matching recomputed digest", () => {
    const prepared = prepareWindowsRuntimeDispatch({ ...fixture(), fileStaging: { paths: ["file.txt"], maximumFileBytes: 1024, maximumTotalBytes: 2048 } });
    const offset = 144 + prepared.bytes.readUInt32LE(140);
    const invalid: Buffer[] = [prepared.bytes.subarray(0, offset), Buffer.concat([prepared.bytes, Buffer.from([0])])];
    for (const [position, number] of [[offset + 8, 0], [offset + 8, 65], [offset + 12, 0], [offset + 16, 67108865], [offset + 20, 513]] as const) {
      const bytes = Buffer.from(prepared.bytes); bytes.writeUInt32LE(number, position); invalid.push(bytes);
    }
    const malformedUtf8 = Buffer.from(prepared.bytes); malformedUtf8[offset + 24] = 255; invalid.push(malformedUtf8);
    const legacy = Buffer.from(prepared.bytes); legacy.write("GCRUN001"); invalid.push(legacy);
    for (const bytes of invalid) {
      const requestSha256 = createHash("sha256").update("goatcitadel.worker-runtime-dispatch.v1\0").update(bytes).digest("hex");
      expect(() => bindWindowsRuntimeDispatch(bytes, { ...prepared.binding, requestSha256 })).toThrow();
    }
  });
  it("exposes an immutable normalized request for canonical admission checks", () => {
    const input = fixture(), normalized = normalizeWindowsRuntimeDispatch(input);
    const approved = encodeWindowsRuntimeDispatch(normalized);
    input.launch.commandLine += " changed";
    input.launch.limits.processLimit = 2;
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.anchor)).toBe(true);
    expect(Object.isFrozen(normalized.launch.limits)).toBe(true);
    expect(encodeWindowsRuntimeDispatch(normalized)).toEqual(approved);
    expect(encodeWindowsRuntimeDispatch(input).binding).not.toEqual(approved.binding);
  });
  it("derives only retention metadata from the exact copied executable request", () => {
    const input = fixture();
    input.launch.environment = { SystemRoot: "C:\\Windows", ...{ PRIVATE_VALUE: "test-only-sensitive-value" } };
    const prepared = prepareWindowsRuntimeDispatch(input);
    expect(prepared.expectation).toEqual({ ...prepared.binding,
      checkpointSha256: input.checkpointSha256, runtimeBundleSha256: input.launch.runtimeBundleSha256,
      maxInputBytes: 4096, maxOutputBytes: 65536, maxInventoryEntries: 20000 });
    expect(JSON.stringify(prepared.expectation)).not.toContain("test-only-sensitive-value");
    expect(JSON.stringify(prepared.expectation)).not.toContain("commandLine");
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.expectation)).toBe(true);
    const bound = bindWindowsRuntimeDispatch(prepared.bytes, prepared.binding);
    input.launch.commandLine += " unreviewed";
    input.launch.limits.inputBytes = 0;
    expect(prepared.expectation.maxInputBytes).toBe(4096);
    prepared.bytes.fill(0);
    expect(() => bindWindowsRuntimeDispatch(prepared.bytes, prepared.binding)).toThrow();
    expect(bindWindowsRuntimeDispatch(bound, prepared.binding)).toEqual(bound);
  });
  it("refuses executable getters, proxies, cycles and forged expectations before serialization", () => {
    let called = false;
    const trap = () => { called = true; throw new Error("caller must not run"); };
    const getter = Object.defineProperty(fixture(), "launch", { enumerable: true, get: trap });
    const proxy = new Proxy(fixture(), { ownKeys: trap, getPrototypeOf: trap, get: trap });
    const cycle = { ...fixture(), cycle: {} }; cycle.cycle = cycle;
    for (const input of [getter, proxy, cycle, { ...fixture(), expectation: { approved: true } }])
      expect(() => prepareWindowsRuntimeDispatch(input)).toThrow();
    expect(called).toBe(false);
  });
  it("does not prepare retention authority for a mismatched bundle or workspace", () => {
    const input = fixture();
    expect(() => prepareWindowsRuntimeDispatch({ ...input, launch: { ...input.launch,
      runtimeBundleSha256: "f".repeat(64) } })).toThrow();
    expect(() => prepareWindowsRuntimeDispatch({ ...input, launch: { ...input.launch,
      protectedWorkspace: { ...input.launch.protectedWorkspace, workIdentity: "f".repeat(48) } } })).toThrow();
  });
  it("binds the complete protected launch and journal reference with an independent nonce and digest", () => {
    const result = encodeWindowsRuntimeDispatch(fixture());
    expect(result.bytes.subarray(0, 8).toString("ascii")).toBe("GCRUN001");
    expect(result.bytes.readUInt32LE(140)).toBe(result.bytes.length - 144);
    expect(result.bytes.subarray(144, 152).toString("ascii")).toBe("GCSTDIO2");
    expect(result.bytes.readUInt32LE(152)).toBe(result.bytes.length - 156);
    expect(result.bytes.length).toBe(935);
    expect(result.binding.requestSha256).toBe("9e914f87f794f1de2e53a0bc5d96a63cd21c0094e797ad0caaee04bad9bc8c03");
    expect(bindWindowsRuntimeDispatch(result.bytes, result.binding)).toEqual(result.bytes);
    expect(Object.isFrozen(result.binding)).toBe(true);
  });
  it("rejects substitution across every byte of the captured request", () => {
    const { bytes, binding } = encodeWindowsRuntimeDispatch(fixture());
    for (let index = 0; index < bytes.length; ++index) {
      const changed = Buffer.from(bytes); changed[index] = changed[index]! ^ 1;
      expect(() => bindWindowsRuntimeDispatch(changed, binding)).toThrow();
    }
    expect(() => bindWindowsRuntimeDispatch(bytes, { ...binding, nonce: "a".repeat(64) })).toThrow();
    expect(() => bindWindowsRuntimeDispatch(bytes, { ...binding, requestSha256: "0".repeat(64) })).toThrow();
    const forged = { ...binding, approved: true };
    expect(() => bindWindowsRuntimeDispatch(bytes, forged)).toThrow();
  });
  it("freezes request fields and transport bytes independently of caller mutation", () => {
    const input = fixture(), { bytes, binding } = encodeWindowsRuntimeDispatch(input);
    input.launch.commandLine += " unreviewed"; input.launch.limits.memoryBytes *= 2; input.anchor.preparedSha256 = "e".repeat(64);
    const bound = bindWindowsRuntimeDispatch(bytes, binding);
    bytes.fill(0);
    expect(bindWindowsRuntimeDispatch(bound, binding)).toEqual(bound);
  });
  it("permits long admitted runtime requests while preserving the local stdio deadline", () => {
    const input = fixture();
    expect(() => encodeWindowsWorkerStdioLaunch(input.launch)).toThrow();
    expect(() => encodeWindowsRuntimeDispatch(input)).not.toThrow();
    input.launch.limits.wallMs = 86_400_001;
    expect(() => encodeWindowsRuntimeDispatch(input)).toThrow();
  });
  it("rejects an unprotected launch and invalid journal identities or read bounds", () => {
    const input = fixture();
    for (const anchor of [{ ...input.anchor, fileIdentity: "0".repeat(16) + "1".repeat(32) },
      { ...input.anchor, fileIdentity: "1".repeat(16) + "0".repeat(32) }, { ...input.anchor, preparedSha256: "0".repeat(64) }])
      expect(() => encodeWindowsRuntimeDispatch({ ...input, anchor })).toThrow();
    for (const changes of [{ maxEntries: 20001 }, { maxDepth: 65 }, { wallMs: 60001 }, { wallMs: 0 }, { maxDepth: 0.5 }])
      expect(() => encodeWindowsRuntimeDispatch({ ...input, inventoryLimits: { ...input.inventoryLimits, ...changes } })).toThrow();
    const { protectedWorkspace: _unused, ...unprotected } = input.launch;
    expect(() => encodeWindowsRuntimeDispatch({ ...input, launch: unprotected })).toThrow();
    expect(() => encodeWindowsRuntimeDispatch({ ...input, nonce: "0".repeat(64) })).toThrow();
    expect(() => encodeWindowsRuntimeDispatch({ ...input, requestSha256: "a".repeat(64) })).toThrow();
  });
  it("rejects getters before preparing executable bytes", () => {
    let called = false;
    const input = { ...fixture(), get launch() { called = true; return fixture().launch; } };
    expect(() => encodeWindowsRuntimeDispatch(input)).toThrow();
    expect(called).toBe(false);
  });
  it("rejects truncated, trailing and oversized transport frames", () => {
    const { bytes, binding } = encodeWindowsRuntimeDispatch(fixture());
    for (const size of [0, 143, 156, bytes.length - 1]) expect(() => bindWindowsRuntimeDispatch(bytes.subarray(0, size), binding)).toThrow();
    expect(() => bindWindowsRuntimeDispatch(Buffer.concat([bytes, Buffer.alloc(1)]), binding)).toThrow();
    expect(() => bindWindowsRuntimeDispatch(Buffer.alloc(WINDOWS_RUNTIME_DISPATCH_MAX_BYTES + 1), binding)).toThrow();
  });
});
