import { REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { prepareWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { windowsRuntimeDispatchFixture } from "./worker-windows-runtime-dispatch-test-fixture.js";
import { runWindowsWorkerAssignmentRuntime } from "./worker-windows-runtime-startup.js";
import { normalizeRemoteWorkerNativeContinuation } from "@goatcitadel/contracts";
import { exchangeWorkerRuntimeResult, uploadWorkerRuntimeResult } from "./worker-runtime-result-client.js";
import { renewWorkerLeaseControl } from "./worker-lease-control.js";
import { authorizeWorkerRuntime } from "./worker-runtime-authorization-client.js";
import { authorizeWorkerNativeFile } from "./worker-native-file-grant-client.js";
import { transferWorkerNativeFiles } from "./worker-native-file-transfer-client.js";
vi.mock("./worker-native-file-transfer-client.js", () => ({ transferWorkerNativeFiles: vi.fn() }));
import { reconcileWorkerNativeFiles } from "./worker-native-file-reconciliation-client.js";
import { nativeArtifactFixture } from "../../../packages/contracts/src/remote-worker-native-artifact-test-fixture.js";
vi.mock("./worker-native-file-grant-client.js", () => ({ authorizeWorkerNativeFile: vi.fn() }));
vi.mock("./worker-native-file-reconciliation-client.js", () => ({ reconcileWorkerNativeFiles: vi.fn() }));
import { downloadWorkerRuntimeRequest } from "./worker-runtime-request-client.js";
import { readWorkerRuntimeOutcome } from "./worker-runtime-outcome-client.js";
import { readRemoteWorkerRuntimeResult, projectRemoteWorkerRuntimeOutcome, REMOTE_WORKER_RUNTIME_OUTCOME_SCHEMA } from "@goatcitadel/contracts";
vi.mock("./worker-runtime-outcome-client.js", () => ({ readWorkerRuntimeOutcome: vi.fn() }));
vi.mock("./worker-runtime-request-client.js", () => ({ downloadWorkerRuntimeRequest: vi.fn() }));
vi.mock("./worker-runtime-authorization-client.js", () => ({ authorizeWorkerRuntime: vi.fn() }));
import { exchangeWorkerCellCapacity } from "./worker-cell-capacity-client.js";
import { createWindowsWorkerCellProvisioning, readWindowsWorkerCellControllerCustody } from "./worker-windows-cell-provisioning.js";
import type { RouteContext } from "./connected-worker-routes.js";
vi.mock("./worker-lease-control.js", () => ({ renewWorkerLeaseControl: vi.fn() }));
vi.mock("./worker-runtime-result-client.js", () => ({ exchangeWorkerRuntimeResult: vi.fn(), uploadWorkerRuntimeResult: vi.fn() }));
vi.mock("./worker-cell-capacity-client.js", () => ({ exchangeWorkerCellCapacity: vi.fn() }));
vi.mock("./worker-windows-cell-provisioning.js", () => ({ createWindowsWorkerCellProvisioning: vi.fn(), readWindowsWorkerCellControllerCustody: vi.fn() }));

function fixture() {
  vi.mocked(authorizeWorkerRuntime).mockResolvedValue(undefined);
  const f = runtimeResultPagesFixture(), request = windowsRuntimeDispatchFixture(), stop = new AbortController();
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 0x31)]).toString("base64url");
  const reference = { kind: "windows_provisioner", keysetGeneration: 1, protectedStateSha256: "4".repeat(64),
    keysetReceiptSha256: "5".repeat(64), workerPublicKeySpkiBase64Url: spki };
  const context = { credential: { registryWorkspaceId: f.history.registryWorkspaceId, protectedKey: reference },
    protectedKeys: { reference, admissionSignerSpkiBase64Url: spki, signPopV2: vi.fn(), signAdmissionEnvelope: vi.fn() } } as unknown as RouteContext;
  const lease = { registryWorkspaceId: f.history.registryWorkspaceId, assignmentId: f.history.assignmentId,
    assignmentGeneration: f.history.assignmentGeneration, leaseRevision: f.history.leaseRevision, leaseToken: "private-lease" };
  const owner = { renew: vi.fn(), remainingLeaseMs: vi.fn(() => 120000), workerSentThrough: () => 0 };
  const authorize = vi.fn(async () => {});
  const ports = { signal: stop.signal, timeoutMs: 2000, authorizePeer: authorize, authorizeRuntime: authorize,
    authorizeDelivery: authorize, authorizeRetention: authorize, authorizeInput: authorize,
    readInput: async () => "eof" as const, consumeOutput: authorize };
  const receipt = f.response(null, true).record!;
  vi.mocked(authorizeWorkerNativeFile).mockResolvedValue(undefined);
  vi.mocked(reconcileWorkerNativeFiles).mockResolvedValue({ schemaVersion: "goatcitadel.native-file-reconciliation.v1", challenge: "11".repeat(32),
    lookup: f.response(null, true), settlement: { receiptSha256: "22".repeat(32), manifestSha256: "33".repeat(32), uploadId: "native-upload" } });
  vi.mocked(readWorkerRuntimeOutcome).mockImplementation(async (_context, binding, expected) => ({
    schemaVersion: REMOTE_WORKER_RUNTIME_OUTCOME_SCHEMA, challenge: "11".repeat(32),
    lookup: { ...f.response(null, true), leaseRevision: binding.leaseRevision, nonce: expected.nonce, requestSha256: expected.requestSha256 },
    outcome: projectRemoteWorkerRuntimeOutcome(readRemoteWorkerRuntimeResult(f.resultHex, f.expectation, f.history)),
  }));
  vi.mocked(exchangeWorkerRuntimeResult).mockResolvedValue(f.response(null, false));
  const runRuntime = vi.fn<ReturnType<typeof createWindowsWorkerCellProvisioning>["runRuntime"]>(async (history, runtime, check) => {
    await check(); await runtime.owner.authorizeRuntime(runtime.expected, history, 1, runtime.owner.signal); return receipt;
  });
  // Only runtime dispatch is available in this controlled driver. Accidentally
  // entering provisioning would fail rather than creating a fixture disk.
  vi.mocked(createWindowsWorkerCellProvisioning).mockReturnValue({ runRuntime } as unknown as ReturnType<typeof createWindowsWorkerCellProvisioning>);
  vi.mocked(readWindowsWorkerCellControllerCustody).mockImplementation(async options => {
    await options.assertCurrent(); return { parentPath: "C:\\ProgramData\\GoatCitadel\\RemoteWorker\\cells" } as never;
  });
  vi.mocked(renewWorkerLeaseControl).mockImplementation(async input => ({ lease: { ...input.lease,
    leaseRevision: input.lease.leaseRevision + 1, leaseToken: `private-${input.lease.leaseRevision + 1}` },
    control: { body: { disposition: "active" } } } as never));
  vi.mocked(exchangeWorkerCellCapacity).mockImplementation(async (_context, binding) => ({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, history: { ...f.history, leaseRevision: binding.leaseRevision }, record: null }));
  return { ...f, stop, runRuntime, owner, authorize, input: { context, lease, owner, signal: stop.signal, observed: {}, history: f.history,
    runtime: { request, expected: prepareWindowsRuntimeDispatch(request).expectation, owner: ports } } };
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());
describe.skipIf(process.platform !== "win32")("installed native runtime authority composition", () => {
  function fileFixture() {
    const f = fixture(), native = nativeArtifactFixture(), request = { ...f.input.runtime.request, fileStaging: native.receipt.fileStaging };
    const expected = prepareWindowsRuntimeDispatch(request).expectation, authorizeFile = vi.fn(async () => {});
    const selection = { ...native.receipt.files[0]!.selection, registryWorkspaceId: f.input.lease.registryWorkspaceId,
      assignmentId: f.input.lease.assignmentId, assignmentGeneration: f.input.lease.assignmentGeneration,
      nonce: expected.nonce, requestSha256: expected.requestSha256 };
    const runtime = { ...f.input.runtime, request, expected, owner: { ...f.input.runtime.owner, authorizeFile, consumeFiles: vi.fn(async () => {}) } };
    return { ...f, originalRuntime: f.input.runtime, input: { ...f.input, runtime }, authorizeFile, selection };
  }
  it.each(["success", "local-deny", "transfer-deny"])("requires the installed complete-batch transfer consumer: %s", async mode => {
    const f = fileFixture(), files = [{ selection: f.selection, record: Buffer.alloc(200) }]; let consumed = false;
    if (mode === "local-deny") f.input.runtime.owner.consumeFiles.mockRejectedValue(new Error("local denied"));
    vi.mocked(transferWorkerNativeFiles).mockImplementation(async (_context, owner, expected, plan, batch, signal, local) => {
      expect(expected).toEqual(f.input.runtime.expected); expect(plan).toEqual(f.input.runtime.request.fileStaging); expect(batch).toBe(files);
      await local!(); signal.throwIfAborted(); await owner.withCurrentLease(async current => { expect(current.leaseRevision).toBeGreaterThan(0); });
      if (mode === "transfer-deny") throw new Error("Gateway transfer denied");
      return vi.mocked(reconcileWorkerNativeFiles).getMockImplementation()!(f.input.context, f.input.lease, expected, signal);
    });
    f.runRuntime.mockImplementation(async (_history, runtime) => {
      await runtime.owner.consumeFiles!(files, runtime.owner.signal); consumed = true; return f.response(null, true).record!;
    });
    if (mode === "success") await runWindowsWorkerAssignmentRuntime(f.input);
    else await expect(runWindowsWorkerAssignmentRuntime(f.input)).rejects.toThrow();
    expect(consumed).toBe(mode === "success"); expect(transferWorkerNativeFiles).toHaveBeenCalledOnce(); expect(f.input.runtime.owner.consumeFiles).toHaveBeenCalledOnce();
  });
  it("requires local and fresh Gateway file authority under the renewed lease at each boundary", async () => {
    const f = fileFixture(); let granted = 0;
    f.runRuntime.mockImplementation(async (history, runtime) => {
      for (let index = 0; index < 2; index++) { await runtime.owner.authorizeFile!(runtime.expected, history, f.selection, runtime.owner.signal); granted++; }
      return f.response(null, true).record!;
    });
    await runWindowsWorkerAssignmentRuntime(f.input);
    expect(granted).toBe(2); expect(f.authorizeFile).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(authorizeWorkerNativeFile).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1]![1].leaseRevision).toBeGreaterThan(calls[0]![1].leaseRevision);
    for (const call of calls) { expect(call[2]).toEqual(f.selection); expect(call[3]).toEqual(f.input.runtime.request.fileStaging); }
    expect(f.input.runtime.owner.consumeFiles).not.toHaveBeenCalled();
  });
  it.each(["policy", "gateway", "request", "history", "selection", "cancelled", "local-missing", "consumer-missing", "plan-missing"])("withholds file permission after %s failure", async mode => {
    const f = fileFixture(); let granted = false;
    if (mode === "policy") f.authorizeFile.mockRejectedValue(new Error("local policy denied"));
    if (mode === "gateway") vi.mocked(authorizeWorkerNativeFile).mockRejectedValue(new Error("Gateway disclosure revoked"));
    if (mode === "cancelled") f.authorizeFile.mockImplementation(async () => f.stop.abort());
    const input = mode === "plan-missing" ? { ...f.input, runtime: f.originalRuntime } : f.input;
    if (mode === "local-missing") Object.assign(input.runtime.owner, { authorizeFile: undefined });
    if (mode === "consumer-missing") Object.assign(input.runtime.owner, { consumeFiles: undefined });
    f.runRuntime.mockImplementation(async (history, runtime) => {
      await runtime.owner.authorizeFile!(mode === "request" ? { ...runtime.expected, requestSha256: "ff".repeat(32) } : runtime.expected,
        mode === "history" ? { ...history, assignmentId: "foreign" } : history,
        mode === "selection" ? { ...f.selection, nonce: "ff".repeat(32) } : f.selection, runtime.owner.signal);
      granted = true; return f.response(null, true).record!;
    });
    await expect(runWindowsWorkerAssignmentRuntime(input)).rejects.toThrow(); expect(granted).toBe(false);
    expect(f.runRuntime).toHaveBeenCalledTimes(mode === "local-missing" || mode === "consumer-missing" ? 0 : 1);
    expect(authorizeWorkerNativeFile).toHaveBeenCalledTimes(mode === "gateway" ? 1 : 0); expect(uploadWorkerRuntimeResult).not.toHaveBeenCalled();
  });
  it("stops file release when disclosure is revoked between two files", async () => {
    const f = fileFixture(); let granted = 0;
    f.runRuntime.mockImplementation(async (history, runtime) => {
      await runtime.owner.authorizeFile!(runtime.expected, history, f.selection, runtime.owner.signal); granted++;
      vi.mocked(authorizeWorkerNativeFile).mockRejectedValueOnce(new Error("disclosure revoked"));
      await runtime.owner.authorizeFile!(runtime.expected, history, f.selection, runtime.owner.signal); granted++;
      return f.response(null, true).record!;
    });
    await expect(runWindowsWorkerAssignmentRuntime(f.input)).rejects.toThrow("disclosure revoked"); expect(granted).toBe(1);
    expect(authorizeWorkerNativeFile).toHaveBeenCalledTimes(2); expect(f.runRuntime).toHaveBeenCalledOnce();
  });
  it("preserves the selected file when caller code mutates the original during its local check", async () => {
    const f = fileFixture(), original = { ...f.selection };
    f.authorizeFile.mockImplementation(async () => { f.selection.logicalPath = "substituted.txt"; });
    f.runRuntime.mockImplementation(async (history, runtime) => {
      await runtime.owner.authorizeFile!(runtime.expected, history, f.selection, runtime.owner.signal); return f.response(null, true).record!;
    });
    await runWindowsWorkerAssignmentRuntime(f.input);
    expect(authorizeWorkerNativeFile).toHaveBeenCalledWith(expect.anything(), expect.anything(), original, f.input.runtime.request.fileStaging, expect.any(AbortSignal));
  });
  it("preserves the exact continuation through installed request selection", async () => {
    const f = fixture(), continuation = normalizeRemoteWorkerNativeContinuation({ schemaVersion: "goatcitadel.remote-worker-native-continuation.v1",
      assignmentGeneration: f.input.lease.assignmentGeneration, resumeSha256: "11".repeat(32), approvalId: "approval", approvalSha256: "22".repeat(32),
      nativeRuntimeBindingSha256: "33".repeat(32), decision: "approved" });
    vi.mocked(downloadWorkerRuntimeRequest).mockResolvedValue({ request: f.input.runtime.request, expected: f.input.runtime.expected });
    await runWindowsWorkerAssignmentRuntime({ ...f.input, runtime: { selectAdmitted: true, continuation, owner: f.input.runtime.owner } });
    expect(downloadWorkerRuntimeRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), continuation);
    expect(f.runRuntime).toHaveBeenCalledOnce();
  });
  it("returns recorded nonzero exit facts rather than treating a receipt as workload success", async () => {
    const f = fixture(), result = await runWindowsWorkerAssignmentRuntime(f.input);
    expect(result.outcome.exitCode).toBe(23); expect(result.outcome.end).toBe("exited");
    expect(readWorkerRuntimeOutcome).toHaveBeenCalledOnce(); expect(f.runRuntime).toHaveBeenCalledOnce();
  });
  it.each(["missing", "changed", "unavailable"])("withholds completion on %s retained outcome without rerunning", async mode => {
    const f = fixture(), original = vi.mocked(readWorkerRuntimeOutcome).getMockImplementation()!;
    vi.mocked(readWorkerRuntimeOutcome).mockImplementation(async (...args) => {
      if (mode === "unavailable") throw new Error("outcome unavailable");
      const result = await original(...args);
      return mode === "missing" ? { ...result, outcome: null, lookup: { ...result.lookup, record: null } }
        : { ...result, lookup: { ...result.lookup, record: { ...result.lookup.record!, resultSha256: "ff".repeat(32) } } };
    });
    await expect(runWindowsWorkerAssignmentRuntime(f.input)).rejects.toThrow(); expect(f.runRuntime).toHaveBeenCalledOnce();
  });
  it("downloads selected work under a held lease and rebinds history before driver entry", async () => {
    const f = fixture();
    vi.mocked(downloadWorkerRuntimeRequest).mockResolvedValue({ request: f.input.runtime.request, expected: f.input.runtime.expected });
    const result = await runWindowsWorkerAssignmentRuntime({ ...f.input, runtime: { selectAdmitted: true, owner: f.input.runtime.owner } });
    expect(result.receipt).toEqual(f.response(null, true).record);
    expect(downloadWorkerRuntimeRequest).toHaveBeenCalledOnce();
    const downloadedLease = vi.mocked(downloadWorkerRuntimeRequest).mock.calls[0]![1];
    expect(f.runRuntime.mock.calls[0]![0].leaseRevision).toBe(downloadedLease.leaseRevision);
    expect(f.runRuntime.mock.calls[0]![1].request).toEqual(f.input.runtime.request);
    expect(exchangeWorkerRuntimeResult).toHaveBeenCalledWith(expect.anything(), downloadedLease, expect.anything(), expect.anything());
  });
  it.each(["unavailable", "changed", "history", "cancelled", "mixed"])("withholds selected dispatch when %s", async mode => {
    const f = fixture();
    vi.mocked(downloadWorkerRuntimeRequest).mockImplementation(async () => {
      if (mode === "unavailable") throw new Error("selection unavailable");
      if (mode === "cancelled") f.stop.abort();
      if (mode === "history") vi.mocked(exchangeWorkerCellCapacity).mockImplementation(async (_context, lease) => ({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, history: { ...f.history, leaseRevision: lease.leaseRevision, assignmentId: "foreign" }, record: null }));
      return { request: f.input.runtime.request, expected: mode === "changed" ? { ...f.input.runtime.expected, requestSha256: "f".repeat(64) } : f.input.runtime.expected };
    });
    const runtime = mode === "mixed" ? { ...f.input.runtime, selectAdmitted: true as const } : { selectAdmitted: true as const, owner: f.input.runtime.owner };
    await expect(runWindowsWorkerAssignmentRuntime({ ...f.input, runtime })).rejects.toThrow();
    expect(createWindowsWorkerCellProvisioning).not.toHaveBeenCalled(); expect(f.runRuntime).not.toHaveBeenCalled();
  });
  it("requires fresh Gateway authorization for runtime, delivery and retention under the held lease", async () => {
    const f = fixture();
    f.runRuntime.mockImplementation(async (history, runtime) => {
      await runtime.owner.authorizeRuntime(runtime.expected, history, 1, runtime.owner.signal);
      await runtime.owner.authorizeDelivery(runtime.expected, history, 1, runtime.owner.signal);
      await runtime.owner.authorizeRetention(runtime.expected, history, runtime.owner.signal);
      return f.response(null, true).record!;
    });
    await runWindowsWorkerAssignmentRuntime(f.input);
    const calls = vi.mocked(authorizeWorkerRuntime).mock.calls;
    expect(calls.map(call => call[3])).toEqual(["execution", "delivery", "delivery"]);
    expect(new Set(calls.map(call => call[1].leaseRevision)).size).toBe(3);
    for (const call of calls) expect(call[2]).toEqual(f.input.runtime.expected);
    expect(f.authorize).toHaveBeenCalledTimes(3);
  });
  it("stops forwarding native input when Gateway approval is revoked between frames", async () => {
    const f = fixture();
    let forwarded = 0;
    f.runRuntime.mockImplementation(async (history, runtime) => {
      await runtime.owner.authorizeInput(runtime.expected, history,
        { sequence: 0, total: 1, eof: false, bytes: Buffer.from("a") }, runtime.owner.signal);
      forwarded++;
      vi.mocked(authorizeWorkerRuntime).mockRejectedValueOnce(new Error("canonical approval revoked"));
      await runtime.owner.authorizeInput(runtime.expected, history,
        { sequence: 1, total: 2, eof: false, bytes: Buffer.from("b") }, runtime.owner.signal);
      forwarded++;
      return f.response(null, true).record!;
    });
    await expect(runWindowsWorkerAssignmentRuntime(f.input)).rejects.toThrow("canonical approval revoked");
    expect(forwarded).toBe(1);
    expect(vi.mocked(authorizeWorkerRuntime).mock.calls.map(call => call[3])).toEqual(["execution", "execution"]);
    expect(f.runRuntime).toHaveBeenCalledOnce();
    expect(uploadWorkerRuntimeResult).not.toHaveBeenCalled();
  });
  it.each(["request", "history"])("refuses native input for foreign %s before calling the input policy", async mode => {
    const f = fixture();
    f.runRuntime.mockImplementation(async (history, runtime) => {
      await runtime.owner.authorizeInput(
        mode === "request" ? { ...runtime.expected, requestSha256: "ff".repeat(32) } : runtime.expected,
        mode === "history" ? { ...history, assignmentId: "foreign" } : history,
        { sequence: 0, total: 0, eof: true, bytes: Buffer.alloc(0) }, runtime.owner.signal);
      return f.response(null, true).record!;
    });
    await expect(runWindowsWorkerAssignmentRuntime(f.input)).rejects.toThrow();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(authorizeWorkerRuntime).not.toHaveBeenCalled();
    expect(f.runRuntime).toHaveBeenCalledOnce();
  });
  it.each(["policy", "gateway", "request", "history"])("withholds native authorization on %s failure without relaunch", async mode => {
    const f = fixture();
    if (mode === "policy") f.authorize.mockRejectedValue(new Error("policy refused"));
    if (mode === "gateway") vi.mocked(authorizeWorkerRuntime).mockRejectedValue(new Error("canonical approval revoked"));
    f.runRuntime.mockImplementation(async (history, runtime) => {
      await runtime.owner.authorizeRuntime(mode === "request" ? { ...runtime.expected, requestSha256: "ff".repeat(32) } : runtime.expected,
        mode === "history" ? { ...history, assignmentId: "foreign" } : history, 1, runtime.owner.signal);
      return f.response(null, true).record!;
    });
    await expect(runWindowsWorkerAssignmentRuntime(f.input)).rejects.toThrow();
    expect(f.runRuntime).toHaveBeenCalledOnce();
    expect(authorizeWorkerRuntime).toHaveBeenCalledTimes(mode === "gateway" ? 1 : 0);
    expect(uploadWorkerRuntimeResult).not.toHaveBeenCalled();
  });
  it("uses installed controller custody, refreshed history and request-specific authorization", async () => {
    const f = fixture(), result = await runWindowsWorkerAssignmentRuntime(f.input);
    expect(result.receipt).toEqual(f.response(null, true).record);
    expect(result.lease.leaseRevision).toBeGreaterThan(f.input.lease.leaseRevision);
    expect(createWindowsWorkerCellProvisioning).toHaveBeenCalledWith(expect.objectContaining({ controllerService: true,
      parentPath: "C:\\ProgramData\\GoatCitadel\\RemoteWorker\\cells", wallMs: 2000 }));
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(f.runRuntime).toHaveBeenCalledOnce();
    expect(f.runRuntime.mock.calls[0]![1].owner.signal.aborted).toBe(true);
  });
  it.each(["pem", "custody", "history", "request", "cancelled"])("refuses %s before creating the runtime driver", async mode => {
    const f = fixture();
    if (mode === "pem") f.input.context = { ...f.input.context, credential: { ...f.input.context.credential,
      protectedKey: undefined, signingPrivateKeyPem: "controlled-foreground-pem" } };
    if (mode === "custody") vi.mocked(readWindowsWorkerCellControllerCustody).mockRejectedValue(new Error("not installed"));
    if (mode === "history") vi.mocked(exchangeWorkerCellCapacity).mockResolvedValue({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, history: { ...f.history, assignmentId: "foreign" }, record: null });
    if (mode === "request") f.input.runtime.request.launch.commandLine += " changed";
    if (mode === "cancelled") f.stop.abort();
    await expect(runWindowsWorkerAssignmentRuntime(f.input)).rejects.toThrow();
    expect(createWindowsWorkerCellProvisioning).not.toHaveBeenCalled();
  });
  it("renews while native work is quiet and stops renewing after the driver joins", async () => {
    vi.useFakeTimers(); const f = fixture(); f.owner.remainingLeaseMs.mockReturnValue(200);
    let finish!: () => void;
    f.runRuntime.mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve; }); return f.response(null, true).record!; });
    const running = runWindowsWorkerAssignmentRuntime(f.input);
    await vi.waitFor(() => expect(f.runRuntime).toHaveBeenCalledOnce());
    const before = vi.mocked(renewWorkerLeaseControl).mock.calls.length;
    await vi.advanceTimersByTimeAsync(350);
    expect(vi.mocked(renewWorkerLeaseControl).mock.calls.length).toBeGreaterThan(before);
    expect(f.runRuntime.mock.calls[0]![1].owner.signal.aborted).toBe(false);
    finish(); await running;
    const after = vi.mocked(renewWorkerLeaseControl).mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.mocked(renewWorkerLeaseControl).mock.calls.length).toBe(after);
  });
  it("cancels quiet native work when renewal loses authority without launching again", async () => {
    vi.useFakeTimers(); const f = fixture(); f.owner.remainingLeaseMs.mockReturnValue(200);
    f.runRuntime.mockImplementation(async (_history, runtime) => await new Promise((_resolve, reject) => {
      runtime.owner.signal.addEventListener("abort", () => reject(new Error("native cancelled")), { once: true });
    }));
    const running = runWindowsWorkerAssignmentRuntime(f.input), rejected = expect(running).rejects.toThrow("native cancelled");
    await vi.waitFor(() => expect(f.runRuntime).toHaveBeenCalledOnce());
    vi.mocked(renewWorkerLeaseControl).mockRejectedValue(new Error("revoked"));
    await vi.advanceTimersByTimeAsync(150); await rejected;
    expect(f.runRuntime).toHaveBeenCalledOnce();
  });
  it.each([false, true])("holds the upload lease without suppressing expiry (expires=%s)", async expires => {
    vi.useFakeTimers(); const f = fixture(); f.owner.remainingLeaseMs.mockReturnValue(200);
    let finish!: () => void;
    vi.mocked(uploadWorkerRuntimeResult).mockImplementation(async (_context, _lease, _hex, _expected, _history, signal) => {
      await new Promise<void>((resolve, reject) => {
        finish = resolve; signal!.addEventListener("abort", () => reject(new Error("upload cancelled")), { once: true });
      });
      return f.response(null, true);
    });
    f.runRuntime.mockImplementation(async (_history, runtime) => runtime.owner.retain("controlled-result", runtime.owner.signal));
    const running = runWindowsWorkerAssignmentRuntime(f.input);
    const outcome = expires ? expect(running).rejects.toThrow("upload cancelled") : running;
    await vi.waitFor(() => expect(uploadWorkerRuntimeResult).toHaveBeenCalledOnce());
    const before = vi.mocked(renewWorkerLeaseControl).mock.calls.length;
    await vi.advanceTimersByTimeAsync(expires ? 250 : 120);
    if (!expires) {
      expect(vi.mocked(renewWorkerLeaseControl).mock.calls.length).toBe(before);
      finish();
    }
    await outcome;
    expect(f.runRuntime).toHaveBeenCalledOnce();
    expect(uploadWorkerRuntimeResult).toHaveBeenCalledOnce();
    const after = vi.mocked(renewWorkerLeaseControl).mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.mocked(renewWorkerLeaseControl).mock.calls.length).toBe(after);
  });
});
