import { REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION } from "@goatcitadel/contracts";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerNativeContinuation, readRemoteWorkerRuntimeResult, projectRemoteWorkerRuntimeOutcome } from "@goatcitadel/contracts";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { nativeArtifactFixture } from "../../../packages/contracts/src/remote-worker-native-artifact-test-fixture.js";
import { createWindowsInstalledNativeRuntime } from "./worker-windows-installed-runtime.js";
import { runWindowsWorkerAssignmentRuntime } from "./worker-windows-runtime-startup.js";
import { exchangeWorkerCellCapacity } from "./worker-cell-capacity-client.js";
import { retainWorkerRuntimeOutput } from "./worker-runtime-output-client.js";
import { reconcileWindowsWorkerAssignmentInstallation } from "./worker-windows-installation-recovery.js";
import type { WorkerNativeContinuationOwner } from "./worker-native-continuation.js";
import type { WorkerProtectedKeyOwner } from "./worker-protected-key-owner.js";
import type { WindowsRuntimeParentSessionOwner } from "./worker-windows-runtime-parent-session.js";

vi.mock("./worker-windows-runtime-startup.js", () => ({ runWindowsWorkerAssignmentRuntime: vi.fn() }));
vi.mock("./worker-cell-capacity-client.js", () => ({ exchangeWorkerCellCapacity: vi.fn() }));
vi.mock("./worker-runtime-output-client.js", () => ({ retainWorkerRuntimeOutput: vi.fn() }));
vi.mock("./worker-windows-installation-recovery.js", () => ({ reconcileWindowsWorkerAssignmentInstallation: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

function fixture() {
  const f = runtimeResultPagesFixture(2), stop = new AbortController();
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 0x31)]).toString("base64url");
  const reference = { kind: "windows_provisioner" as const, keysetGeneration: 1, protectedStateSha256: "44".repeat(32),
    keysetReceiptSha256: "55".repeat(32), workerPublicKeySpkiBase64Url: spki };
  const keys: WorkerProtectedKeyOwner = { reference, admissionSignerSpkiBase64Url: spki,
    signPopV2: vi.fn(), signAdmissionEnvelope: vi.fn() };
  const input = { context: { credential: { protectedKey: reference, registryWorkspaceId: f.history.registryWorkspaceId }, protectedKeys: keys },
    lease: { registryWorkspaceId: f.history.registryWorkspaceId, assignmentId: f.history.assignmentId,
      assignmentGeneration: f.history.assignmentGeneration, leaseRevision: f.history.leaseRevision, leaseToken: "lease-secret-" + "x".repeat(32) },
    owner: { remainingLeaseMs: vi.fn(() => 120000) },
    continuation: normalizeRemoteWorkerNativeContinuation({ schemaVersion: "goatcitadel.remote-worker-native-continuation.v1",
      assignmentGeneration: f.history.assignmentGeneration, resumeSha256: "11".repeat(32), approvalId: "approval",
      approvalSha256: "22".repeat(32), nativeRuntimeBindingSha256: "33".repeat(32), decision: "approved" }),
    signal: stop.signal, observed: {} } as unknown as Parameters<WorkerNativeContinuationOwner["run"]>[0];
  const result = { lease: input.lease, receipt: f.response(null, true).record!,
    outcome: projectRemoteWorkerRuntimeOutcome(readRemoteWorkerRuntimeResult(f.resultHex, f.expectation, f.history)) };
  vi.mocked(exchangeWorkerCellCapacity).mockResolvedValue({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, history: f.history, record: null });
  vi.mocked(reconcileWindowsWorkerAssignmentInstallation).mockResolvedValue({ lease: input.lease, evidence: null, outcome: null });
  vi.mocked(retainWorkerRuntimeOutput).mockResolvedValue({ evidenceSha256: "66".repeat(32) } as never);
  let ports: Omit<WindowsRuntimeParentSessionOwner, "retain"> | undefined;
  const work = vi.fn(async (owner: Omit<WindowsRuntimeParentSessionOwner, "retain">) => { await owner.authorizePeer(owner.signal); });
  vi.mocked(runWindowsWorkerAssignmentRuntime).mockImplementation(async options => {
    ports = options.runtime.owner; await work(ports);
    // Controlled driver counters; real parent-session tests enforce wire counts.
    const diagnostics = input.observed.nativeOutputDiagnostics as { stdout?: { bytes: number }; stderr?: { bytes: number } } | undefined;
    return { ...result, outcome: { ...result.outcome,
      stdoutBytes: diagnostics?.stdout?.bytes ?? 0, stderrBytes: diagnostics?.stderr?.bytes ?? 0 } };
  });
  return { ...f, stop, keys, input, result, work, runtime: createWindowsInstalledNativeRuntime(keys), get ports() { return ports!; } };
}

