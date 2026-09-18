import { REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION } from "@goatcitadel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { windowsRuntimeDispatchFixture } from "./worker-windows-runtime-dispatch-test-fixture.js";
import { runWindowsWorkerGatewayRuntime } from "./worker-windows-gateway-runtime.js";
import { exchangeWorkerRuntimeResult, uploadWorkerRuntimeResult } from "./worker-runtime-result-client.js";
import { exchangeWorkerCellCapacity } from "./worker-cell-capacity-client.js";
import { reconcileWorkerNativeFiles } from "./worker-native-file-reconciliation-client.js";
import type { RouteContext } from "./connected-worker-routes.js";
import type { WindowsRuntimeParentSessionOwner } from "./worker-windows-runtime-parent-session.js";
vi.mock("./worker-runtime-result-client.js", () => ({ exchangeWorkerRuntimeResult: vi.fn(), uploadWorkerRuntimeResult: vi.fn() }));
vi.mock("./worker-cell-capacity-client.js", () => ({ exchangeWorkerCellCapacity: vi.fn() }));
vi.mock("./worker-native-file-reconciliation-client.js", () => ({ reconcileWorkerNativeFiles: vi.fn() }));

function fixture() {
  const f = runtimeResultPagesFixture(), request = windowsRuntimeDispatchFixture();
  const expected = prepareWindowsRuntimeDispatch(request).expectation;
  const stop = new AbortController(), authorize = vi.fn(async () => {});
  const owner: Omit<WindowsRuntimeParentSessionOwner, "retain"> = { signal: stop.signal, timeoutMs: 2000,
    authorizePeer: authorize, authorizeRuntime: authorize, authorizeDelivery: authorize, authorizeRetention: authorize,
    authorizeInput: authorize, readInput: async () => "eof", consumeOutput: authorize };
  const lease = { registryWorkspaceId: f.history.registryWorkspaceId, assignmentId: f.history.assignmentId,
    assignmentGeneration: f.history.assignmentGeneration, leaseRevision: f.history.leaseRevision, leaseToken: "private-lease" };
  const transport = { context: {} as RouteContext, lease }, input = { request, expected, owner };
  const receipt = f.response(null, true).record!;
  vi.mocked(reconcileWorkerNativeFiles).mockResolvedValue({ schemaVersion: "goatcitadel.native-file-reconciliation.v1",
    challenge: "11".repeat(32), lookup: f.response(null, true), settlement: null });
  vi.mocked(exchangeWorkerRuntimeResult).mockResolvedValue(f.response(null, false));
  type Driver = Parameters<typeof runWindowsWorkerGatewayRuntime>[0];
  const runRuntime = vi.fn<Driver["runRuntime"]>(async () => receipt);
  return { ...f, input, transport, stop, authorize, receipt, driver: { runRuntime }, runRuntime };
}

