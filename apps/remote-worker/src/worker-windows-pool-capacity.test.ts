import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerCellProvisioningExchange, normalizeRemoteWorkerNativeCapacityLayout, readRemoteWorkerNativePoolCapacityResponse,
  REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION, type RemoteWorkerNativePoolCleanupSnapshot } from "@goatcitadel/contracts";
import { nativePoolCapacityResponseFixture } from "../../../packages/contracts/src/remote-worker-native-pool-capacity-response-test-fixture.js";
import { createWindowsWorkerCellProvisioning } from "./worker-windows-cell-provisioning.js";
import { WorkerLocalStateActivity, workerLocalStateActivity } from "./worker-local-state-activity.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
class Helper extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  private closed = false;
  readonly kill = vi.fn(() => { queueMicrotask(() => this.close(null, "SIGTERM")); return true; });
  close(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    if (this.closed) return;
    this.closed = true; this.exitCode = code; this.signalCode = signal;
    this.stdout.end(); this.stderr.end(); this.stdin.destroy(); this.emit("close", code, signal);
  }
}
function frame(kind: number, payload: Buffer) {
  const header = Buffer.alloc(5); header[0] = kind; header.writeUInt32LE(payload.length, 1); return Buffer.concat([header, payload]);
}
const children: Helper[] = [];
beforeEach(() => {
  mocks.spawn.mockReset(); const activity = new WorkerLocalStateActivity();
  vi.spyOn(workerLocalStateActivity, "quiescent").mockImplementation(activity.quiescent.bind(activity));
  vi.spyOn(workerLocalStateActivity, "mutation").mockImplementation(activity.mutation.bind(activity));
});
afterEach(() => { for (const child of children.splice(0)) child.close(1); vi.restoreAllMocks(); });