async function output(f: ReturnType<typeof fixture>, owner: Omit<WindowsRuntimeParentSessionOwner, "retain">,
  name: "stdout" | "stderr", text: string) {
  const bytes = Buffer.from(text); let sequence = 0, total = 0;
  for (let start = 0; start < bytes.length; start += 960) {
    const part = bytes.subarray(start, start + 960); total += part.length;
    await owner.consumeOutput(f.expectation, f.history, name, { sequence: ++sequence, total, bytes: part, eof: false }, owner.signal);
  }
  await owner.consumeOutput(f.expectation, f.history, name, { sequence: sequence + 1, total, bytes: Buffer.alloc(0), eof: true }, owner.signal);
}

describe.skipIf(process.platform !== "win32")("installed worker native policy", () => {
  it.each(["success", "unapproved", "foreign", "changed", "duplicate", "corrupt", "replay", "lease", "cancel"])("checks native-file local custody before Gateway transfer: %s", async mode => {
    const f = fixture(), native = nativeArtifactFixture("");
    const selection = { ...native.receipt.files[0]!.selection, registryWorkspaceId: f.input.lease.registryWorkspaceId,
      assignmentId: f.input.lease.assignmentId, assignmentGeneration: f.input.lease.assignmentGeneration, nonce: f.expectation.nonce,
      requestSha256: f.expectation.requestSha256, resultSha256: f.resultSha256 };
    const record = Buffer.alloc(200); record.write("GCRFA001");
    for (const [offset, value] of [[8, selection.nonce], [40, selection.requestSha256], [72, selection.resultSha256],
      [104, selection.workDirectoryIdentityHex], [128, selection.fileIdentityHex]] as const) Buffer.from(value, "hex").copy(record, offset);
    record.writeBigUInt64LE(BigInt(selection.allocatedBytes), 160);
    createHash("sha256").update(Buffer.alloc(0)).digest().copy(record, 168);
    f.work.mockImplementation(async owner => {
      if (mode !== "unapproved") await owner.authorizeFile!(f.expectation, f.history,
        mode === "foreign" ? { ...selection, assignmentId: "foreign" } : selection, owner.signal);
      if (mode === "changed") selection.fileIdentityHex = "02".repeat(24);
      if (mode === "corrupt") record[168] = record[168]! ^ 1;
      if (mode === "lease") vi.mocked(f.input.owner.remainingLeaseMs).mockReturnValue(0);
      if (mode === "cancel") f.stop.abort();
      const file = { selection, record };
      await owner.consumeFiles!(mode === "duplicate" ? [file, file] : [file], owner.signal);
      if (mode === "replay") await owner.consumeFiles!([file], owner.signal);
    });
    if (mode === "success") await f.runtime.run(f.input); else await expect(f.runtime.run(f.input)).rejects.toThrow();
    expect(f.input.observed.nativeOutputDiagnostics).toBeUndefined(); expect(retainWorkerRuntimeOutput).not.toHaveBeenCalled();
    expect(runWindowsWorkerAssignmentRuntime).toHaveBeenCalledOnce();
  });
  it("runs the protected continuation, supplies EOF and records bounded local diagnostics", async () => {
    const f = fixture();
    f.work.mockImplementation(async owner => {
      expect(await owner.readInput(0, owner.signal)).toBe("eof");
      await owner.authorizeInput(f.expectation, f.history, { sequence: 1, total: 0, eof: true, bytes: Buffer.alloc(0) }, owner.signal);
      await output(f, owner, "stdout", "useful result\n");
      await output(f, owner, "stderr", "");
    });
    expect(await f.runtime.run(f.input)).toEqual({ lease: f.input.lease });
    expect(f.input.observed.nativeOutputDiagnostics).toMatchObject({ stdout: { text: "useful result\n", bytes: 14,
      sha256: createHash("sha256").update("useful result\n").digest("hex"), truncated: false, provenance: "native_stream_local_diagnostic" } });
    expect(f.input.observed.nativeRuntimeOutput).toMatchObject({ nonce: f.expectation.nonce,
      requestSha256: f.expectation.requestSha256, resultSha256: f.result.receipt.resultSha256,
      streams: { stdout: { bytes: 14 }, stderr: { bytes: 0 } } });
    expect(retainWorkerRuntimeOutput).toHaveBeenCalledWith(f.input.context, f.result.lease, f.input.observed.nativeRuntimeOutput, expect.any(AbortSignal));
    expect(f.input.observed.nativeRuntimeOutputReceipt).toEqual({ evidenceSha256: "66".repeat(32) });
    expect(f.ports.signal.aborted).toBe(true);
    await expect(f.ports.readInput(0, f.ports.signal)).rejects.toThrow();
  });
  it("redacts a lease secret split between native output frames", async () => {
    const f = fixture(), prefix = "a".repeat(950), text = prefix + f.input.lease.leaseToken + "\n";
    f.work.mockImplementation(async owner => { await output(f, owner, "stdout", text); await output(f, owner, "stderr", ""); });
    await f.runtime.run(f.input);
    const diagnostics = JSON.stringify(f.input.observed.nativeOutputDiagnostics);
    expect(diagnostics).not.toContain(f.input.lease.leaseToken);
    expect(diagnostics).toContain("REDACTED");
  });
  it("drops a truncated final line and still accounts for every byte", async () => {
    const f = fixture(), text = "complete line\n" + "x".repeat(40000);
    f.work.mockImplementation(async owner => { await output(f, owner, "stdout", text); await output(f, owner, "stderr", ""); });
    await f.runtime.run(f.input);
    expect(f.input.observed.nativeOutputDiagnostics).toMatchObject({ stdout: {
      text: "complete line\n", truncated: true, bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    } });
  });
  it("does not invent empty output when returning a retained result without fresh streams", async () => {
    const f = fixture(); await f.runtime.run(f.input);
    expect(f.input.observed.nativeRuntimeOutcome).toBeDefined();
    expect(f.input.observed.nativeRuntimeOutput).toBeUndefined();
    expect(retainWorkerRuntimeOutput).not.toHaveBeenCalled();
  });
  it("propagates lost output acknowledgement without reporting retention or repeating execution", async () => {
    const f = fixture();
    f.work.mockImplementation(async owner => { await output(f, owner, "stdout", "hello"); await output(f, owner, "stderr", ""); });
    vi.mocked(retainWorkerRuntimeOutput).mockRejectedValue(new Error("lost acknowledgement"));
    await expect(f.runtime.run(f.input)).rejects.toThrow("lost acknowledgement");
    expect(f.input.observed.nativeRuntimeOutputReceipt).toBeUndefined();
    expect(runWindowsWorkerAssignmentRuntime).toHaveBeenCalledTimes(1);
    expect(retainWorkerRuntimeOutput).toHaveBeenCalledTimes(1);
    expect(f.ports.signal.aborted).toBe(true);
  });
  it("refuses partial stream evidence even if the controlled driver reports completion", async () => {
    const f = fixture();
    f.work.mockImplementation(async owner => { await output(f, owner, "stdout", "partial\n"); });
    await expect(f.runtime.run(f.input)).rejects.toThrow("output evidence");
    expect(f.input.observed.nativeRuntimeOutput).toBeUndefined();
    expect(f.ports.signal.aborted).toBe(true);
  });
  it.each(["custody", "lease", "cancel", "input", "history", "request", "sequence", "limit"])("refuses %s and closes its policy lifetime", async mode => {
    const f = fixture();
    f.work.mockImplementation(async owner => {
      if (mode === "custody") Object.assign(f.input.context.credential.protectedKey!, { keysetGeneration: 2 });
      if (mode === "lease") vi.mocked(f.input.owner.remainingLeaseMs).mockReturnValue(0);
      if (mode === "cancel") f.stop.abort();
      if (["custody", "lease", "cancel"].includes(mode)) return owner.authorizePeer(owner.signal);
      if (mode === "input") return owner.authorizeInput(f.expectation, f.history,
        { sequence: 1, total: 1, eof: false, bytes: Buffer.from("x") }, owner.signal);
      await owner.authorizeRuntime(f.expectation, f.history, 1, owner.signal);
      await owner.consumeOutput(mode === "request" ? { ...f.expectation, requestSha256: "ff".repeat(32) } : f.expectation,
        mode === "history" ? { ...f.history, assignmentId: "foreign" } : f.history, "stdout",
        { sequence: mode === "sequence" ? 2 : 1, total: mode === "limit" ? 100001 : 1,
          bytes: Buffer.alloc(mode === "limit" ? 100001 : 1), eof: false }, owner.signal);
    });
    await expect(f.runtime.run(f.input)).rejects.toThrow();
    expect(f.input.observed.nativeOutputDiagnostics).toBeUndefined();
    expect(f.ports.signal.aborted).toBe(true);
    expect(runWindowsWorkerAssignmentRuntime).toHaveBeenCalledOnce();
  });
});
