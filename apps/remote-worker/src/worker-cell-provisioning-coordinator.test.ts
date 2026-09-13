import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteWorkerCellProvisioningPlanSha256, type RemoteWorkerCellPreparation, type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";
import { provisionWorkerCell, type WorkerCellProvisioningInput, type WorkerCellProvisioningNativePort } from "./worker-cell-provisioning-coordinator.js";
import { createFileWorkerDurableState, createInMemoryWorkerDurableState, type WorkerDurableStatePort } from "./worker-durable-state.js";
import { workerCellProvisioningFixture } from "./worker-cell-provisioning-test-fixture.js";
import { volumeExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-volume-test-fixture.js";
import { formatExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-format-test-fixture.js";
import { protectionExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-protection-test-fixture.js";
import { mountExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-mount-test-fixture.js";
import { mountedWorkspaceExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-mounted-workspace-test-fixture.js";

function fixture(state: WorkerDurableStatePort = createInMemoryWorkerDurableState(), virtualDiskMiB = 16) {
  state = { ...state };
  const f = workerCellProvisioningFixture(virtualDiskMiB);
  let snapshot = f.exchange;
  let decision: RemoteWorkerCellPreparation["decision"] = "create_once";
  const controller = new AbortController();
  const assertCurrent = vi.fn(async () => undefined);
  const prepare = vi.fn(async () => {
    const prepared = { ...f.prepared, decision, exchange: snapshot };
    decision = "reconcile";
    return prepared;
  });
  const exchange = vi.fn<WorkerCellProvisioningInput["exchange"]>(async (submission) => {
    if (submission.kind === "cell.provisioning.checkpoint") {
      expect(submission.expectedSequence).toBe(snapshot.records.length);
      snapshot = { ...snapshot, leaseRevision: snapshot.leaseRevision + 1, records: [...snapshot.records, submission.recordHex] };
    } else if (submission.kind === "cell.volume.checkpoint") {
      expect(submission.expectedSequence).toBe(snapshot.volumeRecords?.length ?? 0);
      snapshot = { ...snapshot, leaseRevision: snapshot.leaseRevision + 1, volumeRecords: [...(snapshot.volumeRecords ?? []), submission.recordHex] };
    } else if (submission.kind === "cell.format.checkpoint") {
      expect(submission.expectedSequence).toBe(snapshot.formatRecords?.length ?? 0);
      snapshot = { ...snapshot, leaseRevision: snapshot.leaseRevision + 1, formatRecords: [...(snapshot.formatRecords ?? []), submission.recordHex] };
    } else if (submission.kind === "cell.protection.checkpoint") {
      expect(submission.expectedSequence).toBe(snapshot.protectionRecords?.length ?? 0);
      snapshot = { ...snapshot, leaseRevision: snapshot.leaseRevision + 1, protectionRecords: [...(snapshot.protectionRecords ?? []), submission.recordHex] };
    } else if (submission.kind === "cell.mount.checkpoint") {
      expect(submission.expectedSequence).toBe(snapshot.mountRecords?.length ?? 0);
      snapshot = { ...snapshot, leaseRevision: snapshot.leaseRevision + 1, mountRecords: [...(snapshot.mountRecords ?? []), submission.recordHex] };
    } else if (submission.kind === "cell.mounted-workspace.checkpoint") {
      expect(submission.expectedSequence).toBe(snapshot.mountedWorkspaceRecords?.length ?? 0);
      snapshot = { ...snapshot, leaseRevision: snapshot.leaseRevision + 1, mountedWorkspaceRecords: [...(snapshot.mountedWorkspaceRecords ?? []), submission.recordHex] };
    }
    return snapshot;
  });
  const create = vi.fn<WorkerCellProvisioningNativePort["create"]>(async (_plan, commit) => {
    for (const record of f.records) expect(await commit(record)).toBe(record.slice(-64));
  });
  const recover = vi.fn<WorkerCellProvisioningNativePort["recover"]>(async () => snapshot.records);
  const createVolume = vi.fn<NonNullable<WorkerCellProvisioningNativePort["createVolume"]>>(async (_plan, commit, authorize) => {
    for (const record of f.records) expect(await commit(record)).toBe(record.slice(-64));
    const volume = volumeExchangeFixture({ ...f.exchange, records: f.records });
    for (const record of volume.volumeRecords!) { await authorize(); expect(await commit(record)).toBe(record.slice(-64)); }
    await authorize();
  });
  const recoverVolume = vi.fn<NonNullable<WorkerCellProvisioningNativePort["recoverVolume"]>>(async () => ({
    records: snapshot.records, volumeRecords: snapshot.volumeRecords ?? [] }));
  const createFormat = vi.fn<NonNullable<WorkerCellProvisioningNativePort["createFormat"]>>(async (_plan, commit, authorize) => {
    for (const record of f.records) expect(await commit(record)).toBe(record.slice(-64));
    const full = formatExchangeFixture({ ...f.exchange, records: f.records });
    for (const record of [...full.volumeRecords!, ...full.formatRecords!]) {
      await authorize(); expect(await commit(record)).toBe(record.slice(-64));
    }
    await authorize();
  });
  const recoverFormat = vi.fn<NonNullable<WorkerCellProvisioningNativePort["recoverFormat"]>>(async () => ({
    records: snapshot.records, volumeRecords: snapshot.volumeRecords ?? [], formatRecords: snapshot.formatRecords ?? [] }));
  const createProtection = vi.fn<NonNullable<WorkerCellProvisioningNativePort["createProtection"]>>(async (_plan, commit, authorize) => {
    for (const record of f.records) expect(await commit(record)).toBe(record.slice(-64));
    const full = protectionExchangeFixture({ ...f.exchange, records: f.records });
    for (const record of [...full.volumeRecords!, ...full.formatRecords!, ...full.protectionRecords!]) {
      await authorize(); expect(await commit(record)).toBe(record.slice(-64));
    }
    await authorize();
  });
  const recoverProtection = vi.fn<NonNullable<WorkerCellProvisioningNativePort["recoverProtection"]>>(async () => ({
    records: snapshot.records, volumeRecords: snapshot.volumeRecords ?? [], formatRecords: snapshot.formatRecords ?? [],
    protectionRecords: snapshot.protectionRecords ?? [] }));
  const createMount = vi.fn<NonNullable<WorkerCellProvisioningNativePort["createMount"]>>(async (_plan, commit, authorize) => {
    for (const record of f.records) expect(await commit(record)).toBe(record.slice(-64));
    const full = mountExchangeFixture({ ...f.exchange, records: f.records });
    for (const record of [...full.volumeRecords!, ...full.formatRecords!, ...full.protectionRecords!, ...full.mountRecords!]) {
      await authorize(); expect(await commit(record)).toBe(record.slice(-64));
    }
    await authorize();
  });
  const recoverMount = vi.fn<NonNullable<WorkerCellProvisioningNativePort["recoverMount"]>>(async () => ({
    records: snapshot.records, volumeRecords: snapshot.volumeRecords ?? [], formatRecords: snapshot.formatRecords ?? [],
    protectionRecords: snapshot.protectionRecords ?? [], mountRecords: snapshot.mountRecords ?? [] }));
  const createMountedWorkspace = vi.fn<NonNullable<WorkerCellProvisioningNativePort["createMountedWorkspace"]>>(async (_plan, commit, authorize) => {
    for (const record of f.records) expect(await commit(record)).toBe(record.slice(-64));
    const full = mountedWorkspaceExchangeFixture({ ...f.exchange, records: f.records });
    for (const record of [...full.volumeRecords!, ...full.formatRecords!, ...full.protectionRecords!, ...full.mountRecords!, ...full.mountedWorkspaceRecords!]) {
      await authorize(); expect(await commit(record)).toBe(record.slice(-64));
    }
    await authorize();
  });
  const recoverMountedWorkspace = vi.fn<NonNullable<WorkerCellProvisioningNativePort["recoverMountedWorkspace"]>>(async () => ({
    records: snapshot.records, volumeRecords: snapshot.volumeRecords ?? [], formatRecords: snapshot.formatRecords ?? [],
    protectionRecords: snapshot.protectionRecords ?? [], mountRecords: snapshot.mountRecords ?? [], mountedWorkspaceRecords: snapshot.mountedWorkspaceRecords ?? [] }));
  const native = vi.fn(() => ({ create, recover, createVolume, recoverVolume, createFormat, recoverFormat, createProtection, recoverProtection, createMount, recoverMount, createMountedWorkspace, recoverMountedWorkspace }));
  const input: WorkerCellProvisioningInput = { scope: f.lease, state, custody: f.custody, signal: controller.signal,
    assertCurrent, prepare, exchange, native };
  return { ...f, input, state, controller, assertCurrent, prepare, exchange, native, create, recover, createVolume, recoverVolume, createFormat, recoverFormat,
    createProtection, recoverProtection, createMount, recoverMount, createMountedWorkspace, recoverMountedWorkspace,
    snapshot: () => snapshot, setSnapshot: (value: RemoteWorkerCellProvisioningExchange) => { snapshot = value; } };
}

afterEach(() => vi.useRealTimers());
describe("worker canonical/native cell provisioning coordinator", () => {
  it("records and independently recovers all twenty-one checkpoints without repeating creation", async () => {
    const f = fixture(undefined, 64), input = { ...f.input, requireMountedWorkspace: true };
    const first = await provisionWorkerCell(input);
    expect(first.status).toBe("recorded"); expect(first.snapshot.mountedWorkspaceRecords).toHaveLength(2);
    expect((await provisionWorkerCell(input)).status).toBe("recovery_verified");
    expect(f.createMountedWorkspace).toHaveBeenCalledOnce(); expect(f.recoverMountedWorkspace).toHaveBeenCalledOnce();
    expect(f.createMount).not.toHaveBeenCalled(); expect(f.recoverMount).not.toHaveBeenCalled();
    expect(f.exchange.mock.calls.filter(([submission]) => submission.kind === "cell.mounted-workspace.checkpoint")).toHaveLength(2);
  });
  it.each([0, 1])("reconciles %s workspace records without creating missing directories", async (length) => {
    const f = fixture(undefined, 64), full = mountedWorkspaceExchangeFixture({ ...f.prepared.exchange, records: f.records });
    f.prepare.mockResolvedValueOnce({ ...f.prepared, decision: "reconcile", exchange: { ...full, mountedWorkspaceRecords: full.mountedWorkspaceRecords!.slice(0, length) } });
    expect(await provisionWorkerCell({ ...f.input, requireMountedWorkspace: true })).toMatchObject({ status: "reconciliation_required", reason: "incomplete_journal" });
    expect(f.native).not.toHaveBeenCalled();
  });
  it.each([1, 2])("stops when workspace acknowledgement %s omits committed evidence", async (length) => {
    const f = fixture(undefined, 64), exchange = f.exchange.getMockImplementation()!;
    f.exchange.mockImplementation(async (...args) => {
      const value = await exchange(...args);
      return args[0].kind === "cell.mounted-workspace.checkpoint" && value.mountedWorkspaceRecords?.length === length
        ? { ...value, mountedWorkspaceRecords: value.mountedWorkspaceRecords.slice(0, -1) } : value;
    });
    await expect(provisionWorkerCell({ ...f.input, requireMountedWorkspace: true })).rejects.toThrow();
    expect(f.snapshot().mountedWorkspaceRecords).toHaveLength(length);
    expect(f.createMountedWorkspace).toHaveBeenCalledOnce();
  });
  it("requires independent returned workspace evidence and a driver that can verify it", async () => {
    const f = fixture(undefined, 64), input = { ...f.input, requireMountedWorkspace: true };
    await provisionWorkerCell(input);
    const observed = await f.recoverMountedWorkspace(f.snapshot());
    f.recoverMountedWorkspace.mockResolvedValueOnce({ ...observed, mountedWorkspaceRecords: [] });
    expect(await provisionWorkerCell(input)).toMatchObject({ status: "reconciliation_required", reason: "checkpoint_mismatch" });
    const port = f.native();
    expect(await provisionWorkerCell({ ...input, native: () => ({ ...port, recoverMountedWorkspace: undefined }) }))
      .toMatchObject({ status: "reconciliation_required", reason: "workspace_verification_unavailable" });
    expect(await provisionWorkerCell({ ...f.input, requireMount: true }))
      .toMatchObject({ status: "reconciliation_required", reason: "workspace_verification_unavailable" });
    expect(f.createMountedWorkspace).toHaveBeenCalledOnce();
  });
  it("detects workspace history rollback during a fresh authorization read", async () => {
    const f = fixture(undefined, 64), exchange = f.exchange.getMockImplementation()!;
    f.exchange.mockImplementation(async (...args) => {
      const value = await exchange(...args);
      return args[0].kind === "cell.provisioning.snapshot" && value.mountedWorkspaceRecords?.length
        ? { ...value, mountedWorkspaceRecords: [] } : value;
    });
    await expect(provisionWorkerCell({ ...f.input, requireMountedWorkspace: true })).rejects.toThrow();
    expect(f.snapshot().mountedWorkspaceRecords).toHaveLength(1);
  });
  it("records and independently recovers nineteen checkpoints without repeating creation", async () => {
    const f = fixture(undefined, 64), input = { ...f.input, requireMount: true };
    const result = await provisionWorkerCell(input);
    expect(result.status).toBe("recorded"); expect(result.snapshot.mountRecords).toHaveLength(4);
    expect((await provisionWorkerCell(input)).status).toBe("recovery_verified");
    expect(f.createMount).toHaveBeenCalledOnce(); expect(f.recoverMount).toHaveBeenCalledOnce();
    expect(f.createProtection).not.toHaveBeenCalled(); expect(f.recoverProtection).not.toHaveBeenCalled();
    expect(f.exchange.mock.calls.filter(([submission]) => submission.kind === "cell.mount.checkpoint")).toHaveLength(4);
  });
  it.each([0, 1, 2, 3])("reconciles %s retained mount records without attempting to finish a mount", async (length) => {
    const f = fixture(undefined, 64), full = mountExchangeFixture({ ...f.prepared.exchange, records: f.records });
    f.prepare.mockResolvedValueOnce({ ...f.prepared, decision: "reconcile", exchange: { ...full, mountRecords: full.mountRecords!.slice(0, length) } });
    expect(await provisionWorkerCell({ ...f.input, requireMount: true })).toMatchObject({ status: "reconciliation_required", reason: "incomplete_journal" });
    expect(f.native).not.toHaveBeenCalled(); expect(f.exchange).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3, 4])("halts when mount checkpoint %s loses its exact canonical acknowledgement", async (length) => {
    const f = fixture(undefined, 64), exchange = f.exchange.getMockImplementation()!;
    f.exchange.mockImplementation(async (...args) => {
      const value = await exchange(...args);
      return args[0].kind === "cell.mount.checkpoint" && value.mountRecords?.length === length
        ? { ...value, mountRecords: value.mountRecords.slice(0, -1) } : value;
    });
    const input = { ...f.input, requireMount: true };
    await expect(provisionWorkerCell(input)).rejects.toThrow(/reconciliation/u);
    expect(f.snapshot().mountRecords).toHaveLength(length);
    expect((await provisionWorkerCell(input)).status).toBe(length === 4 ? "recovery_verified" : "reconciliation_required");
    expect(f.createMount).toHaveBeenCalledOnce();
  });
  it.each(["omitted", "partial"])("does not inherit %s mount evidence from the Gateway when native recovery omits it", async (failure) => {
    const f = fixture(undefined, 64), input = { ...f.input, requireMount: true };
    await provisionWorkerCell(input);
    const result = await f.recoverMount.getMockImplementation()!(f.snapshot());
    const returned = { ...result, mountRecords: result.mountRecords.slice(0, 3) };
    if (failure === "omitted") Reflect.deleteProperty(returned, "mountRecords");
    f.recoverMount.mockResolvedValueOnce(returned);
    expect(await provisionWorkerCell(input)).toMatchObject({ status: "reconciliation_required", reason: "checkpoint_mismatch" });
    expect(f.createMount).toHaveBeenCalledOnce(); expect(f.recoverProtection).not.toHaveBeenCalled();
  });
  it("halts on changed mount history during the next authority refresh", async () => {
    const f = fixture(undefined, 64), exchange = f.exchange.getMockImplementation()!;
    f.exchange.mockImplementation(async (...args) => {
      const value = await exchange(...args);
      return args[0].kind === "cell.provisioning.snapshot" && value.mountRecords?.length ? { ...value, mountRecords: [] } : value;
    });
    await expect(provisionWorkerCell({ ...f.input, requireMount: true })).rejects.toThrow(/reconciliation/u);
    expect(f.snapshot().mountRecords).toHaveLength(1); expect(f.createMount).toHaveBeenCalledOnce();
  });
  it("does not fall back to shorter creation or recovery when mount composition is absent", async () => {
    const f = fixture(undefined, 64), port = f.native.getMockImplementation()!();
    f.native.mockReturnValueOnce({ ...port, createMount: undefined } as unknown as typeof port);
    await expect(provisionWorkerCell({ ...f.input, requireMount: true })).rejects.toThrow(/reconciliation/u);
    expect(f.createProtection).not.toHaveBeenCalled(); expect(f.createMount).not.toHaveBeenCalled();
    const full = mountExchangeFixture({ ...f.prepared.exchange, records: f.records });
    f.prepare.mockResolvedValueOnce({ ...f.prepared, decision: "reconcile", exchange: full });
    f.native.mockReturnValueOnce({ ...port, recoverMount: undefined } as unknown as typeof port);
    expect(await provisionWorkerCell({ ...f.input, requireMount: true })).toMatchObject({ status: "reconciliation_required", reason: "mount_verification_unavailable" });
    expect(f.recoverProtection).not.toHaveBeenCalled(); expect(f.recoverMount).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3, 4])("retains %s mount records for reconciliation without invoking a shorter native recovery", async (length) => {
    const f = fixture(undefined, 64), full = mountExchangeFixture({ ...f.prepared.exchange, records: f.records });
    const snapshot = { ...full, mountRecords: full.mountRecords!.slice(0, length) };
    f.prepare.mockResolvedValueOnce({ ...f.prepared, decision: "reconcile", exchange: snapshot });
    expect(await provisionWorkerCell({ ...f.input, requireProtection: true })).toMatchObject({
      status: "reconciliation_required", reason: "mount_verification_unavailable", snapshot });
    expect(f.native).not.toHaveBeenCalled(); expect(f.exchange).not.toHaveBeenCalled();
  });
  it("refuses mount history that appears during a protection-only authority refresh", async () => {
    const f = fixture(undefined, 64), exchange = f.exchange.getMockImplementation()!;
    f.exchange.mockImplementation(async (...args) => {
      const result = await exchange(...args);
      return args[0].kind === "cell.provisioning.snapshot" && result.protectionRecords?.length === 2
        ? mountExchangeFixture(result) : result;
    });
    await expect(provisionWorkerCell({ ...f.input, requireProtection: true })).rejects.toThrow(/reconciliation/u);
    expect(f.recoverProtection).not.toHaveBeenCalled();
  });
  it.each([1, 2])("refuses %s protection records when only format transport is requested", async (length) => {
    const f = fixture(undefined, 64), full = protectionExchangeFixture({ ...f.prepared.exchange, records: f.records });
    f.prepare.mockResolvedValueOnce({ ...f.prepared, decision: "reconcile", exchange: { ...full, protectionRecords: full.protectionRecords!.slice(0, length) } });
    await expect(provisionWorkerCell({ ...f.input, requireFormat: true })).rejects.toThrow(/reconciliation/u);
    expect(f.native).not.toHaveBeenCalled(); expect(f.exchange).not.toHaveBeenCalled();
  });
  it("records and recovers all fifteen checkpoints through the protection port without another creation", async () => {
    const f = fixture(undefined, 64), input = { ...f.input, requireProtection: true };
    const result = await provisionWorkerCell(input);
    expect(result.status).toBe("recorded"); expect(result.snapshot.protectionRecords).toHaveLength(2);
    expect(result.snapshot.formatRecords).toHaveLength(2); expect(result.snapshot.volumeRecords).toHaveLength(6);
    expect((await provisionWorkerCell(input)).status).toBe("recovery_verified");
    expect(f.createProtection).toHaveBeenCalledOnce(); expect(f.recoverProtection).toHaveBeenCalledOnce();
    expect(f.createFormat).not.toHaveBeenCalled(); expect(f.createVolume).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
    expect(f.exchange.mock.calls.filter(([submission]) => submission.kind === "cell.protection.checkpoint")).toHaveLength(2);
  });
  it.each([0, 1])("requires reconciliation of %s protection records without resuming writes", async (length) => {
    const f = fixture(undefined, 64), full = protectionExchangeFixture({ ...f.prepared.exchange, records: f.records });
    f.prepare.mockResolvedValueOnce({ ...f.prepared, decision: "reconcile", exchange: { ...full, protectionRecords: full.protectionRecords!.slice(0, length) } });
    expect(await provisionWorkerCell({ ...f.input, requireProtection: true })).toMatchObject({ status: "reconciliation_required", reason: "incomplete_journal" });
    expect(f.native).not.toHaveBeenCalled();
  });
  it.each([1, 2])("withholds progress when protection checkpoint %s loses its exact canonical acknowledgement", async (length) => {
    const f = fixture(undefined, 64), normal = f.exchange.getMockImplementation()!;
    f.exchange.mockImplementation(async (...args) => {
      const value = await normal(...args);
      return args[0].kind === "cell.protection.checkpoint" && value.protectionRecords?.length === length
        ? { ...value, protectionRecords: value.protectionRecords.slice(0, -1) } : value;
    });
    const input = { ...f.input, requireProtection: true };
    await expect(provisionWorkerCell(input)).rejects.toThrow(/reconciliation/u);
    expect(f.snapshot().protectionRecords).toHaveLength(length);
    expect((await provisionWorkerCell(input)).status).toBe(length === 1 ? "reconciliation_required" : "recovery_verified");
    expect(f.createProtection).toHaveBeenCalledOnce();
  });
  it("refuses omitted protection history returned by native recovery", async () => {
    const f = fixture(undefined, 64), input = { ...f.input, requireProtection: true };
    await provisionWorkerCell(input);
    f.recoverProtection.mockResolvedValueOnce({ records: f.records, volumeRecords: f.snapshot().volumeRecords!,
      formatRecords: f.snapshot().formatRecords!, protectionRecords: [] });
    expect(await provisionWorkerCell(input)).toMatchObject({ status: "reconciliation_required", reason: "checkpoint_mismatch" });
    expect(f.createProtection).toHaveBeenCalledOnce();
  });
  it("refuses changed protection history during a fresh authority check", async () => {
    const f = fixture(undefined, 64), normal = f.exchange.getMockImplementation()!;
    f.exchange.mockImplementation(async (...args) => {
      const value = await normal(...args);
      return args[0].kind === "cell.provisioning.snapshot" && value.protectionRecords?.length ? { ...value, protectionRecords: [] } : value;
    });
    const input = { ...f.input, requireProtection: true };
    await expect(provisionWorkerCell(input)).rejects.toThrow(/reconciliation/u);
    expect(f.snapshot().protectionRecords).toHaveLength(1);
    expect((await provisionWorkerCell(input)).status).toBe("reconciliation_required");
    expect(f.createProtection).toHaveBeenCalledOnce();
  });
  it("does not fall back to format-only creation when protection composition is absent", async () => {
    const f = fixture(undefined, 64);
    f.native.mockReturnValueOnce({ ...f.native.getMockImplementation()!(), createProtection: undefined } as unknown as ReturnType<typeof f.native>);
    await expect(provisionWorkerCell({ ...f.input, requireProtection: true })).rejects.toThrow(/reconciliation/u);
    expect(f.createProtection).not.toHaveBeenCalled(); expect(f.createFormat).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  });
  it("records all thirteen checkpoints and recovers the exact formatted history without another creation", async () => {
    const f = fixture(undefined, 64), input = { ...f.input, requireFormat: true };
    const result = await provisionWorkerCell(input);
    expect(result.status).toBe("recorded"); expect(result.snapshot.formatRecords).toHaveLength(2);
    expect(result.snapshot.volumeRecords).toHaveLength(6);
    expect((await provisionWorkerCell(input)).status).toBe("recovery_verified");
    expect(f.createFormat).toHaveBeenCalledOnce(); expect(f.recoverFormat).toHaveBeenCalledOnce();
    expect(f.createVolume).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
    expect(f.exchange.mock.calls.filter(([submission]) => submission.kind === "cell.format.checkpoint")).toHaveLength(2);
  });
  it.each([0, 1])("never resumes formatting from a retained prefix of %s format records", async (length) => {
    const f = fixture(undefined, 64), full = formatExchangeFixture({ ...f.prepared.exchange, records: f.records });
    f.prepare.mockResolvedValueOnce({ ...f.prepared, decision: "reconcile", exchange: { ...full, formatRecords: full.formatRecords!.slice(0, length) } });
    expect(await provisionWorkerCell({ ...f.input, requireFormat: true })).toMatchObject({ status: "reconciliation_required", reason: "incomplete_journal" });
    expect(f.native).not.toHaveBeenCalled();
  });
  it("withholds formatting progress after a committed intent loses its exact acknowledgement", async () => {
    const f = fixture(undefined, 64), normal = f.exchange.getMockImplementation()!;
    f.exchange.mockImplementation(async (...args) => {
      const value = await normal(...args);
      return args[0].kind === "cell.format.checkpoint" ? { ...value, formatRecords: [] } : value;
    });
    const input = { ...f.input, requireFormat: true };
    await expect(provisionWorkerCell(input)).rejects.toThrow(/reconciliation/u);
    expect(f.snapshot().formatRecords).toHaveLength(1);
    expect((await provisionWorkerCell(input)).status).toBe("reconciliation_required");
    expect(f.createFormat).toHaveBeenCalledOnce();
  });
  it("refuses omitted format records from native recovery even when the volume history matches", async () => {
    const f = fixture(undefined, 64), input = { ...f.input, requireFormat: true };
    await provisionWorkerCell(input);
    f.recoverFormat.mockResolvedValueOnce({ records: f.records, volumeRecords: f.snapshot().volumeRecords!, formatRecords: [] });
    expect(await provisionWorkerCell(input)).toMatchObject({ status: "reconciliation_required", reason: "checkpoint_mismatch" });
    expect(f.createFormat).toHaveBeenCalledOnce();
  });
  it("commits all eleven records and checks current canonical history throughout volume creation and recovery", async () => {
    const f = fixture(undefined, 64); f.input = { ...f.input, requireVolume: true };
    const result = await provisionWorkerCell(f.input);
    expect(result.status).toBe("recorded"); expect(result.snapshot.volumeRecords).toHaveLength(6);
    expect(f.exchange.mock.calls.filter(([submission]) => submission.kind === "cell.provisioning.snapshot")).toHaveLength(8);
    expect((await provisionWorkerCell(f.input)).status).toBe("recovery_verified");
    expect(f.createVolume).toHaveBeenCalledOnce(); expect(f.recoverVolume).toHaveBeenCalledOnce();
    expect(f.create).not.toHaveBeenCalled(); expect(f.recover).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2, 3, 4, 5])("never resumes volume creation from a retained prefix of %s records", async (length) => {
    const f = fixture(undefined, 64), full = volumeExchangeFixture({ ...f.prepared.exchange, records: f.records });
    f.prepare.mockResolvedValueOnce({ ...f.prepared, decision: "reconcile", exchange: { ...full, volumeRecords: full.volumeRecords!.slice(0, length) } });
    expect(await provisionWorkerCell({ ...f.input, requireVolume: true })).toMatchObject({ status: "reconciliation_required", reason: "incomplete_journal" });
    expect(f.native).not.toHaveBeenCalled();
  });
  it("withholds further native writes when current volume history changes during an authority check", async () => {
    const f = fixture(undefined, 64), normalExchange = f.exchange.getMockImplementation()!;
    f.exchange.mockImplementation(async (...args) => {
      const result = await normalExchange(...args);
      return args[0].kind === "cell.provisioning.snapshot" && result.volumeRecords?.length
        ? { ...result, volumeRecords: [] } : result;
    });
    await expect(provisionWorkerCell({ ...f.input, requireVolume: true })).rejects.toThrow(/reconciliation/u);
    expect(f.snapshot().volumeRecords).toHaveLength(1);
    expect(f.createVolume).toHaveBeenCalledOnce();
    expect((await provisionWorkerCell({ ...f.input, requireVolume: true })).status).toBe("reconciliation_required");
    expect(f.createVolume).toHaveBeenCalledOnce();
  });
  it("refuses volume history before calling the creation-only native recovery port", async () => {
    const f = fixture(undefined, 64);
    const snapshot = volumeExchangeFixture({ ...f.prepared.exchange, records: f.records });
    f.prepare.mockResolvedValueOnce({ ...f.prepared, decision: "reconcile", exchange: snapshot });
    await expect(provisionWorkerCell(f.input)).rejects.toThrow(/reconciliation/u);
    expect(f.native).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled();
  });
  it.each([1, 2])("refuses %s retained format records before entering a native port without format support", async (count) => {
    const f = fixture(undefined, 64);
    const snapshot = formatExchangeFixture({ ...f.prepared.exchange, records: f.records });
    f.prepare.mockResolvedValueOnce({ ...f.prepared, decision: "reconcile",
      exchange: { ...snapshot, formatRecords: snapshot.formatRecords!.slice(0, count) } });
    await expect(provisionWorkerCell({ ...f.input, requireVolume: true })).rejects.toThrow(/reconciliation/u);
    expect(f.native).not.toHaveBeenCalled();
    expect(f.createVolume).not.toHaveBeenCalled();
    expect(f.recoverVolume).not.toHaveBeenCalled();
  });

  it("retains the consumed decision on disk before creation and verifies all five canonical acknowledgements", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gc-worker-cell-startup-"));
    const f = fixture(createFileWorkerDurableState(directory));
    const normalCreate = f.create.getMockImplementation()!;
    f.create.mockImplementation(async (plan, commit) => {
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      const marker = await readFile(path.join(directory, files[0]!), "utf8");
      expect(JSON.parse(marker)).toMatchObject({ assignmentId: f.lease.assignmentId, planSha256: f.snapshot().planSha256 });
      expect(marker).not.toContain(f.lease.leaseToken);
      expect(marker).not.toContain(f.custody.parentPath);
      await normalCreate(plan, commit);
    });
    const result = await provisionWorkerCell(f.input);
    expect(result.status).toBe("recorded"); expect(result.snapshot.records).toEqual(f.records);
    expect(f.create).toHaveBeenCalledOnce(); expect(f.exchange).toHaveBeenCalledTimes(6);
    expect(result).not.toHaveProperty("platformReady");
    const restarted = await provisionWorkerCell({ ...f.input, state: createFileWorkerDurableState(directory) });
    expect(restarted.status).toBe("recovery_verified");
    expect(f.recover).toHaveBeenCalledExactlyOnceWith({ plan: f.plan, preparedRecordHex: f.records[0] });
    expect(f.create).toHaveBeenCalledOnce();
  });

  it("a lost preparation reply cannot recreate even when the Gateway journal is empty", async () => {
    const f = fixture();
    const prepare = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementationOnce(async () => { await prepare(); throw new Error("reply lost after commit"); });
    await expect(provisionWorkerCell(f.input)).rejects.toThrow("reply lost");
    await expect(provisionWorkerCell(f.input)).resolves.toMatchObject({ status: "reconciliation_required", reason: "no_anchor" });
    expect(f.native).not.toHaveBeenCalled();
  });

  it.each(["before_helper", "lost_checkpoint_ack"])("retains an uncertain %s creation for recovery only", async (failure) => {
    const f = fixture();
    f.create.mockImplementationOnce(async (_plan, commit) => {
      if (failure === "lost_checkpoint_ack") await commit(f.records[0]!);
      throw new Error("native disconnected");
    });
    await expect(provisionWorkerCell(f.input)).rejects.toThrow();
    const result = await provisionWorkerCell(f.input);
    expect(result).toMatchObject({ status: "reconciliation_required", reason: failure === "before_helper" ? "no_anchor" : "incomplete_journal" });
    expect(f.create).toHaveBeenCalledOnce();
  });

  it("the retained local marker vetoes a repeated create_once response", async () => {
    const f = fixture();
    f.prepare.mockResolvedValue(f.prepared);
    f.create.mockRejectedValueOnce(new Error("disconnected"));
    await expect(provisionWorkerCell(f.input)).rejects.toThrow();
    await expect(provisionWorkerCell(f.input)).resolves.toMatchObject({ reason: "no_anchor" });
    expect(f.create).toHaveBeenCalledOnce();
  });

  it.each(["write_failure", "readback_failure", "corrupt_marker", "different_plan", "different_custody"])(
    "refuses %s before any native call", async (failure) => {
      const f = fixture();
      if (failure === "write_failure") vi.spyOn(f.state, "write").mockRejectedValue(new Error("disk full"));
      if (failure === "readback_failure") vi.spyOn(f.state, "read").mockResolvedValue(undefined);
      if (failure === "corrupt_marker") vi.spyOn(f.state, "read").mockResolvedValue("corrupt");
      if (failure.startsWith("different")) {
        f.create.mockRejectedValueOnce(new Error("interrupted"));
        await expect(provisionWorkerCell(f.input)).rejects.toThrow();
        f.create.mockClear(); f.native.mockClear();
      }
      const input = failure === "different_custody" ? { ...f.input, custody: { ...f.custody, custodySha256: "f".repeat(64) } } : f.input;
      if (failure === "different_plan") {
        // A different valid prepared plan cannot overwrite the consumed marker.
        const plan = { ...f.plan, cellName: `gc-cell-${"9".repeat(32)}` };
        f.setSnapshot({ ...f.snapshot(), plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), leaseRevision: 3 });
      }
      await expect(provisionWorkerCell(input)).rejects.toThrow();
      expect(f.native).not.toHaveBeenCalled();
    },
  );

  it.each(["foreign_assignment", "foreign_parent", "expired", "overlong", "cancelled", "refused_authority"])(
    "refuses %s before retaining a decision", async (failure) => {
      const f = fixture(); const write = vi.spyOn(f.state, "write");
      if (failure === "foreign_assignment") f.setSnapshot({ ...f.snapshot(), assignmentId: "other" });
      if (failure === "foreign_parent") Object.assign(f.input, { custody: { ...f.custody, parentIdentityHex: "0200000000000000" + "a".repeat(32) } });
      if (failure === "expired" || failure === "overlong") f.prepare.mockResolvedValue({ ...f.prepared,
        provisioningExpiresAt: new Date(Date.now() + (failure === "expired" ? -1 : 700000)).toISOString() });
      if (failure === "cancelled") f.controller.abort();
      if (failure === "refused_authority") f.assertCurrent.mockRejectedValue(new Error("revoked"));
      await expect(provisionWorkerCell(f.input)).rejects.toThrow();
      expect(write).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled();
    },
  );

  it.each(["bad_order", "wrong_ack", "extra_record", "lost_ack", "lease_regression", "revoked_after_commit", "final_drift"])(
    "refuses %s without acknowledging or retrying the uncertain mutation", async (failure) => {
      const f = fixture();
      const normalExchange = f.exchange.getMockImplementation()!;
      if (failure === "bad_order") f.create.mockImplementationOnce(async (_plan, commit) => { await commit(f.records[1]!); });
      else f.exchange.mockImplementation(async (submission, signal) => {
        const saved = await normalExchange(submission, signal);
        if (failure === "lost_ack") throw new Error("response lost");
        if (failure === "wrong_ack" || (failure === "final_drift" && submission.kind === "cell.provisioning.snapshot")) return { ...saved, records: [] };
        if (failure === "extra_record") return { ...saved, records: f.records.slice(0, 2) };
        if (failure === "lease_regression") return { ...saved, leaseRevision: 1 };
        if (failure === "revoked_after_commit") f.assertCurrent.mockRejectedValue(new Error("revoked"));
        return saved;
      });
      await expect(provisionWorkerCell(f.input)).rejects.toThrow();
      expect(f.create).toHaveBeenCalledOnce();
      expect(f.recover).not.toHaveBeenCalled();
      expect(f.exchange.mock.calls.filter(([submission]) => submission.kind === "cell.provisioning.checkpoint").length)
        .toBeLessThanOrEqual(failure === "final_drift" ? 5 : 1);
    },
  );

  it("joins a pending checkpoint when a driver returns early and rejects concurrent provisioning", async () => {
    const f = fixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    f.exchange.mockImplementationOnce(async () => { entered(); await gate; return f.snapshot(); });
    f.create.mockImplementationOnce(async (_plan, commit) => { void commit(f.records[0]!).catch(() => undefined); await started; });
    let done = false;
    const running = provisionWorkerCell(f.input).finally(() => { done = true; });
    const rejected = expect(running).rejects.toThrow();
    await started;
    await expect(provisionWorkerCell(f.input)).rejects.toThrow();
    expect(done).toBe(false);
    release(); await rejected; expect(done).toBe(true);
    await expect(provisionWorkerCell(f.input)).resolves.toMatchObject({ reason: "no_anchor" });
  });

  it("a driver cannot swallow overlapping checkpoint rejection and report success", async () => {
    const f = fixture();
    f.create.mockImplementationOnce(async (_plan, commit) => { await Promise.allSettled([commit(f.records[0]!), commit(f.records[0]!)]); });
    await expect(provisionWorkerCell(f.input)).rejects.toThrow();
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it.each(["incomplete", "different_count", "sparse", "drift"])("recovery %s cannot promote a platform or create resources", async (failure) => {
    const f = fixture();
    const records = f.records.slice(0, failure === "incomplete" ? 3 : 5);
    f.setSnapshot({ ...f.snapshot(), records });
    f.prepare.mockImplementation(async () => ({ ...f.prepared, decision: "reconcile", exchange: f.snapshot() }));
    if (failure === "different_count") f.recover.mockResolvedValue(f.records.slice(0, 3));
    if (failure === "sparse") f.recover.mockResolvedValue(new Array<string>(5));
    if (failure === "drift") f.exchange.mockResolvedValue({ ...f.snapshot(), records: f.records.slice(0, 3) });
    if (failure === "sparse" || failure === "drift") await expect(provisionWorkerCell(f.input)).rejects.toThrow();
    else await expect(provisionWorkerCell(f.input)).resolves.toMatchObject({ status: "reconciliation_required",
      reason: failure === "incomplete" ? "incomplete_journal" : "checkpoint_mismatch" });
    expect(f.create).not.toHaveBeenCalled();
  });
});
