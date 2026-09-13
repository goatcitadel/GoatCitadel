import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteContext, LeaseBinding } from "./connected-worker-routes.js";
import { createInMemoryWorkerDurableState } from "./worker-durable-state.js";
import { workerCellProvisioningFixture } from "./worker-cell-provisioning-test-fixture.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import type { WorkerProtectedKeyOwner } from "./worker-protected-key-owner.js";
import { createWindowsWorkerCellProvisioning, readWindowsWorkerCellControllerCustody } from "./worker-windows-cell-provisioning.js";
import { prepareWindowsWorkerAssignmentCell } from "./worker-windows-cell-startup.js";
import { mountedWorkspaceExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-mounted-workspace-test-fixture.js";

vi.mock("./worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn(), WorkerProtectedRouteError: class extends Error {} }));
vi.mock("./worker-windows-cell-provisioning.js", async (original) => ({
  ...await original<typeof import("./worker-windows-cell-provisioning.js")>(),
  createWindowsWorkerCellProvisioning: vi.fn(), readWindowsWorkerCellControllerCustody: vi.fn(),
}));

function fixture() {
  const f = workerCellProvisioningFixture(64);
  const complete = mountedWorkspaceExchangeFixture({ ...f.exchange, records: f.records });
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 0x31)]);
  const reference = { kind: "windows_provisioner" as const, keysetGeneration: 1, protectedStateSha256: "4".repeat(64),
    keysetReceiptSha256: "5".repeat(64), workerPublicKeySpkiBase64Url: spki.toString("base64url") };
  const protectedKeys: WorkerProtectedKeyOwner = { reference, admissionSignerSpkiBase64Url: spki.toString("base64url"),
    signPopV2: vi.fn(), signAdmissionEnvelope: vi.fn() };
  const context = { client: {}, protectedKeys, credential: { protectedKey: reference, registryWorkspaceId: "default",
    credentialId: "credential-native", credentialGeneration: 1, workerGeneration: 1,
    authorizationCredential: "synthetic-private-credential", clientCertificateSha256: "6".repeat(64),
    workerPublicKeySpkiSha256: createHash("sha256").update(spki).digest("hex") } } as RouteContext;
  const controller = new AbortController();
  let currentLease = f.lease;
  let snapshot = f.exchange;
  let decision = f.prepared.decision;
  const owner = { remainingLeaseMs: vi.fn(() => 120000), workerSentThrough: vi.fn(() => 0),
    renew: vi.fn(async (lease: LeaseBinding) => {
      expect(lease).toEqual(currentLease);
      currentLease = { ...lease, leaseRevision: lease.leaseRevision + 1, leaseToken: `synthetic-private-lease-${lease.leaseRevision + 1}` };
      return currentLease;
    }) };
  vi.mocked(callProtectedRoute).mockImplementation(async (call) => {
    expect(call.payload.leaseRevision).toBe(currentLease.leaseRevision);
    expect(call.payload.leaseToken).toBe(currentLease.leaseToken);
    if (call.operation === "assignment.control.read") return { status: 200, body: {
      assignmentId: f.lease.assignmentId, assignmentGeneration: f.lease.assignmentGeneration, lease: currentLease, disposition: "active" } };
    const submission = call.payload.submission as { kind: string; recordHex?: string; expectedSequence?: number };
    snapshot = { ...snapshot, leaseRevision: currentLease.leaseRevision };
    const body = { schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1",
      operation: "assignment.settlement.submit", registryWorkspaceId: "default" };
    if (submission.kind === "cell.provisioning.prepare") {
      const cellPreparation = { ...f.prepared, decision, exchange: snapshot };
      decision = "reconcile";
      return { status: 200, body: { ...body, disposition: "cell_provisioning_prepared", cellPreparation } };
    }
    if (submission.kind === "cell.provisioning.checkpoint") {
      expect(submission.expectedSequence).toBe(snapshot.records.length);
      snapshot = { ...snapshot, records: [...snapshot.records, submission.recordHex!] };
    } else if (submission.kind === "cell.volume.checkpoint") {
      expect(submission.expectedSequence).toBe(snapshot.volumeRecords?.length ?? 0);
      snapshot = { ...snapshot, volumeRecords: [...(snapshot.volumeRecords ?? []), submission.recordHex!] };
    } else if (submission.kind === "cell.format.checkpoint") {
      expect(submission.expectedSequence).toBe(snapshot.formatRecords?.length ?? 0);
      snapshot = { ...snapshot, formatRecords: [...(snapshot.formatRecords ?? []), submission.recordHex!] };
    } else if (submission.kind === "cell.protection.checkpoint") {
      expect(submission.expectedSequence).toBe(snapshot.protectionRecords?.length ?? 0);
      snapshot = { ...snapshot, protectionRecords: [...(snapshot.protectionRecords ?? []), submission.recordHex!] };
    } else if (submission.kind === "cell.mount.checkpoint") {
      expect(submission.expectedSequence).toBe(snapshot.mountRecords?.length ?? 0);
      snapshot = { ...snapshot, mountRecords: [...(snapshot.mountRecords ?? []), submission.recordHex!] };
    } else if (submission.kind === "cell.mounted-workspace.checkpoint") {
      expect(submission.expectedSequence).toBe(snapshot.mountedWorkspaceRecords?.length ?? 0);
      snapshot = { ...snapshot, mountedWorkspaceRecords: [...(snapshot.mountedWorkspaceRecords ?? []), submission.recordHex!] };
    }
    return { status: 200, body: { ...body, disposition: "cell_provisioning_recorded", cellProvisioning: snapshot } };
  });
  vi.mocked(readWindowsWorkerCellControllerCustody).mockImplementation(async (options) => {
    await options.assertCurrent(); options.signal.throwIfAborted(); return f.custody;
  });
  const create = vi.fn<ReturnType<typeof createWindowsWorkerCellProvisioning>["createMountedWorkspace"]>();
  const recover = vi.fn<ReturnType<typeof createWindowsWorkerCellProvisioning>["recoverMountedWorkspace"]>(async () => ({
    records: snapshot.records, volumeRecords: snapshot.volumeRecords ?? [], formatRecords: snapshot.formatRecords ?? [],
    protectionRecords: snapshot.protectionRecords ?? [], mountRecords: snapshot.mountRecords ?? [], mountedWorkspaceRecords: snapshot.mountedWorkspaceRecords ?? [] }));
  const legacyCreate = vi.fn(async () => { throw new Error("Creation-only fallback is forbidden."); });
  const legacyRecover = vi.fn(async (): Promise<readonly string[]> => { throw new Error("Creation-only fallback is forbidden."); });
  const legacyVolumeRecover = vi.fn(async () => { throw new Error("Volume-only fallback is forbidden."); });
  const legacyFormatRecover = vi.fn(async () => { throw new Error("Format-only fallback is forbidden."); });
  const legacyProtectionRecover = vi.fn(async () => { throw new Error("Protection-only fallback is forbidden."); });
  const legacyMountRecover = vi.fn(async () => { throw new Error("Mount-only fallback is forbidden."); });
  vi.mocked(createWindowsWorkerCellProvisioning).mockImplementation((options) => {
    create.mockImplementation(async (_plan, commit, authorize) => {
      await options.assertCurrent();
      for (const record of f.records) expect(await commit(record)).toBe(record.slice(-64));
      for (const record of [...complete.volumeRecords!, ...complete.formatRecords!, ...complete.protectionRecords!, ...complete.mountRecords!, ...complete.mountedWorkspaceRecords!]) {
        await authorize(); expect(await commit(record)).toBe(record.slice(-64));
      }
      await authorize();
    });
    return { create: legacyCreate, recover: legacyRecover, createVolume: legacyCreate, recoverVolume: legacyVolumeRecover,
      createFormat: legacyCreate, recoverFormat: legacyFormatRecover, createProtection: legacyCreate, recoverProtection: legacyProtectionRecover,
      createMount: legacyCreate, recoverMount: legacyMountRecover, createMountedWorkspace: create, recoverMountedWorkspace: recover };
  });
  const state = createInMemoryWorkerDurableState();
  return { ...f, owner, context, controller, create, recover, complete, legacyCreate, legacyRecover, legacyVolumeRecover, legacyFormatRecover, legacyProtectionRecover, legacyMountRecover,
    currentLease: () => currentLease, snapshot: () => snapshot,
    input: { context, owner, state, lease: f.lease, signal: controller.signal, observed: {} } };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());
