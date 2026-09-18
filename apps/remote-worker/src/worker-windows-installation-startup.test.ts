import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readRemoteWorkerCellProvisioningCheckpoint, remoteWorkerRuntimeInstallRequestSha256 } from "@goatcitadel/contracts";
import { objectInventoryHistoryFixture } from "../../../packages/contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { ensureWindowsWorkerAssignmentInstallation } from "./worker-windows-installation-startup.js";
import { withWindowsWorkerAssignmentAuthority } from "./worker-windows-assignment-authority.js";
import { selectWorkerRuntimeInstallation, exchangeWorkerRuntimeInstallation } from "./worker-runtime-install-client.js";
import { openWorkerInstallationSession } from "./worker-installation-session-client.js";
import { createWindowsWorkerCellProvisioning, readWindowsWorkerCellControllerCustody } from "./worker-windows-cell-provisioning.js";
import { recoverWindowsWorkerAssignmentInstallation } from "./worker-windows-installation-recovery.js";
vi.mock("./worker-windows-assignment-authority.js", () => ({ withWindowsWorkerAssignmentAuthority: vi.fn() }));
vi.mock("./worker-runtime-install-client.js", () => ({ selectWorkerRuntimeInstallation: vi.fn(), exchangeWorkerRuntimeInstallation: vi.fn() }));
vi.mock("./worker-installation-session-client.js", () => ({ openWorkerInstallationSession: vi.fn() }));
vi.mock("./worker-windows-cell-provisioning.js", () => ({ createWindowsWorkerCellProvisioning: vi.fn(), readWindowsWorkerCellControllerCustody: vi.fn() }));
vi.mock("./worker-windows-installation-recovery.js", () => ({ recoverWindowsWorkerAssignmentInstallation: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const history = objectInventoryHistoryFixture(), first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
  const request = { schemaVersion: "goatcitadel.worker-runtime-install.v1" as const, nonce: "11".repeat(32),
    journalIdentityHex: first.journalIdentityHex, preparedSha256: first.recordSha256, checkpointSha256: history.mountedWorkspaceRecords!.at(-1)!.slice(-64),
    packageSha256: "55".repeat(32), runtimeBundle: { schemaVersion: "goatcitadel.worker-runtime-bundle.v1" as const,
      files: [{ relativePath: "node.exe", bytes: 100, sha256: "66".repeat(32) }, { relativePath: "worker-host-receipt.json", bytes: 20, sha256: "77".repeat(32) }] } };
  const bytes = Buffer.alloc(352); bytes.write("GCRLI001"); bytes.write("GCRLIT01", 256);
  for (const [offset, value] of [[8, request.nonce], [40, remoteWorkerRuntimeInstallRequestSha256(request)], [72, request.checkpointSha256],
    [104, request.journalIdentityHex], [128, request.preparedSha256], [160, history.plan.assignmentBindingSha256], [192, history.plan.profileSha256]] as const)
    Buffer.from(value, "hex").copy(bytes, offset);
  createHash("sha256").update("goatcitadel.worker-runtime-install-local-intent.v1\0").update(bytes.subarray(0, 224)).digest().copy(bytes, 224);
  bytes.copy(bytes, 288, 224, 256); bytes.writeUInt32LE(1, 268); bytes.writeUInt32LE(2, 272); bytes.writeBigUInt64LE(120n, 280);
  createHash("sha256").update("goatcitadel.worker-runtime-install-local-outcome.v1\0").update(bytes.subarray(0, 320)).digest().copy(bytes, 320);
  const outcomeHex = bytes.toString("hex"), record = { outcomeHex }, stop = new AbortController(), order: string[] = [];
  const lease = { registryWorkspaceId: history.registryWorkspaceId, assignmentId: history.assignmentId,
    assignmentGeneration: history.assignmentGeneration, leaseRevision: history.leaseRevision, leaseToken: "fixture" };
  const input = { context: {}, lease, signal: stop.signal, owner: {}, observed: {} } as Parameters<typeof ensureWindowsWorkerAssignmentInstallation>[0];
  const check = vi.fn(async () => { stop.signal.throwIfAborted(); });
  vi.mocked(withWindowsWorkerAssignmentAuthority).mockImplementation(async (_input, _timeout, work) => work({ context: input.context,
    signal: stop.signal, lease: () => lease, assertCurrent: check,
    withStableLease: operation => operation(lease, check), withCurrentLease: operation => operation(lease) }));
  vi.mocked(selectWorkerRuntimeInstallation).mockResolvedValue({ schemaVersion: "goatcitadel.remote-worker-runtime-install-selection.v1",
    history, request, challenge: "aa".repeat(32) });
  let retained = false;
  vi.mocked(exchangeWorkerRuntimeInstallation).mockImplementation(async (_context, _lease, _request, _history, outcome) => {
    if (outcome) { order.push("retained"); retained = true; }
    return { record: retained ? record : null } as never;
  });
  const close = vi.fn(), admission = { finish: async (join: () => Promise<void>) => { order.push("finish"); await join(); order.push("session-complete"); } };
  vi.mocked(openWorkerInstallationSession).mockResolvedValue({ history, request, capture: {}, admission, close } as never);
  vi.mocked(readWindowsWorkerCellControllerCustody).mockResolvedValue({ parentPath: "fixture-only" } as never);
  const install = vi.fn(async (_history, _request, _expected, authorize, beforeFinish) => {
    await authorize(); order.push("copy"); await beforeFinish({ outcomeHex }, stop.signal);
    await admission.finish(async () => { order.push("joined"); }); return { outcomeHex };
  });
  vi.mocked(createWindowsWorkerCellProvisioning).mockReturnValue({ installRuntimeWithCapacity: install } as never);
  vi.mocked(recoverWindowsWorkerAssignmentInstallation).mockRejectedValue(new Error("no recoverable terminal evidence"));
  return { input, lease, history, request, record, outcomeHex, stop, order, install, close };
}
describe("installed worker first-install composition", () => {
  it("selects combined capture/installation and publishes only after signed finish and joined helper", async () => {
    const f = fixture(), result = await ensureWindowsWorkerAssignmentInstallation(f.input);
    expect(result.outcome?.installation?.verified).toBe(true);
    expect(f.order).toEqual(["copy", "finish", "joined", "session-complete", "retained"]);
    expect(f.install).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
    expect(recoverWindowsWorkerAssignmentInstallation).not.toHaveBeenCalled();
  });
  it.each(["absent", "terminal"])("does not launch a helper for %s selection", async mode => {
    const f = fixture();
    if (mode === "absent") vi.mocked(selectWorkerRuntimeInstallation).mockResolvedValue({ history: f.history, request: null } as never);
    else vi.mocked(exchangeWorkerRuntimeInstallation).mockResolvedValue({ record: f.record } as never);
    await ensureWindowsWorkerAssignmentInstallation(f.input);
    expect(openWorkerInstallationSession).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled();
  });
  it.each(["copy", "retention"])("uses read-only recovery after %s uncertainty and never retries copying", async phase => {
    const f = fixture();
    if (phase === "copy") f.install.mockRejectedValue(new Error("uncertain native intent"));
    else vi.mocked(exchangeWorkerRuntimeInstallation).mockImplementation(async (_c, _l, _r, _h, outcome) => {
      if (outcome) throw new Error("lost retention response"); return { record: null } as never;
    });
    vi.mocked(recoverWindowsWorkerAssignmentInstallation).mockResolvedValue({ lease: f.lease, evidence: { record: f.record } } as never);
    const result = await ensureWindowsWorkerAssignmentInstallation(f.input);
    expect(result.outcome?.installation?.verified).toBe(true); expect(f.install).toHaveBeenCalledOnce();
    expect(recoverWindowsWorkerAssignmentInstallation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ selectRetained: true, lease: f.lease }));
  });
  it("preserves uncertain intent when read-only recovery has no terminal result", async () => {
    const f = fixture(); f.install.mockRejectedValue(new Error("uncertain native intent"));
    await expect(ensureWindowsWorkerAssignmentInstallation(f.input)).rejects.toThrow("uncertain native intent");
    expect(f.install).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
  });
  it("does not recover or publish after cancellation", async () => {
    const f = fixture(); f.install.mockImplementation(async () => { f.stop.abort(); throw new Error("cancelled"); });
    await expect(ensureWindowsWorkerAssignmentInstallation(f.input)).rejects.toThrow();
    expect(recoverWindowsWorkerAssignmentInstallation).not.toHaveBeenCalled(); expect(f.order).not.toContain("retained");
  });
});