function fixture() {
  const f = nativePoolCapacityResponseFixture(), child = new Helper(); children.push(child);
  const active = f.pool.members.find(member => member.assignmentId === f.pool.assignmentId)!;
  const history = normalizeRemoteWorkerCellProvisioningExchange({ ...active.history,
    schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION, registryWorkspaceId: f.pool.registryWorkspaceId,
    assignmentId: f.pool.assignmentId, assignmentGeneration: f.pool.assignmentGeneration, leaseRevision: f.pool.leaseRevision });
  const records = [...history.records, ...history.volumeRecords!, ...history.formatRecords!, ...history.protectionRecords!, ...history.mountRecords!, ...history.mountedWorkspaceRecords!];
  const controller = new AbortController(), assertCurrent = vi.fn(async () => undefined), authorize = vi.fn(async () => undefined);
  const readPool = vi.fn(async (): Promise<RemoteWorkerNativePoolCleanupSnapshot> => ({ schemaVersion: "goatcitadel.remote-worker-native-pool-cleanup.v1",
    pool: f.pool, members: f.pool.members.map(member => ({ registryWorkspaceId: f.pool.registryWorkspaceId, assignmentId: member.assignmentId,
      assignmentGeneration: member.assignmentGeneration, expectations: [], installation: null })) }));
  const driver = createWindowsWorkerCellProvisioning({ parentPath: "F:\\owned-fixture\\cells", wallMs: 15000,
    signal: controller.signal, assertCurrent, controllerService: true, readPoolCleanup: readPool,
    readCleanup: async current => ({ exchange: { schemaVersion: "goatcitadel.remote-worker-runtime-cleanup.v1", challenge: "cc".repeat(32), history: current, expectations: [] }, installations: [] }),
    imageGuard: { pinCellProvisioningExecutor: () => ({ executorPath: path.join(process.cwd(), "fixture", "GoatCitadelRemoteWorkerCellProvisioning.exe"), lease: {} }) } });
  mocks.spawn.mockReturnValueOnce(child);
  const queue: Buffer[] = []; let waiting: ((value: Buffer) => void) | undefined;
  child.stdin.on("data", (data: Buffer) => { if (waiting) { const resolve = waiting; waiting = undefined; resolve(Buffer.from(data)); } else queue.push(Buffer.from(data)); });
  const input = () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<Buffer>(resolve => { waiting = resolve; });
  const capture = { pool: f.pool, layout: normalizeRemoteWorkerNativeCapacityLayout(f.layout), captureNonce: f.window.nonce, referencesJson: JSON.stringify(f.source.references) };
  const receipt = Buffer.alloc(16); receipt.writeUInt32LE(5, 4); receipt.writeUInt32LE(21, 12);
  const authority = async (ordinal: number) => {
    const challenge = Buffer.alloc(40); challenge.writeUInt32LE(ordinal); challenge.writeUInt32LE(21, 4);
    Buffer.from(records[20]!.slice(-64), "hex").copy(challenge, 8);
    child.stdout.write(frame(4, challenge)); expect((await input())[0]).toBe(5);
  };
  const replay = async (checks = 2) => {
    for (const record of records) child.stdout.write(frame(1, Buffer.from(record, "hex")));
    for (let ordinal = 1; ordinal <= checks; ++ordinal) await authority(ordinal);
  };
  return { ...f, child, driver, capture, history, records, receipt, input, replay, authority, controller, assertCurrent, authorize, readPool };
}
describe.skipIf(process.platform !== "win32")("full-pool helper driver", () => {
  it("retains the exact admitted request and waits for receipt, exit and final authority", async () => {
    const f = fixture(), expected = readRemoteWorkerNativePoolCapacityResponse(f.bytes.toString("hex"), f.pool, f.layout, f.window, f.source.references);
    const running = f.driver.observePoolCapacity(f.history, f.capture, f.authorize);
    let delivered = false; void running.then(() => { delivered = true; });
    f.capture.captureNonce = "ab".repeat(32); f.capture.referencesJson = "[]";
    const request = await f.input(); expect(request.readUInt32LE(8)).toBe(20); expect(request.subarray(-32).toString("hex")).toBe(f.window.nonce);
    const poolOffset = request.indexOf(Buffer.from("GCPPOOL1")); expect(poolOffset).toBeGreaterThan(0);
    expect(request.readUInt32LE(poolOffset + 8)).toBe(2);
    for (let i = 0; i < 2; ++i) expect(request.readUInt32LE(poolOffset + 136 + i * (256 + 21 * 1024))).toBe(20);
    let writerStarted = false;
    const waitingWriter = workerLocalStateActivity.mutation(async () => { writerStarted = true; });
    await f.replay(); const wire = frame(14, f.bytes);
    f.child.stdout.write(wire.subarray(0, 73)); f.child.stdout.write(wire.subarray(73));
    await new Promise<void>(resolve => setImmediate(resolve)); expect(delivered).toBe(false);
    expect(writerStarted).toBe(false);
    const finished = once(f.child.stdin, "finish"); f.child.stdout.write(frame(2, f.receipt)); await finished;
    expect(delivered).toBe(false); f.child.close();
    expect(await running).toEqual({ delivery: expected, nativeReceiptHex: f.receipt.toString("hex") });
    await waitingWriter; expect(writerStarted).toBe(true);
    expect(f.authorize).toHaveBeenCalledTimes(4); expect(f.child.kill).not.toHaveBeenCalled();
  }, 20000);
  it.each(["early", "one-authority", "duplicate", "truncated", "missing", "wrong-pool", "wrong-nonce", "wrong-layout", "native-error", "failed-exit", "revoked", "cancelled", "after-response-authority"])("withholds %s responses", async mode => {
    const f = fixture(), running = f.driver.observePoolCapacity(f.history, f.capture, f.authorize), rejected = expect(running).rejects.toThrow();
    await f.input();
    if (mode === "early") { f.child.stdout.write(frame(14, f.bytes)); await rejected; return; }
    await f.replay(mode === "one-authority" ? 1 : 2);
    const bytes = Buffer.from(f.bytes);
    if (mode === "wrong-pool") bytes[56] = bytes[56]! ^ 1;
    if (mode === "wrong-nonce") bytes[480] = bytes[480]! ^ 1;
    if (mode === "wrong-layout") bytes[160] = bytes[160]! ^ 1;
    const response = frame(14, bytes);
    if (mode !== "missing") f.child.stdout.write(mode === "truncated" ? response.subarray(0, -1) : response);
    if (mode === "duplicate") f.child.stdout.write(response);
    if (mode === "after-response-authority") { f.child.stdout.write(frame(4, Buffer.alloc(40))); await rejected; return; }
    if (mode === "native-error") f.receipt.writeUInt32LE(5, 0);
    f.child.stdout.write(frame(2, f.receipt));
    await new Promise<void>(resolve => setImmediate(resolve));
    if (mode === "revoked") f.assertCurrent.mockRejectedValue(new Error("revoked"));
    if (mode === "cancelled") f.controller.abort();
    f.child.close(mode === "failed-exit" ? 3 : 0); await rejected;
  });
  it("refuses changed protected pool membership before launching the helper", async () => {
    const f = fixture(), original = await f.readPool();
    f.readPool.mockResolvedValue({ ...original, pool: { ...f.pool, leaseRevision: f.pool.leaseRevision + 1 } });
    await expect(f.driver.observePoolCapacity(f.history, f.capture, f.authorize)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each(["not-json", "{}", '[{"referenceSha256":"aa"}]'])("rejects invalid shared-reference input %s before launch", async referencesJson => {
    const f = fixture(); f.capture.referencesJson = referencesJson;
    await expect(f.driver.observePoolCapacity(f.history, f.capture, f.authorize)).rejects.toThrow(); expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
