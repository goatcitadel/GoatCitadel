import { REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION } from "@goatcitadel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerNativeContinuation, readRemoteWorkerRuntimeResult, projectRemoteWorkerRuntimeOutcome } from "@goatcitadel/contracts";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { createWindowsWorkerNativeContinuation } from "./worker-windows-native-continuation.js";
import { runWindowsWorkerAssignmentRuntime } from "./worker-windows-runtime-startup.js";
import { exchangeWorkerCellCapacity } from "./worker-cell-capacity-client.js";
import { requireWorkerProtectedKeyOwner } from "./worker-protected-key-owner.js";
import { ensureWindowsWorkerAssignmentInstallation } from "./worker-windows-installation-startup.js";
import type { WorkerNativeContinuationOwner } from "./worker-native-continuation.js";
vi.mock("./worker-windows-runtime-startup.js", () => ({ runWindowsWorkerAssignmentRuntime: vi.fn() }));
vi.mock("./worker-cell-capacity-client.js", () => ({ exchangeWorkerCellCapacity: vi.fn() }));
vi.mock("./worker-protected-key-owner.js", () => ({ requireWorkerProtectedKeyOwner: vi.fn() }));
vi.mock("./worker-windows-installation-startup.js", () => ({ ensureWindowsWorkerAssignmentInstallation: vi.fn() }));
function fixture() {
  const f = runtimeResultPagesFixture(2), stop = new AbortController();
  const continuation = normalizeRemoteWorkerNativeContinuation({ schemaVersion: "goatcitadel.remote-worker-native-continuation.v1",
    assignmentGeneration: f.history.assignmentGeneration, resumeSha256: "11".repeat(32), approvalId: "approval", approvalSha256: "22".repeat(32),
    nativeRuntimeBindingSha256: "33".repeat(32), decision: "approved" });
  const input = { context: { credential: { protectedKey: {}, registryWorkspaceId: f.history.registryWorkspaceId }, protectedKeys: {} },
    lease: { registryWorkspaceId: f.history.registryWorkspaceId, assignmentId: f.history.assignmentId, assignmentGeneration: f.history.assignmentGeneration,
      leaseRevision: f.history.leaseRevision, leaseToken: "private-token" }, owner: {}, continuation, signal: stop.signal, observed: {} } as Parameters<WorkerNativeContinuationOwner["run"]>[0];
  const ports = { signal: stop.signal, timeoutMs: 1000 } as Parameters<typeof runWindowsWorkerAssignmentRuntime>[0]["runtime"]["owner"];
  const resolve = vi.fn(async () => ports), result = { lease: { ...input.lease, leaseRevision: input.lease.leaseRevision + 1 }, receipt: f.response(null, true).record!,
    outcome: projectRemoteWorkerRuntimeOutcome(readRemoteWorkerRuntimeResult(f.resultHex, f.expectation, f.history)) };
  vi.mocked(requireWorkerProtectedKeyOwner).mockReturnValue(input.context.protectedKeys!);
  vi.mocked(exchangeWorkerCellCapacity).mockResolvedValue({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, history: f.history, record: null });
  vi.mocked(runWindowsWorkerAssignmentRuntime).mockResolvedValue(result);
  vi.mocked(ensureWindowsWorkerAssignmentInstallation).mockResolvedValue({ lease: input.lease, evidence: null, outcome: null });
  return { ...f, input, stop, resolve, ports, result, owner: createWindowsWorkerNativeContinuation(resolve) };
}
beforeEach(() => vi.resetAllMocks());
describe.skipIf(process.platform !== "win32")("installed native continuation adapter", () => {
  it("hands off exact selection and current policy without entering provisioning or completing Chat", async () => {
    const f = fixture(); expect(await f.owner.run(f.input)).toEqual({ lease: f.result.lease });
    expect(exchangeWorkerCellCapacity).toHaveBeenCalledExactlyOnceWith(expect.anything(), f.input.lease, { kind: "cell.capacity.snapshot" }, f.stop.signal);
    expect(runWindowsWorkerAssignmentRuntime).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ history: f.history, owner: f.input.owner,
      runtime: { selectAdmitted: true, continuation: f.input.continuation, owner: f.ports } }));
    expect(f.input.observed.nativeRuntimeOutcome).toMatchObject({ exitCode: 23 });
    expect(f.input.observed).not.toHaveProperty("settlementOutcome");
  });
  it("uses the lease returned by installation reconciliation for snapshot and execution", async () => {
    const f = fixture(), renewed = { ...f.input.lease, leaseRevision: f.input.lease.leaseRevision + 2 };
    vi.mocked(ensureWindowsWorkerAssignmentInstallation).mockResolvedValue({ lease: renewed, evidence: null, outcome: null });
    await f.owner.run(f.input);
    expect(exchangeWorkerCellCapacity).toHaveBeenCalledWith(expect.anything(), renewed, expect.anything(), f.stop.signal);
    expect(runWindowsWorkerAssignmentRuntime).toHaveBeenCalledWith(expect.objectContaining({ lease: renewed }));
  });
  it.each([false, true])("requires verified installation evidence before native execution (failed=%s)", async failed => {
    const f = fixture();
    const evidence = { record: { outcomeHex: "retained-failure" } } as NonNullable<Awaited<ReturnType<typeof ensureWindowsWorkerAssignmentInstallation>>["evidence"]>;
    const outcome = { installation: { verified: !failed, error: failed ? 5 : 0 } } as NonNullable<Awaited<ReturnType<typeof ensureWindowsWorkerAssignmentInstallation>>["outcome"]>;
    vi.mocked(ensureWindowsWorkerAssignmentInstallation).mockResolvedValue({ lease: f.input.lease, evidence, outcome });
    if (failed) await expect(f.owner.run(f.input)).rejects.toThrow("failed runtime installation");
    else await expect(f.owner.run(f.input)).resolves.toEqual({ lease: f.result.lease });
    expect(f.input.observed.nativeInstallationEvidence).toEqual(evidence);
    expect(exchangeWorkerCellCapacity).toHaveBeenCalledTimes(failed ? 0 : 1);
    expect(runWindowsWorkerAssignmentRuntime).toHaveBeenCalledTimes(failed ? 0 : 1);
  });
  it("does not dispatch after cancellation during installation reconciliation", async () => {
    const f = fixture();
    vi.mocked(ensureWindowsWorkerAssignmentInstallation).mockImplementation(async () => {
      f.stop.abort(); return { lease: f.input.lease, evidence: null, outcome: null };
    });
    await expect(f.owner.run(f.input)).rejects.toThrow();
    expect(exchangeWorkerCellCapacity).not.toHaveBeenCalled(); expect(runWindowsWorkerAssignmentRuntime).not.toHaveBeenCalled();
  });
  it.each(["rejected", "generation", "custody", "policy", "installation", "snapshot", "runtime", "cancel"])("refuses %s without retry or fallback", async mode => {
    const f = fixture();
    const input = mode === "rejected" ? { ...f.input, continuation: { ...f.input.continuation, decision: "rejected" as const } }
      : mode === "generation" ? { ...f.input, lease: { ...f.input.lease, assignmentGeneration: f.input.lease.assignmentGeneration + 1 } } : f.input;
    if (mode === "custody") vi.mocked(requireWorkerProtectedKeyOwner).mockImplementation(() => { throw new Error("custody"); });
    if (mode === "policy") f.resolve.mockRejectedValue(new Error("policy"));
    if (mode === "installation") vi.mocked(ensureWindowsWorkerAssignmentInstallation).mockRejectedValue(new Error("installation"));
    if (mode === "snapshot") vi.mocked(exchangeWorkerCellCapacity).mockRejectedValue(new Error("snapshot"));
    if (mode === "runtime") vi.mocked(runWindowsWorkerAssignmentRuntime).mockRejectedValue(new Error("runtime"));
    if (mode === "cancel") vi.mocked(runWindowsWorkerAssignmentRuntime).mockImplementation(async () => { f.stop.abort(); return f.result; });
    await expect(f.owner.run(input)).rejects.toThrow();
    expect(runWindowsWorkerAssignmentRuntime).toHaveBeenCalledTimes(["runtime", "cancel"].includes(mode) ? 1 : 0);
    expect(f.input.observed.nativeRuntimeOutcome).toBeUndefined();
  });
});
