import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, readRemoteWorkerCellProvisioningCheckpoint,
  remoteWorkerRuntimeInstallRequestSha256, readRemoteWorkerRuntimeInstallOutcome } from "@goatcitadel/contracts";
import { objectInventoryHistoryFixture } from "../../../packages/contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import type { RouteContext } from "./connected-worker-routes.js";
import { recoverWindowsWorkerAssignmentInstallation, reconcileWindowsWorkerAssignmentInstallation } from "./worker-windows-installation-recovery.js";
import { readWorkerLeaseControl, renewWorkerLeaseControl } from "./worker-lease-control.js";
import { workerLocalStateActivity } from "./worker-local-state-activity.js";
import { withWindowsWorkerAssignmentAuthority } from "./worker-windows-assignment-authority.js";
import { exchangeWorkerCellCapacity } from "./worker-cell-capacity-client.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import { createWindowsWorkerCellProvisioning, readWindowsWorkerCellControllerCustody } from "./worker-windows-cell-provisioning.js";

vi.mock("./worker-lease-control.js", () => ({ renewWorkerLeaseControl: vi.fn(), readWorkerLeaseControl: vi.fn() }));
vi.mock("./worker-cell-capacity-client.js", () => ({ exchangeWorkerCellCapacity: vi.fn() }));
vi.mock("./worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
vi.mock("./worker-windows-cell-provisioning.js", () => ({ createWindowsWorkerCellProvisioning: vi.fn(), readWindowsWorkerCellControllerCustody: vi.fn() }));

function fixture(failed = false) {
  const history = objectInventoryHistoryFixture(), first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
  const request = { schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, nonce: "11".repeat(32),
    journalIdentityHex: first.journalIdentityHex, preparedSha256: first.recordSha256,
    checkpointSha256: history.mountedWorkspaceRecords![1]!.slice(-64), packageSha256: "55".repeat(32),
    runtimeBundle: { schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files: [
      { relativePath: "node.exe", bytes: 100, sha256: "66".repeat(32) },
      { relativePath: "worker-host-receipt.json", bytes: 20, sha256: "77".repeat(32) },
    ] } };
  const bytes = Buffer.alloc(352); bytes.write("GCRLI001"); bytes.write("GCRLIT01", 256);
  for (const [offset, value] of [[8, request.nonce], [40, remoteWorkerRuntimeInstallRequestSha256(request)],
    [72, request.checkpointSha256], [104, request.journalIdentityHex], [128, request.preparedSha256],
    [160, history.plan.assignmentBindingSha256], [192, history.plan.profileSha256]] as const) Buffer.from(value, "hex").copy(bytes, offset);
  createHash("sha256").update("goatcitadel.worker-runtime-install-local-intent.v1\0").update(bytes.subarray(0, 224)).digest().copy(bytes, 224);
  bytes.copy(bytes, 288, 224, 256); bytes.writeUInt32LE(failed ? 5 : 0, 264);
  bytes.writeUInt32LE(failed ? 0 : 1, 268); bytes.writeUInt32LE(failed ? 1 : 2, 272); bytes.writeBigUInt64LE(failed ? 10n : 120n, 280);
  createHash("sha256").update("goatcitadel.worker-runtime-install-local-outcome.v1\0").update(bytes.subarray(0, 320)).digest().copy(bytes, 320);
  const outcomeHex = bytes.toString("hex"), stop = new AbortController();
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 0x31)]).toString("base64url");
  const reference = { kind: "windows_provisioner", keysetGeneration: 1, protectedStateSha256: "4".repeat(64),
    keysetReceiptSha256: "5".repeat(64), workerPublicKeySpkiBase64Url: spki };
  const context = { credential: { registryWorkspaceId: history.registryWorkspaceId, protectedKey: reference },
    protectedKeys: { reference, admissionSignerSpkiBase64Url: spki, signPopV2: vi.fn(), signAdmissionEnvelope: vi.fn() } } as unknown as RouteContext;
  const lease = { registryWorkspaceId: history.registryWorkspaceId, assignmentId: history.assignmentId,
    assignmentGeneration: history.assignmentGeneration, leaseRevision: history.leaseRevision, leaseToken: "private-lease" };
  const record = { outcomeHex, outcomeSha256: outcomeHex.slice(-64), leaseRevision: lease.leaseRevision, recordedAt: "2026-09-16T00:00:00.000Z" };
  const state = { record: null as typeof record | null, revoked: false, changedHistory: false, lostWrite: false, forgetAfterWrite: false, selectionMissing: false };
  let revision = lease.leaseRevision;
  vi.mocked(renewWorkerLeaseControl).mockImplementation(async input => ({ ...input, lease: { ...lease, leaseRevision: ++revision },
    control: { status: 200, body: { disposition: "active" } } }) as Awaited<ReturnType<typeof renewWorkerLeaseControl>>);
  vi.mocked(exchangeWorkerCellCapacity).mockImplementation(async (_context, binding) => ({
    schemaVersion: REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, record: null,
    history: { ...history, assignmentId: state.changedHistory ? "other" : history.assignmentId, leaseRevision: binding.leaseRevision } }));
  vi.mocked(callProtectedRoute).mockImplementation(async call => {
    call.signal?.throwIfAborted();
    if (state.revoked) throw new Error("Canonical read authority revoked");
    const submission = call.payload.submission as { kind: string; outcomeHex?: string; challenge?: string };
    if (submission.kind === "runtime.install.select") return { status: 200, body: {
      schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit",
      disposition: "runtime_install_selection", registryWorkspaceId: history.registryWorkspaceId,
      runtimeInstallSelection: { schemaVersion: "goatcitadel.remote-worker-runtime-install-selection.v1", challenge: submission.challenge,
        history: { ...history, leaseRevision: call.payload.leaseRevision }, request: state.selectionMissing ? null : request } } };
    if (submission.kind === "runtime.install.retain") {
      expect(submission.outcomeHex).toBe(outcomeHex); state.record = record;
      if (state.lostWrite) throw new Error("Lost retention response");
    }
    const result = { schemaVersion: "goatcitadel.remote-worker-runtime-install-exchange.v1",
      registryWorkspaceId: history.registryWorkspaceId, assignmentId: history.assignmentId, assignmentGeneration: history.assignmentGeneration,
      leaseRevision: call.payload.leaseRevision, nonce: request.nonce, requestSha256: remoteWorkerRuntimeInstallRequestSha256(request), record: state.record };
    if (state.forgetAfterWrite) state.record = null;
    return { status: 200, body: { schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit",
      disposition: "runtime_install", registryWorkspaceId: history.registryWorkspaceId, runtimeInstall: result } };
  });
  vi.mocked(readWindowsWorkerCellControllerCustody).mockResolvedValue({ parentPath: "F:\\controlled-custody" } as Awaited<ReturnType<typeof readWindowsWorkerCellControllerCustody>>);
  const installRuntime = vi.fn(async () => { throw new Error("Copying is forbidden during recovery"); });
  const recover = vi.fn<ReturnType<typeof createWindowsWorkerCellProvisioning>["recoverRuntimeInstallation"]>(async (_history, supplied, _expected, authorize) => {
    await authorize(supplied); await authorize(supplied);
    return { outcomeHex, requestSha256: remoteWorkerRuntimeInstallRequestSha256(request), nativeReceiptHex: "", outcome: readRemoteWorkerRuntimeInstallOutcome(outcomeHex, request, history) };
  });
  vi.mocked(createWindowsWorkerCellProvisioning).mockReturnValue({ recoverRuntimeInstallation: recover, installRuntime } as unknown as ReturnType<typeof createWindowsWorkerCellProvisioning>);
  const input = { context, lease, signal: stop.signal, observed: {}, history, request,
    owner: { renew: vi.fn(), remainingLeaseMs: () => 120000, workerSentThrough: () => 0 } };
  vi.mocked(readWorkerLeaseControl).mockImplementation(async (_context, binding) => ({ status: 200,
    body: { disposition: state.revoked ? "cancel_requested" : "active", assignmentId: binding.assignmentId,
      assignmentGeneration: binding.assignmentGeneration, lease: { ...binding } } }));
  return { input, state, record, recover, installRuntime, stop };
}