describe("native helper Gateway dispatch composition", () => {
  beforeEach(() => vi.clearAllMocks());
  it("returns the exact retained receipt without reentering native execution", async () => {
    const f = fixture();
    vi.mocked(exchangeWorkerRuntimeResult).mockResolvedValue(f.response(null, true));
    expect(await runWindowsWorkerGatewayRuntime(f.driver, f.transport, f.history, f.input, f.authorize)).toEqual(f.receipt);
    expect(exchangeWorkerRuntimeResult).toHaveBeenCalledExactlyOnceWith({}, f.transport.lease,
      { kind: "runtime.result.lookup", nonce: f.input.expected.nonce, requestSha256: f.input.expected.requestSha256 }, f.stop.signal);
    expect(f.runRuntime).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(uploadWorkerRuntimeResult).not.toHaveBeenCalled();
  });
  it.each(["failed", "cancelled"])("does not launch after a %s result lookup", async mode => {
    const f = fixture();
    vi.mocked(exchangeWorkerRuntimeResult).mockImplementation(async () => {
      if (mode === "failed") throw new Error("lookup unavailable");
      f.stop.abort(); return f.response(null, false);
    });
    await expect(runWindowsWorkerGatewayRuntime(f.driver, f.transport, f.history, f.input, f.authorize)).rejects.toThrow();
    expect(exchangeWorkerRuntimeResult).toHaveBeenCalledOnce();
    expect(f.runRuntime).not.toHaveBeenCalled();
    expect(uploadWorkerRuntimeResult).not.toHaveBeenCalled();
  });
  it("does not treat retained terminal metadata as completed file delivery or replay execution", async () => {
    const f = fixture();
    Object.assign(f.input.request, { fileStaging: { paths: ["result.txt"], maximumFileBytes: 1024, maximumTotalBytes: 1024 } });
    f.input.expected = prepareWindowsRuntimeDispatch(f.input.request).expectation;
    vi.mocked(exchangeWorkerRuntimeResult).mockResolvedValue(f.response(null, true));
    await expect(runWindowsWorkerGatewayRuntime(f.driver, f.transport, f.history, f.input, f.authorize)).rejects.toThrow("file settlement requires separate reconciliation");
    expect(f.runRuntime).not.toHaveBeenCalled(); expect(uploadWorkerRuntimeResult).not.toHaveBeenCalled();
  });
  it.each(["retained", "fresh"])("requires canonical file settlement for a %s result", async mode => {
    const f = fixture(); Object.assign(f.input.request, { fileStaging: { paths: ["result.txt"], maximumFileBytes: 1024, maximumTotalBytes: 1024 } });
    f.input.expected = prepareWindowsRuntimeDispatch(f.input.request).expectation;
    vi.mocked(exchangeWorkerRuntimeResult).mockResolvedValue(f.response(null, mode === "retained"));
    vi.mocked(reconcileWorkerNativeFiles).mockResolvedValue({ schemaVersion: "goatcitadel.native-file-reconciliation.v1", challenge: "11".repeat(32),
      lookup: f.response(null, true), settlement: { receiptSha256: "22".repeat(32), manifestSha256: "33".repeat(32), uploadId: "native-upload" } });
    expect(await runWindowsWorkerGatewayRuntime(f.driver, f.transport, f.history, f.input, f.authorize)).toEqual(f.receipt);
    expect(f.runRuntime).toHaveBeenCalledTimes(mode === "retained" ? 0 : 1); expect(reconcileWorkerNativeFiles).toHaveBeenCalledOnce();
  });
  it("holds the current lease while reconciling retained files", async () => {
    const f = fixture(); Object.assign(f.input.request, { fileStaging: { paths: ["result.txt"], maximumFileBytes: 1024, maximumTotalBytes: 1024 } });
    f.input.expected = prepareWindowsRuntimeDispatch(f.input.request).expectation;
    vi.mocked(exchangeWorkerRuntimeResult).mockResolvedValue(f.response(null, true));
    const current = { ...f.transport.lease, leaseRevision: f.transport.lease.leaseRevision + 1 };
    const leaseOwner = { withCurrentLease: async <T>(work: (lease: typeof current) => Promise<T>) => work(current) };
    await expect(runWindowsWorkerGatewayRuntime(f.driver, { ...f.transport, leaseOwner }, f.history, f.input, f.authorize)).rejects.toThrow("file settlement");
    expect(reconcileWorkerNativeFiles).toHaveBeenCalledExactlyOnceWith(f.transport.context, current, f.input.expected, f.stop.signal);
    expect(f.runRuntime).not.toHaveBeenCalled();
  });
  it.each(["pending", "changed", "cancelled"])("refuses a fresh job completion after %s file reconciliation", async mode => {
    const f = fixture(); Object.assign(f.input.request, { fileStaging: { paths: ["result.txt"], maximumFileBytes: 1024, maximumTotalBytes: 1024 } });
    f.input.expected = prepareWindowsRuntimeDispatch(f.input.request).expectation;
    vi.mocked(reconcileWorkerNativeFiles).mockImplementation(async () => {
      if (mode === "cancelled") f.stop.abort();
      return { schemaVersion: "goatcitadel.native-file-reconciliation.v1", challenge: "11".repeat(32),
        lookup: { ...f.response(null, true), record: { ...f.receipt, resultSha256: mode === "changed" ? "ff".repeat(32) : f.receipt.resultSha256 } },
        settlement: mode === "pending" ? null : { receiptSha256: "22".repeat(32), manifestSha256: "33".repeat(32), uploadId: "native-upload" } };
    });
    await expect(runWindowsWorkerGatewayRuntime(f.driver, f.transport, f.history, f.input, f.authorize)).rejects.toThrow();
    expect(f.runRuntime).toHaveBeenCalledOnce(); expect(reconcileWorkerNativeFiles).toHaveBeenCalledOnce();
  });
  it.each(["renewed", "foreign", "older"])("uses the %s currentLease callback without reentering execution", async mode => {
    const f = fixture(); Object.assign(f.input.request, { fileStaging: { paths: ["result.txt"], maximumFileBytes: 1024, maximumTotalBytes: 1024 } });
    f.input.expected = prepareWindowsRuntimeDispatch(f.input.request).expectation;
    vi.mocked(exchangeWorkerRuntimeResult).mockResolvedValue(f.response(null, true));
    const current = { ...f.transport.lease, leaseRevision: mode === "older" ? 0 : f.transport.lease.leaseRevision + 1 };
    if (mode === "foreign") current.assignmentId = "foreign";
    const currentLease = vi.fn(async () => current);
    await expect(runWindowsWorkerGatewayRuntime(f.driver, { ...f.transport, currentLease }, f.history, f.input, f.authorize)).rejects.toThrow();
    expect(currentLease).toHaveBeenCalledOnce(); expect(f.runRuntime).not.toHaveBeenCalled();
    expect(reconcileWorkerNativeFiles).toHaveBeenCalledTimes(mode === "renewed" ? 1 : 0);
    if (mode === "renewed") expect(reconcileWorkerNativeFiles).toHaveBeenCalledWith(f.transport.context, current, f.input.expected, f.stop.signal);
  });
  it("preserves the captured binding while the caller changes transport during execution", async () => {
    const f = fixture(); Object.assign(f.input.request, { fileStaging: { paths: ["result.txt"], maximumFileBytes: 1024, maximumTotalBytes: 1024 } });
    f.input.expected = prepareWindowsRuntimeDispatch(f.input.request).expectation;
    const lease = { ...f.transport.lease };
    f.runRuntime.mockImplementation(async () => { f.transport.lease.assignmentId = "changed-by-caller"; return f.receipt; });
    await expect(runWindowsWorkerGatewayRuntime(f.driver, f.transport, f.history, f.input, f.authorize)).rejects.toThrow("file settlement");
    expect(reconcileWorkerNativeFiles).toHaveBeenCalledWith({}, lease, f.input.expected, f.stop.signal);
  });
  it("uploads through the renewed lease only after matching current Gateway history", async () => {
    const f = fixture(), lease = { ...f.transport.lease, leaseRevision: f.transport.lease.leaseRevision + 2, leaseToken: "rotated-private-lease" };
    const history = { ...f.history, leaseRevision: lease.leaseRevision };
    const currentLease = vi.fn(async () => lease);
    vi.mocked(exchangeWorkerCellCapacity).mockResolvedValue({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, history, record: null });
    vi.mocked(uploadWorkerRuntimeResult).mockResolvedValue(f.response(null, true));
    f.runRuntime.mockImplementation(async (_history, input) => await input.owner.retain("controlled-result", f.stop.signal));
    await runWindowsWorkerGatewayRuntime(f.driver, { ...f.transport, currentLease }, f.history, f.input, f.authorize);
    expect(currentLease).toHaveBeenCalledExactlyOnceWith(f.stop.signal);
    expect(exchangeWorkerCellCapacity).toHaveBeenCalledExactlyOnceWith({}, lease, { kind: "cell.capacity.snapshot" }, f.stop.signal);
    expect(uploadWorkerRuntimeResult).toHaveBeenCalledExactlyOnceWith({}, lease, "controlled-result", f.input.expected, history, f.stop.signal);
  });
  it.each(["scope", "generation", "older", "history", "history_lease", "cancelled", "lookup_failure"])("withholds upload after %s renewal evidence", async mode => {
    const f = fixture(), lease = { ...f.transport.lease, leaseRevision: f.transport.lease.leaseRevision + 1 };
    if (mode === "scope") lease.assignmentId = "foreign";
    if (mode === "generation") lease.assignmentGeneration++;
    if (mode === "older") lease.leaseRevision = f.transport.lease.leaseRevision - 1;
    const history = { ...f.history, leaseRevision: lease.leaseRevision };
    if (mode === "history") history.assignmentId = "substituted-assignment";
    if (mode === "history_lease") history.leaseRevision++;
    vi.mocked(exchangeWorkerCellCapacity).mockImplementation(async () => {
      if (mode === "lookup_failure") throw new Error("lost lookup");
      if (mode === "cancelled") f.stop.abort();
      return { schemaVersion: REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, history, record: null };
    });
    const currentLease = vi.fn(async () => lease);
    f.runRuntime.mockImplementation(async (_history, input) => await input.owner.retain("controlled-result", f.stop.signal));
    await expect(runWindowsWorkerGatewayRuntime(f.driver, { ...f.transport, currentLease }, f.history, f.input, f.authorize)).rejects.toThrow();
    expect(f.runRuntime).toHaveBeenCalledOnce();
    expect(currentLease).toHaveBeenCalledOnce();
    expect(uploadWorkerRuntimeResult).not.toHaveBeenCalled();
  });
  it("binds helper retention to the captured protected route and admitted request", async () => {
    const f = fixture(), original = structuredClone(f.input.request), lease = { ...f.transport.lease };
    vi.mocked(uploadWorkerRuntimeResult).mockResolvedValue(f.response(null, true));
    f.runRuntime.mockImplementation(async (history, input, authorize) => {
      f.transport.lease.assignmentId = "changed";
      f.input.request.launch.commandLine = "changed";
      expect(input.request).toEqual(original);
      expect(history.assignmentId).toBe(lease.assignmentId);
      expect(authorize).toBe(f.authorize);
      return await input.owner.retain("controlled-result", f.stop.signal);
    });
    expect(await runWindowsWorkerGatewayRuntime(f.driver, f.transport, f.history, f.input, f.authorize)).toEqual(f.receipt);
    expect(uploadWorkerRuntimeResult).toHaveBeenCalledExactlyOnceWith({}, lease, "controlled-result",
      f.input.expected, f.history, f.stop.signal);
  });
  it.each(["scope", "assignment", "generation", "lease", "request", "cancelled"])("refuses %s before entering the native driver", async mode => {
    const f = fixture();
    if (mode === "scope") f.transport.lease.registryWorkspaceId = "foreign";
    if (mode === "assignment") f.transport.lease.assignmentId = "foreign";
    if (mode === "generation") f.transport.lease.assignmentGeneration++;
    if (mode === "lease") f.transport.lease.leaseRevision++;
    if (mode === "request") f.input.request.launch.commandLine += " changed";
    if (mode === "cancelled") f.stop.abort();
    await expect(runWindowsWorkerGatewayRuntime(f.driver, f.transport, f.history, f.input, f.authorize)).rejects.toThrow();
    expect(f.runRuntime).not.toHaveBeenCalled();
    expect(uploadWorkerRuntimeResult).not.toHaveBeenCalled();
  });
  it.each(["driver", "upload", "missing_receipt"])("does not retry after %s failure", async mode => {
    const f = fixture();
    if (mode === "upload") vi.mocked(uploadWorkerRuntimeResult).mockRejectedValue(new Error("lost response"));
    else vi.mocked(uploadWorkerRuntimeResult).mockResolvedValue(f.response(null, false));
    f.runRuntime.mockImplementation(async (_history, input) => {
      if (mode === "driver") throw new Error("uncertain launch");
      return await input.owner.retain("controlled-result", f.stop.signal);
    });
    await expect(runWindowsWorkerGatewayRuntime(f.driver, f.transport, f.history, f.input, f.authorize)).rejects.toThrow();
    expect(f.runRuntime).toHaveBeenCalledOnce();
    expect(uploadWorkerRuntimeResult).toHaveBeenCalledTimes(mode === "driver" ? 0 : 1);
  });
});
