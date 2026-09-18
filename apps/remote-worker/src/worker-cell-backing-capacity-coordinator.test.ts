import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonString, normalizeRemoteWorkerCellBackingCapacityExchange, readRemoteWorkerCellBackingCapacityObservation,
  REMOTE_WORKER_CELL_BACKING_CAPACITY_EXCHANGE_SCHEMA_VERSION, REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT,
  type RemoteWorkerCellBackingCapacityRecord, type RemoteWorkerCellBackingCapacitySubmission } from "@goatcitadel/contracts";
import { mountedWorkspaceExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-mounted-workspace-test-fixture.js";
import { backingCapacityObservationFixture } from "../../../packages/contracts/src/remote-worker-cell-backing-capacity-test-fixture.js";
import { workerCellProvisioningFixture } from "./worker-cell-provisioning-test-fixture.js";
import { observeAndRecordWorkerCellBackingCapacity } from "./worker-cell-backing-capacity-coordinator.js";
import { observeAndRecordWorkerCellCapacity } from "./worker-cell-capacity-coordinator.js";
import { normalizeRemoteWorkerCellCapacityExchange, readRemoteWorkerCellCapacityObservation,
  REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, type RemoteWorkerCellCapacitySubmission } from "@goatcitadel/contracts";
import { capacityObservationFixture } from "../../../packages/contracts/src/remote-worker-cell-capacity-test-fixture.js";
import { createFileWorkerDurableState, createInMemoryWorkerDurableState } from "./worker-durable-state.js";
import { sha256Utf8 } from "./connected-worker-routes.js";

function fixture() {
  const native = workerCellProvisioningFixture(64);
  const history = mountedWorkspaceExchangeFixture({ ...native.exchange, records: native.records });
  const scope = { registryWorkspaceId: history.registryWorkspaceId, assignmentId: history.assignmentId, assignmentGeneration: history.assignmentGeneration };
  const observation = { ...readRemoteWorkerCellBackingCapacityObservation(backingCapacityObservationFixture(history).toString("hex"), history),
    nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT };
  let record: RemoteWorkerCellBackingCapacityRecord | null = null;
  const snapshot = () => normalizeRemoteWorkerCellBackingCapacityExchange({ schemaVersion: REMOTE_WORKER_CELL_BACKING_CAPACITY_EXCHANGE_SCHEMA_VERSION, history, record });
  const exchange = vi.fn(async (submission: RemoteWorkerCellBackingCapacitySubmission) => {
    if (submission.kind === "cell.backing_capacity.observation") record = { revision: submission.expectedRevision + 1, leaseRevision: history.leaseRevision,
      recordedAt: "2026-09-13T00:00:00.000Z", observationHex: submission.observationHex, nativeReceiptHex: submission.nativeReceiptHex };
    return snapshot();
  });
  const input = { scope, state: createInMemoryWorkerDurableState(), signal: new AbortController().signal, assertCurrent: vi.fn(async () => undefined),
    exchange, observe: vi.fn(async (_history, authorize: () => Promise<void>) => { await authorize(); return observation; }) };
  const key = `cell-backing-capacity-${sha256Utf8(canonicalJsonString(scope))}`;
  return { input, history, observation, snapshot, key };
}
describe("worker backing capacity retained delivery", () => {
  it.each(["backing", "mounted"])("serializes both streams while %s owns the assignment and retains separate records", async (firstKind) => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.input.observe.mockImplementation(async () => { await gate; return f.observation; });
    const mountedObservation = { ...readRemoteWorkerCellCapacityObservation(capacityObservationFixture(f.history).toString("hex"), f.history),
      nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT };
    let record: RemoteWorkerCellBackingCapacityRecord | null = null;
    const mounted = { ...f.input,
      exchange: vi.fn(async (submission: RemoteWorkerCellCapacitySubmission) => {
        if (submission.kind === "cell.capacity.observation") record = { revision: 1, leaseRevision: f.history.leaseRevision,
          recordedAt: "2026-09-13T00:00:00.000Z", observationHex: submission.observationHex, nativeReceiptHex: submission.nativeReceiptHex };
        return normalizeRemoteWorkerCellCapacityExchange({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, history: f.history, record });
      }),
      observe: vi.fn(async () => { await gate; return mountedObservation; }),
    };
    const hostRun = () => observeAndRecordWorkerCellBackingCapacity(f.input), mountedRun = () => observeAndRecordWorkerCellCapacity(mounted);
    const runFirst = firstKind === "backing" ? hostRun : mountedRun, runSecond = firstKind === "backing" ? mountedRun : hostRun;
    const running = runFirst();
    try { await expect(runSecond()).rejects.toThrow(/active owner/u); }
    finally { release(); }
    await running; await runSecond();
    const mountedKey = `cell-capacity-${sha256Utf8(canonicalJsonString(f.input.scope))}`;
    const hostSaved = (await f.input.state.read(f.key))!, mountedSaved = (await f.input.state.read(mountedKey))!;
    expect(JSON.parse(hostSaved).recorded.observationHex).toBe(f.observation.observationHex);
    expect(JSON.parse(mountedSaved).recorded.observationHex).toBe(mountedObservation.observationHex);
    await f.input.state.write(f.key, mountedSaved);
    await expect(hostRun()).rejects.toThrow();
    expect(await f.input.state.read(f.key)).toBe(mountedSaved);
    expect(f.input.observe).toHaveBeenCalledTimes(1); expect(mounted.observe).toHaveBeenCalledTimes(1);
  });
  it("refuses a lease regression during native authorization before recording or submitting", async () => {
    const f = fixture();
    f.input.observe.mockImplementation(async () => {
      f.input.exchange.mockResolvedValue({ ...f.snapshot(), history: { ...f.history, leaseRevision: f.history.leaseRevision - 1 } });
      return f.observation;
    });
    await expect(observeAndRecordWorkerCellBackingCapacity(f.input)).rejects.toThrow();
    expect(await f.input.state.read(f.key)).toBeUndefined();
    expect(f.input.exchange.mock.calls.every(([submission]) => submission.kind === "cell.backing_capacity.snapshot")).toBe(true);
  });
  it("persists a successful native result before submission and retains its canonical acknowledgement", async () => {
    const f = fixture(), original = f.input.exchange.getMockImplementation()!;
    f.input.exchange.mockImplementation(async (submission) => {
      if (submission.kind === "cell.backing_capacity.observation") {
        const pending = JSON.parse((await f.input.state.read(f.key))!);
        expect(pending.recorded).toBeNull(); expect(pending.submission).toEqual(submission);
      }
      return original(submission);
    });
    const result = await observeAndRecordWorkerCellBackingCapacity(f.input);
    expect(result.record?.revision).toBe(1);
    expect(JSON.parse((await f.input.state.read(f.key))!).recorded).toEqual(result.record);
    expect(f.input.observe).toHaveBeenCalledTimes(1);
    expect((await f.input.state.read(f.key))!).not.toMatch(/leaseToken|protectedAuthority/u);
  });
  it("reopens file-backed pending delivery after response loss without another native observation", async () => {
    const f = fixture(), root = await mkdtemp(join(tmpdir(), "gc-capacity-delivery-"));
    f.input.state = createFileWorkerDurableState(root);
    const original = f.input.exchange.getMockImplementation()!;
    let lost = false, leaseRevision = f.history.leaseRevision;
    f.input.exchange.mockImplementation(async (submission) => {
      const originalResult = await original(submission);
      const result = { ...originalResult, history: { ...originalResult.history, leaseRevision } };
      if (submission.kind === "cell.backing_capacity.observation" && !lost) { lost = true; throw new Error("response lost after commit"); }
      return result;
    });
    await expect(observeAndRecordWorkerCellBackingCapacity(f.input)).rejects.toThrow(/response lost/u);
    expect(JSON.parse((await f.input.state.read(f.key))!).recorded).toBeNull();
    leaseRevision++;
    f.input.state = createFileWorkerDurableState(root);
    expect((await observeAndRecordWorkerCellBackingCapacity(f.input)).record?.revision).toBe(1);
    expect(f.input.observe).toHaveBeenCalledTimes(1);
    const writes = f.input.exchange.mock.calls.map(([submission]) => submission).filter((submission) => submission.kind === "cell.backing_capacity.observation");
    expect(writes).toHaveLength(2); expect(writes[0]).toEqual(writes[1]);
  });
  it("keeps pending bytes when acknowledgement persistence fails", async () => {
    const f = fixture(), state = f.input.state;
    let writes = 0;
    f.input.state = { ...state, write: async (key, value) => { if (++writes === 2) throw new Error("local acknowledgement write failed"); await state.write(key, value); } };
    await expect(observeAndRecordWorkerCellBackingCapacity(f.input)).rejects.toThrow(/acknowledgement/u);
    expect(JSON.parse((await state.read(f.key))!).recorded).toBeNull();
    expect((await observeAndRecordWorkerCellBackingCapacity(f.input)).record?.revision).toBe(1);
    expect(f.input.observe).toHaveBeenCalledTimes(1);
  });
  it.each(["native_scope", "native_counts", "native_receipt", "native_failure", "late_authority", "changed_history", "state_write"])(
    "withholds delivery on %s failure", async (failure) => {
      const f = fixture();
      if (failure === "native_scope") f.input.observe.mockResolvedValue({ ...f.observation, assignmentId: "foreign" });
      if (failure === "native_counts") f.input.observe.mockResolvedValue({ ...f.observation, hostFileAllocatedBytes: 999 });
      if (failure === "native_receipt") f.input.observe.mockResolvedValue({ ...f.observation, nativeReceiptHex: "00".repeat(16) });
      if (failure === "native_failure") f.input.observe.mockRejectedValue(new Error("native refusal"));
      if (failure === "late_authority") f.input.observe.mockImplementation(async () => { f.input.assertCurrent.mockRejectedValue(new Error("revoked")); return f.observation; });
      if (failure === "changed_history") f.input.observe.mockImplementation(async () => {
        f.input.exchange.mockResolvedValue({ ...f.snapshot(), history: { ...f.history, assignmentId: "foreign" } }); return f.observation;
      });
      if (failure === "state_write") f.input.state = { ...f.input.state, write: async () => { throw new Error("not retained"); } };
      await expect(observeAndRecordWorkerCellBackingCapacity(f.input)).rejects.toThrow();
      expect(f.input.exchange.mock.calls.some(([submission]) => submission.kind === "cell.backing_capacity.observation")).toBe(false);
    });
  it("retains pending delivery after cancellation and rejects a concurrent observation owner", async () => {
    const f = fixture(), abort = new AbortController(), state = f.input.state;
    f.input.signal = abort.signal;
    f.input.state = { ...state, write: async (key, value) => { await state.write(key, value); abort.abort(); } };
    await expect(observeAndRecordWorkerCellBackingCapacity(f.input)).rejects.toThrow();
    expect(JSON.parse((await state.read(f.key))!).recorded).toBeNull();
    expect(f.input.exchange.mock.calls.some(([submission]) => submission.kind === "cell.backing_capacity.observation")).toBe(false);
    f.input.state = state; f.input.signal = new AbortController().signal;
    expect((await observeAndRecordWorkerCellBackingCapacity(f.input)).record?.revision).toBe(1);
    expect(f.input.observe).toHaveBeenCalledTimes(1);
    const another = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    another.input.observe.mockImplementation(async () => { await gate; return another.observation; });
    const running = observeAndRecordWorkerCellBackingCapacity(another.input);
    await expect(observeAndRecordWorkerCellBackingCapacity(another.input)).rejects.toThrow(/active owner/u);
    release(); await running;
  });
  it("preserves corrupted retained state and refuses a mismatched acknowledgement", async () => {
    const f = fixture();
    await f.input.state.write(f.key, "{broken");
    await expect(observeAndRecordWorkerCellBackingCapacity(f.input)).rejects.toThrow();
    expect(await f.input.state.read(f.key)).toBe("{broken"); expect(f.input.observe).not.toHaveBeenCalled();
    const other = fixture(), original = other.input.exchange.getMockImplementation()!;
    other.input.exchange.mockImplementation(async (submission) => {
      const result = await original(submission);
      return submission.kind === "cell.backing_capacity.observation" ? { ...result, record: null } : result;
    });
    await expect(observeAndRecordWorkerCellBackingCapacity(other.input)).rejects.toThrow();
    expect(JSON.parse((await other.input.state.read(other.key))!).recorded).toBeNull();
  });
  it("rejects changed evidence at an acknowledged revision and late native authority callbacks", async () => {
    const f = fixture();
    let lateAuthorize!: () => Promise<void>;
    f.input.observe.mockImplementation(async (_history, authorize) => { lateAuthorize = authorize; return f.observation; });
    const result = await observeAndRecordWorkerCellBackingCapacity(f.input);
    const calls = f.input.assertCurrent.mock.calls.length;
    await expect(lateAuthorize()).rejects.toThrow();
    expect(f.input.assertCurrent).toHaveBeenCalledTimes(calls);
    f.input.exchange.mockResolvedValue({ ...result, record: { ...result.record!, recordedAt: "2026-09-13T00:00:01.000Z" } });
    const saved = await f.input.state.read(f.key);
    await expect(observeAndRecordWorkerCellBackingCapacity(f.input)).rejects.toThrow();
    expect(await f.input.state.read(f.key)).toBe(saved);
    expect(f.input.observe).toHaveBeenCalledTimes(1);
  });
});
