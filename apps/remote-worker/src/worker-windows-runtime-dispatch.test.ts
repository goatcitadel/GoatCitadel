import { describe, expect, it } from "vitest";
import { windowsRuntimeDispatchFixture as fixture } from "./worker-windows-runtime-dispatch-test-fixture.js";
import { bindWindowsRuntimeDispatch, encodeWindowsRuntimeDispatch, WINDOWS_RUNTIME_DISPATCH_MAX_BYTES } from "./worker-windows-runtime-dispatch.js";
import { encodeWindowsWorkerStdioLaunch } from "./worker-windows-stdio-codec.js";

describe("bound Windows runtime dispatch", () => {
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