describe.skipIf(process.platform !== "win32")("protected Windows cell startup composition", () => {
  // This covers creation plus recovery, validating the full twenty-one-record
  // chain through every rotated-lease exchange in both flows.
  it("uses the current rotated lease, installed custody and controller-only helper for every checkpoint", { timeout: 15000 }, async () => {
    const f = fixture();
    const result = await prepareWindowsWorkerAssignmentCell(f.input);
    expect(result.lease).toEqual(f.currentLease()); expect(result.lease.leaseRevision).toBeGreaterThan(f.lease.leaseRevision);
    expect(result.provisioning).toMatchObject({ status: "recorded", snapshot: { records: f.records } });
    expect(readWindowsWorkerCellControllerCustody).toHaveBeenCalledOnce();
    expect(createWindowsWorkerCellProvisioning).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      controllerService: true, parentPath: f.custody.parentPath, wallMs: expect.any(Number), signal: expect.any(AbortSignal),
    }));
    expect(f.create).toHaveBeenCalledOnce();
    const restarted = await prepareWindowsWorkerAssignmentCell({ ...f.input, lease: result.lease });
    expect(restarted.provisioning.status).toBe("recovery_verified"); expect(f.create).toHaveBeenCalledOnce();
    expect(f.recover).toHaveBeenCalledOnce();
    expect(f.snapshot().records).toHaveLength(5);
    expect(f.snapshot().volumeRecords).toEqual(f.complete.volumeRecords);
    expect(f.snapshot().formatRecords).toEqual(f.complete.formatRecords);
    expect(f.snapshot().protectionRecords).toEqual(f.complete.protectionRecords);
    expect(f.snapshot().mountRecords).toEqual(f.complete.mountRecords);
    expect(f.snapshot().mountedWorkspaceRecords).toEqual(f.complete.mountedWorkspaceRecords);
    expect(f.legacyCreate).not.toHaveBeenCalled(); expect(f.legacyRecover).not.toHaveBeenCalled();
    expect(f.legacyVolumeRecover).not.toHaveBeenCalled();
    expect(f.legacyFormatRecover).not.toHaveBeenCalled();
    expect(f.legacyProtectionRecover).not.toHaveBeenCalled();
    expect(f.legacyMountRecover).not.toHaveBeenCalled();
    expect(restarted).not.toHaveProperty("platformReady");
  });

  it.each(["pem", "missing_key_owner", "wrong_workspace", "custody_refused", "cancelled", "expired_lease", "cancelled_assignment"])(
    "refuses %s without native creation or fallback", async (failure) => {
      const f = fixture();
      if (failure === "pem") f.input.context = { ...f.context, credential: { ...f.context.credential,
        protectedKey: undefined, signingPrivateKeyPem: "synthetic" } };
      if (failure === "missing_key_owner") f.input.context = { ...f.context, protectedKeys: undefined };
      if (failure === "wrong_workspace") f.input.lease = { ...f.lease, registryWorkspaceId: "other" };
      if (failure === "custody_refused") vi.mocked(readWindowsWorkerCellControllerCustody).mockRejectedValueOnce(new Error("not installed"));
      if (failure === "cancelled") f.controller.abort();
      if (failure === "expired_lease") f.owner.remainingLeaseMs.mockReturnValue(0);
      if (failure === "cancelled_assignment") vi.mocked(callProtectedRoute).mockImplementationOnce(async (call) => ({ status: 200,
        body: { assignmentId: call.payload.assignmentId, assignmentGeneration: call.payload.assignmentGeneration,
          lease: f.currentLease(), disposition: "cancel_requested" } }));
      await expect(prepareWindowsWorkerAssignmentCell(f.input)).rejects.toThrow();
      expect(createWindowsWorkerCellProvisioning).not.toHaveBeenCalled();
      expect(callProtectedRoute).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "assignment.settlement.submit" }));
    },
  );

  it("cancels an owned native call when its last confirmed lease window expires", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.owner.remainingLeaseMs.mockReturnValue(1000);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(createWindowsWorkerCellProvisioning).mockImplementation((options) => ({
      recover: f.legacyRecover, create: f.legacyCreate, recoverVolume: f.legacyVolumeRecover, createVolume: f.legacyCreate,
      recoverFormat: f.legacyFormatRecover, createFormat: f.legacyCreate, recoverProtection: f.legacyProtectionRecover, createProtection: f.legacyCreate,
      recoverMount: f.legacyMountRecover, createMount: f.legacyCreate,
      recoverMountedWorkspace: f.recover, createMountedWorkspace: async () => {
        entered(); await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("native cancelled")), { once: true }));
      },
    }));
    const running = prepareWindowsWorkerAssignmentCell(f.input);
    const rejected = expect(running).rejects.toThrow("native cancelled");
    await started; await vi.advanceTimersByTimeAsync(1001); await rejected;
    expect(f.snapshot().records).toHaveLength(0);
  });

  it("joins a native authority check that is still retaining a lease after cancellation", async () => {
    const f = fixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const renew = f.owner.renew.getMockImplementation()!;
    f.owner.renew.mockImplementationOnce(async (lease) => { entered(); await gate; return renew(lease); });
    vi.mocked(readWindowsWorkerCellControllerCustody).mockImplementationOnce(async (options) => {
      void options.assertCurrent().catch(() => undefined);
      await started;
      throw new Error("helper interrupted its authority check");
    });
    let done = false;
    const running = prepareWindowsWorkerAssignmentCell(f.input).finally(() => { done = true; });
    const rejected = expect(running).rejects.toThrow("helper interrupted");
    await started; await Promise.resolve(); expect(done).toBe(false);
    release(); await rejected;
    expect(done).toBe(true); expect(createWindowsWorkerCellProvisioning).not.toHaveBeenCalled();
  });
});
