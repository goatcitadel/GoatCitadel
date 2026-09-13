import { describe, expect, it } from "vitest";
import { remoteWorkerRuntimeBundleManifestSha256 } from "@goatcitadel/contracts";
import { decodeWindowsWorkerStdioCompletion, encodeWindowsWorkerStdioFrame, encodeWindowsWorkerStdioLaunch,
  normalizeWindowsWorkerStdioLaunch, type WindowsWorkerStdioLaunch } from "./worker-windows-stdio-codec.js";

const fixture = (): WindowsWorkerStdioLaunch => {
  const runtimeBundle = { schemaVersion: "goatcitadel.worker-runtime-bundle.v1" as const,
    files: [{ relativePath: "entry.exe", bytes: 3, sha256: "a".repeat(64) }] };
  return { jobName: `gc-cell-${"1".repeat(32)}`, appContainerName: `GoatCitadel.Worker.${"1".repeat(32)}`,
    image: "C:\\runtime\\entry.exe", commandLine: '"C:\\runtime\\entry.exe" serve', directory: "C:\\work", runtimeRoot: "C:\\runtime",
    imageSha256: "a".repeat(64), directoryIdentity: "1".repeat(48), runtimeRootIdentity: "2".repeat(48), runtimeBundle,
    runtimeBundleSha256: remoteWorkerRuntimeBundleManifestSha256(runtimeBundle), environment: { SystemRoot: "C:\\Windows" },
    limits: { processLimit: 1, memoryBytes: 64 * 1024 * 1024, cpuMilli: 1000, wallMs: 5000, rawOutputBytes: 65536, diagnosticBytes: 1024, inputBytes: 4096 } };
};
const protectedFixture = (): WindowsWorkerStdioLaunch => {
  const input = fixture();
  const identity = (value: string) => "1".repeat(16) + value.repeat(32);
  const root = `C:\\cells\\${input.jobName}`;
  return { ...input, image: `${root}\\runtime\\entry.exe`, commandLine: `"${root}\\runtime\\entry.exe" serve`,
    directory: `${root}\\work`, runtimeRoot: `${root}\\runtime`, directoryIdentity: identity("5"), runtimeRootIdentity: identity("4"),
    protectedWorkspace: { parentPath: "C:\\cells", parentIdentity: identity("1"), rootIdentity: identity("2"), controlIdentity: identity("3"),
      runtimeIdentity: identity("4"), workIdentity: identity("5"), ownerSid: "S-1-5-21-1-2-3-1001", controllerSid: "S-1-5-80-1-2-3-4-5" } };
};
describe("native worker stdio configuration boundary", () => {
  it("encodes a separate protected mode with independently recorded roots", () => {
    const input = protectedFixture();
    const frozen = normalizeWindowsWorkerStdioLaunch(input);
    const encoded = encodeWindowsWorkerStdioLaunch(input);
    expect(encoded.subarray(0, 8).toString("ascii")).toBe("GCSTDIO2");
    expect(encoded.readUInt32LE(8)).toBe(encoded.length - 12);
    const workspace = input.protectedWorkspace!;
    expect(encoded.subarray(-120)).toEqual(Buffer.from([workspace.parentIdentity, workspace.rootIdentity, workspace.controlIdentity,
      workspace.runtimeIdentity, workspace.workIdentity].join(""), "hex"));
    Object.assign(workspace, { ownerSid: "S-1-1-0" });
    expect(Object.isFrozen(frozen.protectedWorkspace)).toBe(true);
    expect(encodeWindowsWorkerStdioLaunch(frozen)).toEqual(encoded);
    expect(() => encodeWindowsWorkerStdioLaunch(input)).toThrow();
  });
  it("refuses invalid, ambiguous or cross-workspace identity records", () => {
    const input = protectedFixture(), workspace = input.protectedWorkspace!;
    for (const changes of [{ parentIdentity: "0".repeat(48) }, { rootIdentity: "1".repeat(16) + "0".repeat(32) },
      { rootIdentity: workspace.controlIdentity }, { parentIdentity: "a".repeat(48) }, { workIdentity: workspace.runtimeIdentity },
      { ownerSid: "S-1-1-0" }, { controllerSid: "S-1-5-32-544" }, { parentPath: "cells" }, { authority: "approved" }])
      expect(() => encodeWindowsWorkerStdioLaunch({ ...input, protectedWorkspace: { ...workspace, ...changes } })).toThrow();
    expect(() => encodeWindowsWorkerStdioLaunch({ ...input, directoryIdentity: workspace.controlIdentity })).toThrow();
    expect(() => encodeWindowsWorkerStdioLaunch({ ...input, runtimeRootIdentity: workspace.rootIdentity })).toThrow();
  });
  it("freezes reviewed configuration and emits its explicit binary envelope", () => {
    const input = fixture();
    const snapshot = normalizeWindowsWorkerStdioLaunch(input);
    const encoded = encodeWindowsWorkerStdioLaunch(snapshot);
    expect(encoded.subarray(0, 8).toString("ascii")).toBe("GCSTDIO1");
    expect(encoded.readUInt32LE(8)).toBe(encoded.length - 12);
    expect(encoded.readUInt32LE(12)).toBe(40);
    expect(Object.isFrozen(snapshot.limits)).toBe(true);
    expect(Object.isFrozen(snapshot.runtimeBundle.files)).toBe(true);
    Object.assign(input.limits, { wallMs: 1 });
    expect(snapshot.limits.wallMs).toBe(5000);
    expect(encodeWindowsWorkerStdioLaunch(snapshot)).toEqual(encoded);
  });
  it.each(["appContainerName", "imageSha256", "runtimeBundleSha256", "directoryIdentity", "runtimeRootIdentity", "image", "extra"])("refuses changed or unknown %s authority", (field) => {
    expect(() => encodeWindowsWorkerStdioLaunch({ ...fixture(), [field]: "unreviewed" })).toThrow();
  });
  it.each(["wallMs", "processLimit", "rawOutputBytes", "inputBytes", "memoryBytes"])("does not enlarge invalid %s limits", (field) => {
    const input = fixture();
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => encodeWindowsWorkerStdioLaunch({ ...input, limits: { ...input.limits, [field]: value } })).toThrow();
  });
  it("rejects cumulative resource and environment violations", () => {
    const input = fixture();
    for (const limits of [{ ...input.limits, wallMs: 25001 }, { ...input.limits, inputBytes: 1024 * 1024 + 1 },
      { ...input.limits, diagnosticBytes: 65537 }]) expect(() => encodeWindowsWorkerStdioLaunch({ ...input, limits })).toThrow();
    for (const environment of [{ Path: "a", PATH: "b" }, { EMPTY: "x\0y" }, { "A=B": "x" }, { HUGE: "x".repeat(8192) }])
      expect(() => encodeWindowsWorkerStdioLaunch({ ...input, environment })).toThrow();
  });
  it("refuses getters and proxies before running caller code", () => {
    let calls = 0;
    const input = fixture();
    Object.defineProperty(input, "jobName", { enumerable: true, get: () => { calls++; return "unreviewed"; } });
    expect(() => encodeWindowsWorkerStdioLaunch(input)).toThrow();
    expect(() => encodeWindowsWorkerStdioLaunch(new Proxy(fixture(), { get: () => { calls++; return undefined; } }))).toThrow();
    expect(calls).toBe(0);
  });
  it("keeps input and control frames disjoint and rejects oversized chunks", () => {
    expect(encodeWindowsWorkerStdioFrame(1, Buffer.from([0, 255]))).toEqual(Buffer.from([1, 2, 0, 0, 0, 0, 255]));
    expect(encodeWindowsWorkerStdioFrame(2)).toEqual(Buffer.from([2, 0, 0, 0, 0]));
    expect(() => encodeWindowsWorkerStdioFrame(1)).toThrow();
    expect(() => encodeWindowsWorkerStdioFrame(3, Buffer.from([1]))).toThrow();
    expect(() => encodeWindowsWorkerStdioFrame(1, Buffer.alloc(65537))).toThrow();
  });
  it("requires complete typed native receipts without path or extra payload fields", () => {
    const receipt = { schemaVersion: "goatcitadel.worker-native-stdio.v1", bridgeError: 0, end: 0, error: 0, processExitCode: 0,
      processId: 123, runtimeBundleVerified: true, runtimeBundleSha256: "a".repeat(64), zeroProcessesVerified: true, outputDrained: true,
      appContainerVerified: true, launchFilesVerified: true, processImageVerified: true, protectedWorkspaceVerified: false,
      standardInputBytesWritten: 4, standardInputComplete: true, standardOutputBytes: 7, standardErrorBytes: 0 };
    expect(decodeWindowsWorkerStdioCompletion(Buffer.from(JSON.stringify(receipt)))).toEqual(receipt);
    const missingProof: Record<string, unknown> = { ...receipt };
    delete missingProof.protectedWorkspaceVerified;
    expect(() => decodeWindowsWorkerStdioCompletion(Buffer.from(JSON.stringify(missingProof)))).toThrow();
    for (const changes of [{ path: "C:\\private" }, { end: 6 }, { outputDrained: "true" }, { standardInputBytesWritten: 1024 * 1024 + 1 }])
      expect(() => decodeWindowsWorkerStdioCompletion(Buffer.from(JSON.stringify({ ...receipt, ...changes })))).toThrow();
    expect(() => decodeWindowsWorkerStdioCompletion(Buffer.from([0xff]))).toThrow();
  });
});