beforeEach(() => vi.resetAllMocks());
describe.skipIf(process.platform !== "win32")("installed installation evidence recovery", () => {
  it("leaves an assignment without a retained installation on its existing admission path", async () => {
    const f = fixture(); f.state.selectionMissing = true;
    const result = await reconcileWindowsWorkerAssignmentInstallation(f.input);
    expect(result.evidence).toBeNull(); expect(result.outcome).toBeNull();
    expect(result.lease.leaseRevision).toBeGreaterThan(f.input.lease.leaseRevision);
    expect(readWindowsWorkerCellControllerCustody).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled(); expect(f.installRuntime).not.toHaveBeenCalled();
  });
  it.each([false, true])("reconciles retained startup installation without copying (failed=%s)", async failed => {
    const f = fixture(failed), result = await reconcileWindowsWorkerAssignmentInstallation(f.input);
    expect(result.evidence?.record).toEqual(f.record);
    expect(result.outcome?.installation?.verified).toBe(!failed);
    expect(f.recover).toHaveBeenCalledOnce(); expect(f.installRuntime).not.toHaveBeenCalled();
  });
  it("defers concurrent renewal until a stable read window ends and expires escaped checks", async () => {
    const f = fixture();
    const renew = vi.mocked(renewWorkerLeaseControl).getMockImplementation()!;
    vi.mocked(renewWorkerLeaseControl).mockImplementation(input => workerLocalStateActivity.mutation(() => renew(input)));
    await withWindowsWorkerAssignmentAuthority(f.input, 3000, async authority => {
      let laterRenewal!: Promise<void>, escaped!: () => Promise<void>;
      await authority.withStableLease((_lease, check) => workerLocalStateActivity.quiescent(async () => {
        escaped = check;
        const before = vi.mocked(renewWorkerLeaseControl).mock.calls.length;
        laterRenewal = authority.assertCurrent();
        await check(); await check();
        expect(renewWorkerLeaseControl).toHaveBeenCalledTimes(before);
      }, authority.signal));
      await laterRenewal;
      await expect(escaped()).rejects.toThrow("expired");
      expect(renewWorkerLeaseControl).toHaveBeenCalledTimes(2);
    });
  });

  it("fences further authority after a stable-window check fails", async () => {
    const f = fixture();
    await withWindowsWorkerAssignmentAuthority(f.input, 3000, async authority => {
      await expect(authority.withStableLease(async (_lease, check) => {
        f.state.revoked = true; await check();
      })).rejects.toThrow("lost current authority");
      expect(authority.signal.aborted).toBe(true);
      await expect(authority.assertCurrent()).rejects.toThrow();
    });
  });
  it.each([NaN, Infinity, 900001])("refuses invalid remaining lifetime %s inside a stable lease", async remaining => {
    const f = fixture();
    let lifetime = 120000;
    f.input.owner.remainingLeaseMs = () => lifetime;
    await withWindowsWorkerAssignmentAuthority(f.input, 3000, async authority => {
      await expect(authority.withStableLease(async (_lease, check) => {
        lifetime = remaining;
        await check();
      })).rejects.toThrow();
      expect(authority.signal.aborted).toBe(true);
    });
  });
  it.each([NaN, Infinity, 900001])("rechecks invalid lifetime %s after the control read joins", async remaining => {
    const f = fixture();
    let lifetime = 120000;
    f.input.owner.remainingLeaseMs = () => lifetime;
    await withWindowsWorkerAssignmentAuthority(f.input, 3000, async authority => {
      await expect(authority.withStableLease(async (_lease, check) => {
        const read = vi.mocked(readWorkerLeaseControl).getMockImplementation()!;
        vi.mocked(readWorkerLeaseControl).mockImplementationOnce(async (...args) => {
          const result = await read(...args); lifetime = remaining; return result;
        });
        await check();
      })).rejects.toThrow();
      expect(authority.signal.aborted).toBe(true);
    });
  });
  it("persists renewal before the native hold and uses read-only checks during recovery", async () => {
    const f = fixture();
    const renew = vi.mocked(renewWorkerLeaseControl).getMockImplementation()!;
    vi.mocked(renewWorkerLeaseControl).mockImplementation(input => workerLocalStateActivity.mutation(() => renew(input)));
    const recover = f.recover.getMockImplementation()!;
    f.recover.mockImplementation((...args) => workerLocalStateActivity.quiescent(async () => {
      const renewals = vi.mocked(renewWorkerLeaseControl).mock.calls.length;
      const options = vi.mocked(createWindowsWorkerCellProvisioning).mock.calls.at(-1)![0];
      await options.assertCurrent();
      const result = await recover(...args);
      await options.assertCurrent();
      expect(renewWorkerLeaseControl).toHaveBeenCalledTimes(renewals);
      return result;
    }, f.stop.signal));
    expect((await recoverWindowsWorkerAssignmentInstallation(f.input)).evidence.record).toEqual(f.record);
    expect(readWorkerLeaseControl).toHaveBeenCalled();
  });
  it.each([false, true])("selects reviewed input from Gateway, with missing=%s", async missing => {
    const f = fixture(); f.state.selectionMissing = missing;
    const { history: _history, request: _request, ...authority } = f.input;
    const running = recoverWindowsWorkerAssignmentInstallation({ ...authority, selectRetained: true });
    if (missing) {
      await expect(running).rejects.toThrow("no retained reviewed request"); expect(f.recover).not.toHaveBeenCalled();
    } else expect((await running).evidence.record).toEqual(f.record);
    expect(f.installRuntime).not.toHaveBeenCalled();
  });
  it("rejects executable input alongside canonical selection before transport", async () => {
    const f = fixture();
    await expect(recoverWindowsWorkerAssignmentInstallation({ ...f.input, selectRetained: true })).rejects.toThrow("caller request");
    expect(callProtectedRoute).not.toHaveBeenCalled(); expect(f.recover).not.toHaveBeenCalled();
  });
  it.each([false, true])("retains exact local evidence across lease renewals (failed=%s)", async failed => {
    const f = fixture(failed), result = await recoverWindowsWorkerAssignmentInstallation(f.input);
    expect(result.evidence.record).toEqual(f.record); expect(result.lease.leaseRevision).toBeGreaterThan(f.input.lease.leaseRevision);
    expect(f.recover).toHaveBeenCalledOnce(); expect(f.installRuntime).not.toHaveBeenCalled();
    expect(vi.mocked(callProtectedRoute).mock.calls.filter(([call]) => (call.payload.submission as { kind: string }).kind === "runtime.install.retain")).toHaveLength(1);
  });
  it("returns retained canonical failure without touching local custody or copying", async () => {
    const f = fixture(true); f.state.record = f.record;
    expect((await recoverWindowsWorkerAssignmentInstallation(f.input)).evidence.record).toEqual(f.record);
    expect(readWindowsWorkerCellControllerCustody).not.toHaveBeenCalled(); expect(f.recover).not.toHaveBeenCalled();
  });
  it.each([false, true])("uses an outcome retained during custody lookup without another local read (failed=%s)", async failed => {
    const f = fixture(failed);
    vi.mocked(readWindowsWorkerCellControllerCustody).mockImplementation(async () => {
      f.state.record = f.record;
      return { parentPath: "F:\\controlled-custody" } as Awaited<ReturnType<typeof readWindowsWorkerCellControllerCustody>>;
    });
    f.recover.mockRejectedValue(new Error("Local evidence is no longer available"));
    expect((await recoverWindowsWorkerAssignmentInstallation(f.input)).evidence.record).toEqual(f.record);
    expect(createWindowsWorkerCellProvisioning).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled(); expect(f.installRuntime).not.toHaveBeenCalled();
    expect(vi.mocked(callProtectedRoute).mock.calls.some(([call]) =>
      (call.payload.submission as { kind: string }).kind === "runtime.install.retain")).toBe(false);
  });
  it.each(["revoked", "history", "custody", "intent", "cancel", "request", "lost", "readback"])("refuses %s without installing or retrying", async mode => {
    const f = fixture();
    if (mode === "revoked") f.state.revoked = true;
    if (mode === "history") f.state.changedHistory = true;
    if (mode === "custody") vi.mocked(readWindowsWorkerCellControllerCustody).mockRejectedValue(new Error("custody unavailable"));
    if (mode === "lost") f.state.lostWrite = true;
    if (mode === "readback") f.state.forgetAfterWrite = true;
    const original = f.recover.getMockImplementation()!;
    if (["intent", "cancel", "request"].includes(mode)) f.recover.mockImplementation(async (...args) => {
      if (mode === "request") await args[3]({ ...args[1], packageSha256: "88".repeat(32) });
      const local = await original(...args);
      if (mode === "cancel") f.stop.abort();
      return { ...local, outcomeHex: mode === "intent" ? local.outcomeHex.slice(0, 512) : local.outcomeHex };
    });
    await expect(recoverWindowsWorkerAssignmentInstallation(f.input)).rejects.toThrow();
    expect(f.installRuntime).not.toHaveBeenCalled(); expect(f.recover.mock.calls.length).toBeLessThanOrEqual(1);
    if (mode === "lost") {
      // The first write committed despite its lost response. The next startup
      // uses canonical recovery without reading or copying the runtime again.
      f.state.lostWrite = false;
      expect((await recoverWindowsWorkerAssignmentInstallation(f.input)).evidence.record).toEqual(f.record);
      expect(f.recover).toHaveBeenCalledOnce(); expect(f.installRuntime).not.toHaveBeenCalled();
    }
  });
  it("revokes read authority during native recovery before retention", async () => {
    const f = fixture(); f.recover.mockImplementation(async (_history, request, _expected, authorize) => {
      await authorize(request); f.state.revoked = true; await authorize(request); throw new Error("unreachable");
    });
    await expect(recoverWindowsWorkerAssignmentInstallation(f.input)).rejects.toThrow("lost current authority");
    expect(f.state.record).toBeNull(); expect(f.installRuntime).not.toHaveBeenCalled();
  });
  it("refuses changed history during recovery without retaining an outcome", async () => {
    const f = fixture(); f.recover.mockImplementation(async (_history, request, _expected, authorize) => {
      await authorize(request); f.state.changedHistory = true; await authorize(request); throw new Error("unreachable");
    });
    await expect(recoverWindowsWorkerAssignmentInstallation(f.input)).rejects.toThrow("history changed");
    expect(f.state.record).toBeNull(); expect(f.installRuntime).not.toHaveBeenCalled();
  });
});
