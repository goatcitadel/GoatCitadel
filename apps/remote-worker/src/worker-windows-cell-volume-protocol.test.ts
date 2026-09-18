import { EventEmitter, once } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { volumeExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-volume-test-fixture.js";
import { formatExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-format-test-fixture.js";
import { protectionExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-protection-test-fixture.js";
import { mountExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-mount-test-fixture.js";
import { mountedWorkspaceExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-mounted-workspace-test-fixture.js";
import { workerCellProvisioningFixture } from "./worker-cell-provisioning-test-fixture.js";
import { createWindowsWorkerCellProvisioning, encodeWindowsWorkerCellProvisioning } from "./worker-windows-cell-provisioning.js";
import { decodeWindowsWorkerCellCapacity, decodeWindowsWorkerCellBackingCapacity } from "./worker-windows-cell-capacity.js";
import { encodeWindowsWorkerPoolHistory } from "./worker-windows-pool-history.js";
import { encodeWindowsWorkerPoolCleanup } from "./worker-windows-pool-cleanup.js";
import { backingCapacityObservationFixture } from "../../../packages/contracts/src/remote-worker-cell-backing-capacity-test-fixture.js";
import { objectInventoryFixture } from "../../../packages/contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { objectInventoryHistoryFixture } from "../../../packages/contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { nativePoolCapacityResponseFixture } from "../../../packages/contracts/src/remote-worker-native-pool-capacity-response-test-fixture.js";
import { readRemoteWorkerCellObjectInventory, readRemoteWorkerCellProvisioningCheckpoint,
  REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION, remoteWorkerCellCanonicalSha256,
  REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION,
  remoteWorkerRuntimeInstallRequestSha256, normalizeRemoteWorkerNativeCapacityLayout,
  hashRemoteWorkerInstallCapacityCapture, encodeRemoteWorkerInstallCapacityChallenge } from "@goatcitadel/contracts";
import { windowsRuntimeDispatchFixture } from "./worker-windows-runtime-dispatch-test-fixture.js";
import { prepareWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { WindowsRuntimeHelperParent } from "./worker-windows-runtime-helper.js";
import { WorkerLocalStateActivity, workerLocalStateActivity } from "./worker-local-state-activity.js";
import type { WindowsWorkerCellRuntimeRequest } from "./worker-windows-cell-provisioning.js";
import type { RemoteWorkerRuntimeResultReceipt, RemoteWorkerNativeFileExportSelection } from "@goatcitadel/contracts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

// This fixture exercises the worker's private binary stream and lifecycle. It
// never starts an installed helper or performs a native volume operation.
class Helper extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private closed = false;
  readonly kill = vi.fn(() => { queueMicrotask(() => this.close(null, "SIGTERM")); return true; });
  close(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    if (this.closed) return;
    this.closed = true; this.exitCode = code; this.signalCode = signal;
    this.stdout.end(); this.stderr.end(); this.stdin.destroy(); this.emit("close", code, signal);
  }
}
function frame(kind: number, payload: Buffer) {
  const bytes = Buffer.alloc(5 + payload.length);
  bytes[0] = kind; bytes.writeUInt32LE(payload.length, 1); payload.copy(bytes, 5);
  return bytes;
}
function receipt(creation = true, formatted = false, protectedRoot = false, mounted = false, workspace = false) {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(5, 4); bytes.writeUInt32LE(creation ? 1 : 0, 8); bytes.writeUInt32LE(workspace ? 21 : mounted ? 19 : protectedRoot ? 15 : formatted ? 13 : 11, 12);
  return bytes;
}
const children: Helper[] = [];
beforeEach(() => {
  mocks.spawn.mockReset();
  const activity = new WorkerLocalStateActivity();
  vi.spyOn(workerLocalStateActivity, "mutation").mockImplementation(activity.mutation.bind(activity));
  vi.spyOn(workerLocalStateActivity, "quiescent").mockImplementation(activity.quiescent.bind(activity));
  vi.spyOn(workerLocalStateActivity, "beginExternalWriter").mockImplementation(activity.beginExternalWriter.bind(activity));
});
afterEach(() => { for (const child of children.splice(0)) child.close(1); vi.restoreAllMocks(); });

function setup(controllerService = true, formatted = false, protectedRoot = false, mounted = false, workspace = false,
  suppliedExchange?: ReturnType<typeof objectInventoryHistoryFixture>) {
  const f = workerCellProvisioningFixture(64), child = new Helper(); children.push(child);
  const exchange = suppliedExchange ?? (workspace ? mountedWorkspaceExchangeFixture : mounted ? mountExchangeFixture : protectedRoot ? protectionExchangeFixture : formatted ? formatExchangeFixture : volumeExchangeFixture)({ ...f.exchange, records: f.records });
  const records = [...exchange.records, ...exchange.volumeRecords!, ...(exchange.formatRecords ?? []), ...(exchange.protectionRecords ?? []), ...(exchange.mountRecords ?? []), ...(exchange.mountedWorkspaceRecords ?? [])];
  const controller = new AbortController(), queue: Buffer[] = [];
  let waiting: { resolve: (value: Buffer) => void; reject: (error: Error) => void } | undefined;
  child.stdin.on("data", (bytes: Buffer) => {
    if (waiting) { const pending = waiting; waiting = undefined; pending.resolve(Buffer.from(bytes)); }
    else queue.push(Buffer.from(bytes));
  });
  child.on("close", () => { waiting?.reject(new Error("helper closed before input")); waiting = undefined; });
  const input = (): Promise<Buffer> => {
    if (queue.length) return Promise.resolve(queue.shift()!);
    if (child.exitCode !== null || child.signalCode !== null) return Promise.reject(new Error("helper is closed"));
    return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
  };
  const executorPath = path.join(process.cwd(), "fixture", "GoatCitadelRemoteWorkerCellProvisioning.exe");
  const assertCurrent = vi.fn(async () => undefined);
  const commit = vi.fn(async (record: string) => record.slice(-64));
  const authorize = vi.fn<() => Promise<void>>(async () => undefined);
  const readCleanup = vi.fn<NonNullable<Parameters<typeof createWindowsWorkerCellProvisioning>[0]["readCleanup"]>>(async history => ({
    exchange: { schemaVersion: "goatcitadel.remote-worker-runtime-cleanup.v1", challenge: "cc".repeat(32), history, expectations: [] }, installations: [] }));
  const readPool = vi.fn<NonNullable<Parameters<typeof createWindowsWorkerCellProvisioning>[0]["readPoolCleanup"]>>(async () => {
    const { schemaVersion: _schema, registryWorkspaceId, assignmentId, assignmentGeneration, leaseRevision, ...history } = exchange;
    const members = [{ assignmentId, assignmentGeneration, workerGeneration: 1, cellId: "fixture-cell", profileSha256: history.plan.profileSha256, history }];
    return { schemaVersion: "goatcitadel.remote-worker-native-pool-cleanup.v1", pool: {
      schemaVersion: REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION, registryWorkspaceId, assignmentId, assignmentGeneration, leaseRevision,
      workerId: "fixture-worker", workerGeneration: 1, members, membershipSha256: remoteWorkerCellCanonicalSha256(members) },
      members: [{ registryWorkspaceId, assignmentId, assignmentGeneration, expectations: [], installation: null }] };
  });
  const driver = createWindowsWorkerCellProvisioning({ parentPath: f.custody.parentPath, wallMs: 3000,
    signal: controller.signal, assertCurrent, controllerService,
    readCleanup, readPoolCleanup: readPool,
    imageGuard: { pinCellProvisioningExecutor: () => ({ executorPath, lease: {} }) } });
  mocks.spawn.mockReturnValueOnce(child);
  const start = (recover = false) => {
    const running = workspace ? (recover ? driver.recoverMountedWorkspace(exchange) : driver.createMountedWorkspace(f.plan, commit, authorize))
      : mounted ? (recover ? driver.recoverMount(exchange) : driver.createMount(f.plan, commit, authorize))
      : protectedRoot ? (recover ? driver.recoverProtection(exchange) : driver.createProtection(f.plan, commit, authorize))
      : formatted ? (recover ? driver.recoverFormat(exchange) : driver.createFormat(f.plan, commit, authorize))
      : recover ? driver.recoverVolume(exchange) : driver.createVolume(f.plan, commit, authorize);
    void running.catch(() => undefined);
    return running;
  };
  const checkpoint = async (index: number) => {
    child.stdout.write(frame(1, Buffer.from(records[index]!, "hex")));
    const ack = await input();
    expect(ack.subarray(0, 9)).toEqual(Buffer.from([3, 36, 0, 0, 0, index + 1, 0, 0, 0]));
    expect(ack.subarray(9).toString("hex")).toBe(records[index]!.slice(-64));
  };
  const challenge = (ordinal = 1, count = 5) => {
    const bytes = Buffer.alloc(40); bytes.writeUInt32LE(ordinal); bytes.writeUInt32LE(count, 4);
    Buffer.from(records[count - 1]!.slice(-64), "hex").copy(bytes, 8); return bytes;
  };
  const authority = async (ordinal = 1, count = 5) => {
    const bytes = challenge(ordinal, count); child.stdout.write(frame(4, bytes));
    expect(await input()).toEqual(frame(5, bytes));
  };
  const creation = async () => { for (let i = 0; i < 5; i++) await checkpoint(i); };
  const volume = async () => { for (let i = 5; i < 11; i++) { await authority(i - 4, i); await checkpoint(i); } };
  const format = async () => { for (let i = 11; i < 13; i++) { await authority(i - 4, i); await checkpoint(i); } };
  const protect = async () => { for (let i = 13; i < 15; i++) { await authority(i - 4, i); await checkpoint(i); } };
  const mount = async () => { for (let i = 15; i < 19; i++) { await authority(i - 4, i); await checkpoint(i); } };
  const mountedWorkspace = async () => { for (let i = 19; i < 21; i++) { await authority(i - 4, i); await checkpoint(i); } };
  return { ...f, child, exchange, records, controller, input, driver, commit, authorize, assertCurrent, readCleanup, readPool,
    start, checkpoint, challenge, authority, creation, volume, format, protect, mount, mountedWorkspace, executorPath };
}

function capacityFixture(f: ReturnType<typeof setup>) {
  const first = Buffer.from(f.records[0]!, "hex"), last = Buffer.from(f.records[20]!, "hex"), bytes = Buffer.alloc(352);
  bytes.fill(0x51, 0, 32); first.copy(bytes, 32, 168, 192); first.copy(bytes, 56, 992, 1024);
  first.copy(bytes, 88, 48, 112); last.copy(bytes, 152, 992, 1024);
  last.copy(bytes, 184, 432, 552); last.copy(bytes, 304, 456, 480);
  bytes.writeBigUInt64LE(0x200000005n, 328); bytes.writeBigUInt64LE(4096n, 336); bytes.writeUInt32LE(7, 344); bytes.writeUInt32LE(9, 348);
  return bytes;
}

describe.skipIf(process.platform !== "win32")("measurement local writer exclusion", () => {
  it("collects cleanup under writer exclusion and passes exact admission plus data to the helper", async () => {
    const f = setup(true, true, true, true, true);
    let mutation: Promise<void> | undefined, written = false;
    let entered!: () => void, resume!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const ready = new Promise<void>(resolve => { resume = resolve; });
    f.readCleanup.mockImplementation(async history => {
      entered(); await ready;
      return { exchange: { schemaVersion: "goatcitadel.remote-worker-runtime-cleanup.v1", challenge: "cc".repeat(32), history, expectations: [] }, installations: [] };
    });
    const running = f.driver.observeCapacity(f.exchange, f.authorize);
    const rejected = expect(running).rejects.toThrow();
    try {
      await reading;
      mutation = workerLocalStateActivity.mutation(async () => { written = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(written).toBe(false); expect(mocks.spawn).not.toHaveBeenCalled(); resume();
      const bootstrap = await f.input();
      const snapshot = await f.readPool.mock.results[0]!.value;
      const pool = encodeWindowsWorkerPoolHistory(snapshot.pool, f.exchange, 14, 3000);
      const cleanup = encodeWindowsWorkerPoolCleanup(snapshot, snapshot.pool, "cc".repeat(32));
      expect(bootstrap.subarray(-cleanup.length)).toEqual(cleanup);
      expect(bootstrap.readUInt32LE(bootstrap.length - cleanup.length - 4)).toBe(cleanup.length);
      const poolEnd = bootstrap.length - cleanup.length - 4;
      expect(bootstrap.subarray(poolEnd - pool.length, poolEnd)).toEqual(pool);
      const admission = bootstrap.subarray(poolEnd - pool.length - 332, poolEnd - pool.length - 252), data = bootstrap.subarray(poolEnd - pool.length - 252, poolEnd - pool.length);
      expect(admission.subarray(0, 8).toString()).toBe("GCCADM01");
      expect(data.subarray(0, 8).toString()).toBe("GCCLEAN1");
      expect(admission.subarray(8, 40)).toEqual(data.subarray(8, 40));
      expect(admission.subarray(40, 72).toString("hex")).toBe(createHash("sha256").update("goatcitadel.worker-runtime-cleanup.v1\0").update(data).digest("hex"));
      expect(admission.readUInt32LE(72)).toBe(0); expect(written).toBe(false);
    } finally { resume(); f.controller.abort(); await rejected; await mutation; }
    expect(written).toBe(true);
  });
  it("refuses cleanup from another history before spawning the helper", async () => {
    const f = setup(true, true, true, true, true);
    f.readCleanup.mockResolvedValue({ exchange: { schemaVersion: "goatcitadel.remote-worker-runtime-cleanup.v1", challenge: "cc".repeat(32),
      history: { ...f.exchange, leaseRevision: f.exchange.leaseRevision + 1 }, expectations: [] }, installations: [] });
    await expect(f.driver.observeCapacity(f.exchange, f.authorize)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("withholds helper launch when complete pool acquisition fails", async () => {
    const f = setup(true, true, true, true, true);
    f.readPool.mockRejectedValue(new Error("pool membership changed"));
    await expect(f.driver.observeCapacity(f.exchange, f.authorize)).rejects.toThrow(/pool membership changed/u);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each(["missing-member", "stale-lease", "cancelled", "revoked"] as const)("refuses %s pool cleanup before helper launch", async failure => {
    const f = setup(true, true, true, true, true);
    const snapshot = await f.readPool(f.controller.signal);
    f.readPool.mockImplementation(async () => {
      if (failure === "cancelled") f.controller.abort();
      if (failure === "revoked") f.assertCurrent.mockRejectedValue(new Error("authority revoked during pool cleanup read"));
      return failure === "missing-member" ? { ...snapshot, members: [] }
        : failure === "stale-lease" ? { ...snapshot, pool: { ...snapshot.pool, leaseRevision: snapshot.pool.leaseRevision + 1 } }
        : snapshot;
    });
    await expect(f.driver.observeCapacity(f.exchange, f.authorize)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each(["observeCapacity", "observeBackingCapacity", "observeInventory"] as const)("%s retains exclusion until cancelled helper closes", async method => {
    const f = setup(true, true, true, true, true);
    f.child.kill.mockImplementation(() => true);
    const running = f.driver[method](f.exchange, f.authorize);
    const rejected = expect(running).rejects.toThrow();
    await f.input();
    let written = false;
    const writing = workerLocalStateActivity.mutation(async () => { written = true; });
    f.controller.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.child.kill).toHaveBeenCalled();
    expect(written).toBe(false);
    f.child.close(null, "SIGTERM");
    await rejected; await writing;
    expect(written).toBe(true);
  });

  it("cancels a queued measurement without launching or overtaking the earlier writer", async () => {
    let release!: () => void;
    const writing = workerLocalStateActivity.mutation(() => new Promise<void>(resolve => { release = resolve; }));
    await new Promise<void>(resolve => setImmediate(resolve));
    const f = setup(true, true, true, true, true);
    const rejected = expect(f.driver.observeCapacity(f.exchange, f.authorize)).rejects.toThrow();
    f.controller.abort(); await rejected;
    expect(mocks.spawn).not.toHaveBeenCalled();
    let following = false;
    const later = workerLocalStateActivity.mutation(async () => { following = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(following).toBe(false);
    release(); await writing; await later;
    expect(following).toBe(true);
  });
});

describe.skipIf(process.platform !== "win32").each([false, true])("installation helper authority (recovery=%s)", recovery => {
  function fixture(combined = false) {
    const poolFixture = combined ? nativePoolCapacityResponseFixture(1) : undefined;
    const f = setup(true, true, true, true, true, combined ? objectInventoryHistoryFixture() : undefined);
    const admission = { connected: vi.fn<() => Promise<void>>(async () => {}), capture: vi.fn<() => Promise<void>>(async () => {}),
      verify: vi.fn<() => Promise<void>>(async () => {}),
      finish: vi.fn(async (join: () => Promise<void>, _signal: AbortSignal) => { await join(); }) };
    const capture = poolFixture ? { pool: poolFixture.pool, layout: normalizeRemoteWorkerNativeCapacityLayout(poolFixture.layout),
      captureNonce: poolFixture.window.nonce, referencesJson: JSON.stringify(poolFixture.source.references) } : undefined;
    if (poolFixture) f.readPool.mockImplementation(async () => ({ schemaVersion: "goatcitadel.remote-worker-native-pool-cleanup.v1",
      pool: poolFixture.pool, members: poolFixture.pool.members.map(member => ({ registryWorkspaceId: poolFixture.pool.registryWorkspaceId,
        assignmentId: member.assignmentId, assignmentGeneration: member.assignmentGeneration, expectations: [], installation: null })) }));
    const first = readRemoteWorkerCellProvisioningCheckpoint(f.records[0]!);
    const request = { schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, nonce: "11".repeat(32),
      journalIdentityHex: first.journalIdentityHex, preparedSha256: first.recordSha256,
      checkpointSha256: f.records[20]!.slice(-64), packageSha256: "55".repeat(32),
      runtimeBundle: { schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files: [
        { relativePath: "node.exe", bytes: 123456, sha256: "66".repeat(32) },
        { relativePath: "worker-host-receipt.json", bytes: 789, sha256: "77".repeat(32) },
      ] } };
    const expected = { nonce: request.nonce, requestSha256: remoteWorkerRuntimeInstallRequestSha256(request) };
    const authorize = vi.fn(async () => undefined);
    const beforeFinish = vi.fn<import("./worker-windows-cell-provisioning.js").WindowsWorkerInstallationFinish>(async () => {});
    const start = () => {
      const running = combined ? f.driver.installRuntimeWithCapacity(f.exchange, request, expected, authorize, beforeFinish, capture!, admission) :
        recovery ? f.driver.recoverRuntimeInstallation(f.exchange, request, expected, authorize) :
        f.driver.installRuntime(f.exchange, request, expected, authorize, beforeFinish);
      void running.catch(() => undefined); return running;
    };
    const challenge = (ordinal: number) => {
      const bytes = Buffer.alloc(100);
      Buffer.from(request.nonce + expected.requestSha256 + request.checkpointSha256, "hex").copy(bytes);
      bytes.writeUInt32LE(ordinal, 96); return bytes;
    };
    const history = () => { for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex"))); };
    const outcome = Buffer.alloc(352); outcome.write("GCRLI001"); outcome.write("GCRLIT01", 256);
    for (const [offset, value] of [[8, request.nonce], [40, expected.requestSha256], [72, request.checkpointSha256],
      [104, request.journalIdentityHex], [128, request.preparedSha256], [160, f.exchange.plan.assignmentBindingSha256],
      [192, f.exchange.plan.profileSha256]] as const) Buffer.from(value, "hex").copy(outcome, offset);
    createHash("sha256").update("goatcitadel.worker-runtime-install-local-intent.v1\0").update(outcome.subarray(0, 224)).digest().copy(outcome, 224);
    outcome.writeUInt32LE(1, 268); outcome.writeUInt32LE(2, 272); outcome.writeBigUInt64LE(124245n, 280);
    outcome.copy(outcome, 288, 224, 256);
    createHash("sha256").update("goatcitadel.worker-runtime-install-local-outcome.v1\0").update(outcome.subarray(0, 320)).digest().copy(outcome, 320);
    return { ...f, poolFixture, capture, admission, request, expected, authorizeInstall: authorize, beforeFinish, startInstall: start, installChallenge: challenge, history, outcome };
  }

  async function reachCombinedCapture(f: ReturnType<typeof fixture>) {
    const running = f.startInstall(); const request = await f.input(); expect(request.readUInt32LE(8)).toBe(21);
    const pool = f.poolFixture!;
    f.child.stdout.write(frame(15, Buffer.from(pool.window.connectionNonceHex, "hex"))); f.history();
    await f.authority(1, 21); await f.authority(2, 21);
    const installation = f.installChallenge(1); f.child.stdout.write(frame(10, installation));
    expect(await f.input()).toEqual(frame(11, installation));
    const binding = { connectionNonceHex: pool.window.connectionNonceHex, installationNonce: f.request.nonce,
      requestSha256: f.expected.requestSha256, captureSha256: hashRemoteWorkerInstallCapacityCapture(pool.bytes), byteLength: pool.bytes.length };
    f.child.stdout.write(frame(16, Buffer.from(encodeRemoteWorkerInstallCapacityChallenge(binding, 1))));
    f.child.stdout.write(frame(17, pool.bytes));
    return { running, binding };
  }

  async function reachCombinedTerminal(f: ReturnType<typeof fixture>) {
    const { running, binding } = await reachCombinedCapture(f);
    for (const ordinal of [1, 2]) {
      const challenge = Buffer.from(encodeRemoteWorkerInstallCapacityChallenge(binding, ordinal));
      f.child.stdout.write(frame(18, challenge)); expect(await f.input()).toEqual(frame(19, challenge));
    }
    expect(f.admission.connected).toHaveBeenCalledOnce(); expect(f.admission.capture).toHaveBeenCalledOnce();
    expect(f.admission.verify).toHaveBeenCalledTimes(2);
    const installation = f.installChallenge(2); f.child.stdout.write(frame(10, installation));
    expect(await f.input()).toEqual(frame(11, installation));
    f.child.stdout.write(frame(12, f.outcome)); expect(await f.input()).toEqual(frame(13, f.outcome.subarray(320)));
    f.child.stdout.write(frame(2, receipt(false, true, true, true, true)));
    return { running };
  }

  it.skipIf(recovery)("completes combined installation through full capture admission and terminal validation", async () => {
    const f = fixture(true); const { running } = await reachCombinedTerminal(f);
    await vi.waitFor(() => expect(f.child.stdin.writableEnded).toBe(true));
    expect(f.beforeFinish).toHaveBeenCalledOnce(); expect(f.admission.finish).toHaveBeenCalledOnce();
    expect(f.admission.finish.mock.settledResults[0]?.type).not.toBe("fulfilled"); f.child.close(0);
    expect((await running).requestSha256).toBe(f.expected.requestSha256);
    expect(f.admission.finish.mock.settledResults[0]?.type).toBe("fulfilled");
  });

  it.skipIf(recovery)("relays a terminal signing challenge while receipt handling is awaiting finish", async () => {
    const f = fixture(true);
    let transport!: import("./worker-controller-attestation-relay.js").WorkerControllerAttestationTransport;
    f.admission.connected.mockImplementation(async (...args: unknown[]) => {
      transport = args[2] as typeof transport;
    });
    f.admission.finish.mockImplementation(async (join, signal) => {
      await transport.challenge("ab".repeat(32), 1, signal);
      await join();
    });
    const { running } = await reachCombinedTerminal(f);
    const challenge = await f.input();
    expect(challenge[0]).toBe(20); expect(challenge.readUInt32LE(1)).toBe(36);
    expect(f.child.stdin.writableEnded).toBe(false);
    const proof = Buffer.alloc(460); proof.write("GCCATT01"); proof.writeUInt32LE(1, 8);
    challenge.copy(proof, 108, 5, 37);
    f.child.stdout.write(frame(21, proof));
    await vi.waitFor(() => expect(f.child.stdin.writableEnded).toBe(true));
    f.child.close(0);
    expect((await running).requestSha256).toBe(f.expected.requestSha256);
  });

  it.skipIf(recovery)("withholds combined installation EOF until reservation verification and writers until release", async () => {
    const f = fixture(true); let allowFinish!: () => void, releaseReservation!: () => void;
    const verified = new Promise<void>(resolve => { allowFinish = resolve; });
    const released = new Promise<void>(resolve => { releaseReservation = resolve; });
    f.admission.finish.mockImplementation(async join => { await verified; await join(); await released; });
    const { running } = await reachCombinedTerminal(f);
    await vi.waitFor(() => expect(f.admission.finish).toHaveBeenCalledOnce());
    expect(f.child.stdin.writableEnded).toBe(false);
    let written = false, returned = false;
    const writing = workerLocalStateActivity.mutation(async () => { written = true; });
    void running.then(() => { returned = true; });
    allowFinish(); await vi.waitFor(() => expect(f.child.stdin.writableEnded).toBe(true));
    f.child.close(0); await new Promise<void>(resolve => setImmediate(resolve));
    expect(returned).toBe(false); expect(written).toBe(false);
    releaseReservation(); await running; await writing;
    expect(written).toBe(true);
  });

  it.skipIf(recovery).each(["denied", "no-join", "early-return", "double-join", "join-failure", "cancel"])("refuses combined installation terminal %s", async mode => {
    const f = fixture(true);
    if (mode === "denied") f.admission.finish.mockRejectedValueOnce(new Error("denied"));
    if (mode === "no-join") f.admission.finish.mockImplementationOnce(async () => {});
    if (mode === "early-return") f.admission.finish.mockImplementationOnce(async join => { void join().catch(() => undefined); });
    if (mode === "double-join") f.admission.finish.mockImplementationOnce(async join => {
      const first = join(); void first.catch(() => undefined);
      await expect(join()).rejects.toThrow(); await first;
    });
    if (mode === "cancel") f.admission.finish.mockImplementationOnce(async join => {
      const pending = join(); f.controller.abort(); await pending;
    });
    const { running } = await reachCombinedTerminal(f);
    if (mode === "join-failure") {
      await vi.waitFor(() => expect(f.child.stdin.writableEnded).toBe(true)); f.child.close(1);
    }
    await expect(running).rejects.toThrow();
    if (mode === "denied" || mode === "no-join") expect(f.child.stdin.writableEnded).toBe(false);
    expect(f.admission.finish.mock.settledResults[0]?.type).not.toBe("incomplete");
  });

  it.skipIf(recovery)("refuses combined installation without a terminal reservation owner before launch", async () => {
    const f = fixture(true);
    await expect(f.driver.installRuntimeWithCapacity(f.exchange, f.request, f.expected, f.authorizeInstall, f.beforeFinish,
      f.capture!, { ...f.admission, finish: undefined } as never)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.skipIf(recovery)("refuses combined installation when canonical capture admission denies", async () => {
    const f = fixture(true); f.admission.capture.mockRejectedValueOnce(new Error("denied"));
    const { running, binding } = await reachCombinedCapture(f);
    f.child.stdout.write(frame(18, Buffer.from(encodeRemoteWorkerInstallCapacityChallenge(binding, 1))));
    await expect(running).rejects.toThrow(); expect(f.admission.verify).not.toHaveBeenCalled();
    expect(f.beforeFinish).not.toHaveBeenCalled(); expect(f.child.kill).toHaveBeenCalled();
  });

  it.skipIf(recovery)("never falls back from combined installation when both capture owners are absent", async () => {
    const f = fixture(true);
    await expect(f.driver.installRuntimeWithCapacity(f.exchange, f.request, f.expected, f.authorizeInstall, f.beforeFinish,
      undefined as never, undefined as never)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  async function reachTerminal(f: ReturnType<typeof fixture>) {
    const running = f.startInstall(); await f.input(); f.history();
    for (const ordinal of [1, 2]) {
      const challenge = f.installChallenge(ordinal); f.child.stdout.write(frame(10, challenge));
      expect(await f.input()).toEqual(frame(11, challenge));
    }
    f.child.stdout.write(frame(12, f.outcome)); expect(await f.input()).toEqual(frame(13, f.outcome.subarray(320)));
    return { running };
  }

  it.skipIf(recovery)("requires the terminal owner before launching an installation", async () => {
    const f = fixture();
    await expect(f.driver.installRuntime(f.exchange, f.request, f.expected, f.authorizeInstall, undefined as never)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.skipIf(recovery)("withholds terminal acknowledgement and local writers until final validation", async () => {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.beforeFinish.mockImplementation(async () => gate);
    const { running } = await reachTerminal(f);
    let written = false;
    const writing = workerLocalStateActivity.mutation(async () => { written = true; });
    const terminal = receipt(false, true, true, true, true);
    f.child.stdout.write(frame(2, terminal));
    await vi.waitFor(() => expect(f.beforeFinish).toHaveBeenCalledOnce());
    expect(f.beforeFinish.mock.calls[0]![0]).toEqual({ requestSha256: f.expected.requestSha256,
      nativeReceiptHex: terminal.toString("hex"), outcomeHex: f.outcome.toString("hex") });
    expect(Object.isFrozen(f.beforeFinish.mock.calls[0]![0])).toBe(true);
    expect(f.child.stdin.writableEnded).toBe(false); expect(written).toBe(false);
    const finished = once(f.child.stdin, "finish"); release(); await finished;
    expect(written).toBe(false); f.child.close(); await running; await writing;
    expect(written).toBe(true);
  });

  it.skipIf(recovery).each(["deny", "cancel"])("does not acknowledge a terminal when final validation %s occurs", async mode => {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.beforeFinish.mockImplementation(async (_terminal, signal) => {
      if (mode === "deny") throw new Error("final Gateway denial");
      f.controller.abort(); await gate; expect(signal.aborted).toBe(true);
    });
    const { running } = await reachTerminal(f);
    f.child.stdout.write(frame(2, receipt(false, true, true, true, true)));
    await expect(running).rejects.toThrow(); release();
    expect(f.child.kill).toHaveBeenCalled(); expect(f.child.stdin.writableEnded).toBe(false);
  });

  it("rechecks current installation authority before acknowledging a terminal", async () => {
    const f = fixture(); const { running } = await reachTerminal(f);
    f.authorizeInstall.mockRejectedValue(new Error("terminal authority revoked"));
    f.child.stdout.write(frame(2, receipt(false, true, true, true, true)));
    await expect(running).rejects.toThrow();
    expect(f.beforeFinish).not.toHaveBeenCalled(); expect(f.child.stdin.writableEnded).toBe(false);
  });

  it.each([4, 8, 12])("rejects a malformed terminal field at %i before finalization", async offset => {
    const f = fixture(); const { running } = await reachTerminal(f);
    const terminal = receipt(false, true, true, true, true); terminal.writeUInt32LE(99, offset);
    f.child.stdout.write(frame(2, terminal)); await expect(running).rejects.toThrow();
    expect(f.beforeFinish).not.toHaveBeenCalled(); expect(f.child.stdin.writableEnded).toBe(false);
  });

  it("requires separate bound installation acknowledgements before accepting success", async () => {
    const f = fixture(), running = f.startInstall();
    const input = await f.input();
    let written = false;
    const writing = workerLocalStateActivity.mutation(async () => { written = true; });
    expect(input.readUInt32LE(8)).toBe(recovery ? 19 : 18);
    expect(input.subarray(-336, -272).toString("hex")).toBe(f.request.nonce + f.expected.requestSha256);
    expect(input.subarray(-272, -264).toString()).toBe("GCRINST1");
    f.history();
    for (const ordinal of [1, 2]) {
      const challenge = f.installChallenge(ordinal); f.child.stdout.write(frame(10, challenge));
      expect(await f.input()).toEqual(frame(11, challenge));
    }
    f.child.stdout.write(frame(12, f.outcome)); expect(await f.input()).toEqual(frame(13, f.outcome.subarray(320)));
    const finished = once(f.child.stdin, "finish");
    f.child.stdout.write(frame(2, receipt(false, true, true, true, true))); await finished;
    expect(written).toBe(false); f.child.close();
    expect(await running).toMatchObject({ requestSha256: f.expected.requestSha256, outcomeHex: f.outcome.toString("hex"),
      outcome: { installation: { verified: true, bytesWritten: 124245 } } });
    await writing; expect(written).toBe(true);
    expect(f.authorizeInstall).toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("holds writers until a cancelled installation helper closes", async () => {
    const f = fixture(); f.child.kill.mockImplementation(() => true);
    const rejected = expect(f.startInstall()).rejects.toThrow(); await f.input();
    let written = false;
    const writing = workerLocalStateActivity.mutation(async () => { written = true; });
    f.controller.abort(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.child.kill).toHaveBeenCalled(); expect(written).toBe(false);
    f.child.close(null, "SIGTERM"); await rejected; await writing;
    expect(written).toBe(true);
  });

  it("accepts a retained failure only through read-only recovery", async () => {
    const f = fixture(), running = f.startInstall(); await f.input(); f.history();
    for (const ordinal of [1, 2]) {
      const challenge = f.installChallenge(ordinal); f.child.stdout.write(frame(10, challenge));
      expect(await f.input()).toEqual(frame(11, challenge));
    }
    f.outcome.writeUInt32LE(5, 264); f.outcome.writeUInt32LE(0, 268);
    f.outcome.writeUInt32LE(1, 272); f.outcome.writeBigUInt64LE(100n, 280);
    createHash("sha256").update("goatcitadel.worker-runtime-install-local-outcome.v1\0").update(f.outcome.subarray(0, 320)).digest().copy(f.outcome, 320);
    f.child.stdout.write(frame(12, f.outcome));
    if (recovery) {
      expect(await f.input()).toEqual(frame(13, f.outcome.subarray(320)));
      const finished = once(f.child.stdin, "finish");
      f.child.stdout.write(frame(2, receipt(false, true, true, true, true))); await finished; f.child.close();
      expect(await running).toMatchObject({ outcomeHex: f.outcome.toString("hex"),
        outcome: { installation: { verified: false, bytesWritten: 100 } } });
    } else await expect(running).rejects.toThrow();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each(["missing", "intent", "seal", "early", "duplicate", "revoked"])("refuses %s installation evidence", async mode => {
    const f = fixture(), running = f.startInstall(); await f.input(); f.history();
    if (mode !== "early") for (const ordinal of [1, 2]) {
      const challenge = f.installChallenge(ordinal); f.child.stdout.write(frame(10, challenge));
      expect(await f.input()).toEqual(frame(11, challenge));
    }
    if (mode === "missing") f.child.stdout.write(frame(2, receipt(false, true, true, true, true)));
    else {
      if (mode === "seal") f.outcome[351]! ^= 1;
      if (mode === "revoked") f.authorizeInstall.mockRejectedValue(new Error("installation delivery revoked"));
      f.child.stdout.write(frame(12, mode === "intent" ? f.outcome.subarray(0, 256) : f.outcome));
      if (mode === "duplicate") { expect(await f.input()).toEqual(frame(13, f.outcome.subarray(320))); f.child.stdout.write(frame(12, f.outcome)); }
    }
    await expect(running).rejects.toThrow(); expect(f.commit).not.toHaveBeenCalled();
  });

  it.each(["nonce", "request", "head", "ordinal", "early", "volume", "unearned", "denied"])("refuses %s installation authority", async (mode) => {
    const f = fixture();
    if (mode === "denied") f.authorizeInstall.mockRejectedValue(new Error("revoked installation"));
    const running = f.startInstall(); await f.input();
    if (mode !== "early") f.history();
    const challenge = f.installChallenge(1);
    if (mode === "nonce") challenge[0]! ^= 1;
    if (mode === "request") challenge[32]! ^= 1;
    if (mode === "head") challenge[64]! ^= 1;
    if (mode === "ordinal") challenge.writeUInt32LE(2, 96);
    if (mode === "unearned") f.child.stdout.write(frame(2, receipt(false, true, true, true, true)));
    else if (mode === "volume") f.child.stdout.write(frame(4, f.challenge(1, 21)));
    else f.child.stdout.write(frame(10, challenge));
    await expect(running).rejects.toThrow();
    expect(f.authorize).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
    if (mode !== "denied") expect(f.authorizeInstall).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== "win32")("installed runtime helper composition", () => {
  function runtimeFixture(change?: (request: WindowsWorkerCellRuntimeRequest) => void) {
    const f = setup(true, true, true, true, true);
    let resolve!: (receipt: RemoteWorkerRuntimeResultReceipt) => void, reject!: (error: Error) => void;
    const completion = new Promise<RemoteWorkerRuntimeResultReceipt>((yes, no) => { resolve = yes; reject = no; });
    const bootstrap = Buffer.from("private-runtime-bootstrap"), state = { finished: false, cleanupVerified: false };
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    // The parent codec is tested separately; this fixture proves process/outer
    // receipt ordering and ownership of the already-validated private buffer.
    const fileRecord = Buffer.from("private-native-file-record");
    const takeFiles = vi.fn<WindowsRuntimeHelperParent["takeFiles"]>(() => [{ record: fileRecord, selection: {} as RemoteWorkerNativeFileExportSelection }]);
    const parent = { completion, state, close, takeFiles, takeBootstrap: () => bootstrap } as unknown as WindowsRuntimeHelperParent;
    const open = vi.spyOn(WindowsRuntimeHelperParent, "open").mockResolvedValue(parent);
    const command = windowsRuntimeDispatchFixture();
    command.checkpointSha256 = f.records[20]!.slice(-64);
    const request = { request: command, expected: { ...prepareWindowsRuntimeDispatch(command).expectation },
      owner: { signal: f.controller.signal, timeoutMs: 3000, authorizePeer: async () => undefined,
        authorizeRuntime: async () => undefined, authorizeDelivery: async () => undefined, authorizeRetention: async () => undefined,
        authorizeInput: async () => undefined, consumeOutput: async () => undefined, readInput: async () => "eof",
        retain: async () => { throw new Error("Separate endpoint retention fixture."); } } } satisfies WindowsWorkerCellRuntimeRequest;
    const result = { resultSha256: "a".repeat(64) } as RemoteWorkerRuntimeResultReceipt;
    change?.(request);
    const running = f.driver.runRuntime(f.exchange, request, f.authorize); void running.catch(() => undefined);
    return { ...f, completion, resolve, reject, state, close, open, result, running, bootstrap, request, takeFiles, fileRecord };
  }
  it.each([false, true])("holds measurement exclusion through helper and parent join (cleanup verified=%s)", async verified => {
    const f = runtimeFixture(); await f.input();
    const measure = () => workerLocalStateActivity.quiescent(async () => "measured", f.controller.signal);
    await expect(measure()).rejects.toThrow("cleanup is not verified");
    await expect(workerLocalStateActivity.mutation(async () => "saved")).resolves.toBe("saved");
    let release!: () => void;
    f.close.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    await f.authority(1, 21);
    const finished = once(f.child.stdin, "finish"); f.child.stdout.write(frame(2, receipt(false, true, true, true, true)));
    await finished; f.state.finished = true; f.state.cleanupVerified = verified; f.resolve(f.result);
    await expect(measure()).rejects.toThrow("cleanup is not verified");
    f.child.close();
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    await expect(measure()).rejects.toThrow("cleanup is not verified");
    release(); await expect(f.running).resolves.toEqual(f.result);
    if (verified) await expect(measure()).resolves.toBe("measured");
    else await expect(measure()).rejects.toThrow("cleanup is not verified");
  });
  it("refuses runtime setup while measurement owns exclusion", async () => {
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const observation = workerLocalStateActivity.quiescent(async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    }, new AbortController().signal);
    await ready;
    const f = runtimeFixture();
    await expect(f.running).rejects.toThrow("measurement is active");
    expect(f.open).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
    release(); await observation;
    await expect(workerLocalStateActivity.quiescent(async () => true, f.controller.signal)).resolves.toBe(true);
  });
  it("releases an unused reservation when spawn throws", async () => {
    const f = runtimeFixture();
    mocks.spawn.mockReset().mockImplementation(() => { throw new Error("spawn refused"); });
    await expect(f.running).rejects.toThrow("spawn refused");
    expect(f.close).toHaveBeenCalledOnce();
    await expect(workerLocalStateActivity.quiescent(async () => true, f.controller.signal)).resolves.toBe(true);
  });
  it.each(["authorizeFile", "consumeFiles"] as const)("refuses a file request missing %s before helper setup", async missing => {
    const f = runtimeFixture(request => {
      Object.assign(request.request, { fileStaging: { paths: ["result.txt"], maximumFileBytes: 1024, maximumTotalBytes: 1024 } });
      Object.assign(request.expected, prepareWindowsRuntimeDispatch(request.request).expectation);
      Object.assign(request.owner, { authorizeFile: async () => {}, consumeFiles: async () => {}, [missing]: undefined });
    });
    await expect(f.running).rejects.toThrow("refused"); expect(f.open).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each([false, true])("delivers file buffers only after clean helper exit and wipes them afterward (consumer fails=%s)", async fails => {
    const consume = vi.fn(async (files: ReturnType<WindowsRuntimeHelperParent["takeFiles"]>) => {
      expect(files[0]!.record.toString()).toBe("private-native-file-record");
      if (fails) throw new Error("Artifact settlement refused");
    });
    const f = runtimeFixture(request => {
      Object.assign(request.request, { fileStaging: { paths: ["result.txt"], maximumFileBytes: 1024, maximumTotalBytes: 1024 } });
      Object.assign(request.expected, prepareWindowsRuntimeDispatch(request.request).expectation);
      Object.assign(request.owner, { authorizeFile: async () => {}, consumeFiles: consume,
        fileStaging: { paths: ["unreviewed.txt"], maximumFileBytes: 1, maximumTotalBytes: 1 } });
    });
    await f.input();
    expect(f.open.mock.calls[0]![3].fileStaging?.paths).toEqual(["result.txt"]);
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    await f.authority(1, 21);
    const finished = once(f.child.stdin, "finish"); f.child.stdout.write(frame(2, receipt(false, true, true, true, true)));
    await finished;
    f.state.finished = true; f.resolve(f.result);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(consume).not.toHaveBeenCalled(); expect(f.takeFiles).not.toHaveBeenCalled();
    f.child.close();
    if (fails) await expect(f.running).rejects.toThrow("settlement refused"); else expect(await f.running).toEqual(f.result);
    expect(consume).toHaveBeenCalledOnce(); expect(f.takeFiles).toHaveBeenCalledOnce();
    expect(f.fileRecord.every(byte => byte === 0)).toBe(true); expect(f.close).toHaveBeenCalledOnce();
  });
  it.each(["nonce", "requestSha256", "checkpointSha256", "runtimeBundleSha256", "maxInputBytes", "maxOutputBytes", "maxInventoryEntries"] as const)(
    "refuses mismatched admitted %s before helper pinning or spawn", async field => {
      const f = runtimeFixture(request => {
        Object.assign(request.expected, { [field]: typeof request.expected[field] === "number" ? 1 : "b".repeat(64) });
      });
      await expect(f.running).rejects.toThrow("refused");
      expect(f.assertCurrent).not.toHaveBeenCalled();
      expect(f.open).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  it("refuses a substituted command before opening the controller transport", async () => {
    const f = runtimeFixture(request => { Object.assign(request.request.launch, { commandLine: request.request.launch.commandLine + " substituted" }); });
    await expect(f.running).rejects.toThrow("refused");
    expect(f.open).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("uses operation 17, all canonical history and the separate runtime receipt before publishing", async () => {
    const f = runtimeFixture();
    const admittedHash = f.request.expected.requestSha256;
    f.request.request.launch.commandLine += " changed after handoff";
    const bytes = await f.input();
    expect(f.open.mock.calls[0]![1].requestSha256).toBe(admittedHash);
    expect(f.open.mock.calls[0]![0].some(byte => byte !== 0)).toBe(true);
    expect(bytes.readUInt32LE(8)).toBe(17); expect(bytes.subarray(-25).toString()).toBe("private-runtime-bootstrap");
    expect(f.bootstrap.every(byte => byte === 0)).toBe(true);
    expect(f.child.stdin.writableEnded).toBe(false);
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    await f.authority(1, 21);
    const finished = once(f.child.stdin, "finish"); f.child.stdout.write(frame(2, receipt(false, true, true, true, true)));
    await finished; f.child.close();
    let published = false; void f.running.then(() => { published = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(published).toBe(false);
    f.state.finished = true; f.resolve(f.result);
    expect(await f.running).toEqual(f.result); expect(f.close).toHaveBeenCalledOnce();
    expect(f.commit).not.toHaveBeenCalled(); expect(f.authorize).toHaveBeenCalledTimes(2);
    expect(mocks.spawn.mock.calls[0]![1]).toEqual(["--controller"]);
  });
  it("stops only its owned helper when the runtime endpoint fails, without a replay", async () => {
    const f = runtimeFixture(); await f.input(); f.reject(new Error("parent failed"));
    await expect(f.running).rejects.toThrow(); expect(f.child.kill).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
    await expect(workerLocalStateActivity.quiescent(async () => true, f.controller.signal)).rejects.toThrow("cleanup is not verified");
  });
  it("does not publish a retained runtime receipt after an unsuccessful helper exit", async () => {
    const f = runtimeFixture(); await f.input(); f.state.finished = true; f.resolve(f.result);
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    await f.authority(1, 21);
    const finished = once(f.child.stdin, "finish"); f.child.stdout.write(frame(2, receipt(false, true, true, true, true)));
    await finished; f.child.close(3);
    await expect(f.running).rejects.toThrow(); expect(f.close).toHaveBeenCalledOnce();
  });
});
describe.skipIf(process.platform !== "win32")("pinned helper object inventory", () => {
  it("accepts 20,000 objects with all 256 authority checks inside the exact output bound", async () => {
    const f = setup(true, true, true, true, true), value = objectInventoryFixture(f.exchange, 19996);
    const running = f.driver.observeInventory(f.exchange, f.authorize);
    await f.input();
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    for (let ordinal = 1; ordinal <= 256; ordinal += 1) await f.authority(ordinal, 21);
    const finished = once(f.child.stdin, "finish");
    f.child.stdout.write(Buffer.concat([frame(8, value.summary), ...value.chunks.map(chunk => frame(9, chunk)), frame(2, receipt(false, true, true, true, true))]));
    await finished; f.child.close();
    const result = await running; expect(result.entries).toHaveLength(20000); expect(result.chunkHex).toHaveLength(1000);
    expect(f.authorize).toHaveBeenCalledTimes(257); expect(f.commit).not.toHaveBeenCalled();
  });
  it("publishes all batches only after successful receipt, clean exit and final authority", async () => {
    const f = setup(true, true, true, true, true), value = objectInventoryFixture(f.exchange);
    const running = f.driver.observeInventory(f.exchange, f.authorize);
    let delivered = false; void running.then(() => { delivered = true; });
    expect((await f.input()).readUInt32LE(8)).toBe(16);
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    await f.authority(1, 21);
    f.child.stdout.write(frame(8, value.summary));
    for (const chunk of value.chunks) {
      const wire = frame(9, chunk); f.child.stdout.write(wire.subarray(0, 53)); f.child.stdout.write(wire.subarray(53));
    }
    await new Promise<void>(resolve => setImmediate(resolve)); expect(delivered).toBe(false);
    const finished = once(f.child.stdin, "finish"); f.child.stdout.write(frame(2, receipt(false, true, true, true, true)));
    await finished; expect(delivered).toBe(false); f.child.close();
    await expect(running).resolves.toEqual({ ...readRemoteWorkerCellObjectInventory(value.summary.toString("hex"), value.chunks.map(chunk => chunk.toString("hex")), f.exchange),
      nativeReceiptHex: receipt(false, true, true, true, true).toString("hex") });
    expect(f.authorize).toHaveBeenCalledTimes(2); expect(f.commit).not.toHaveBeenCalled(); expect(f.child.kill).not.toHaveBeenCalled();
  });
  it.each(["missing", "duplicate", "order", "nonce", "count", "padding", "totals", "identity", "extra", "early", "summary-twice",
    "wrong-kind", "truncated", "no-receipt", "native-error", "failed-exit", "revoked-final", "cancelled-final", "after-inventory-authority"])("withholds %s inventory", async failure => {
    const f = setup(true, true, true, true, true), value = objectInventoryFixture(f.exchange);
    const running = f.driver.observeInventory(f.exchange, f.authorize), rejected = expect(running).rejects.toThrow();
    await f.input();
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    await f.authority(1, 21);
    if (failure === "revoked-final") f.authorize.mockRejectedValueOnce(new Error("revoked before publication"));
    if (failure === "cancelled-final") f.authorize.mockImplementationOnce(async () => { f.controller.abort(); });
    f.child.stdin.once("finish", () => f.child.close(failure === "failed-exit" ? 1 : 0));
    if (failure === "early") f.child.stdout.write(frame(9, value.chunks[0]!));
    f.child.stdout.write(frame(failure === "wrong-kind" ? 6 : 8, value.summary));
    if (failure === "summary-twice") f.child.stdout.write(frame(8, value.summary));
    if (failure === "missing") value.chunks.pop();
    if (failure === "duplicate") value.chunks[1] = Buffer.from(value.chunks[0]!);
    if (failure === "order") value.chunks.reverse();
    if (failure === "nonce") value.chunks[1]![0] = value.chunks[1]![0]! ^ 1;
    if (failure === "count") value.chunks[0]!.writeUInt32LE(21, 36);
    if (failure === "padding") value.chunks[1]![999] = 1;
    if (failure === "totals") value.chunks[1]!.writeBigUInt64LE(8192n, 80);
    if (failure === "identity") value.chunks[0]!.copy(value.chunks[1]!, 40, 40, 64);
    for (const chunk of value.chunks) f.child.stdout.write(failure === "truncated" ? frame(9, chunk).subarray(0, 800) : frame(9, chunk));
    if (failure === "extra") f.child.stdout.write(frame(9, value.chunks[0]!));
    if (failure === "after-inventory-authority") f.child.stdout.write(frame(4, f.challenge(2, 21)));
    if (failure === "truncated" || failure === "no-receipt") f.child.close();
    else {
      const final = receipt(false, true, true, true, true); if (failure === "native-error") final.writeUInt32LE(50);
      f.child.stdout.write(frame(2, final));
    }
    await rejected; expect(f.commit).not.toHaveBeenCalled();
  });
  it("refuses missing controller, history or authority before spawn", async () => {
    const f = setup(false, true, true, true, true);
    await expect(f.driver.observeInventory(f.exchange, f.authorize)).rejects.toThrow();
    await expect(f.driver.observeInventory(f.exchange, undefined!)).rejects.toThrow();
    await expect(f.driver.observeInventory({ ...f.exchange, mountedWorkspaceRecords: [] }, f.authorize)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== "win32")("pinned helper host backing capacity", () => {
  it("requests operation 15 with unchanged full recovery bytes and rejects mixed or incomplete requests", async () => {
    const f = setup(true, true, true, true, true);
    const bytes = encodeWindowsWorkerCellProvisioning(f.plan, f.custody.parentPath, 3000, f.records[0], f.exchange, true, true, true, true, false, true);
    expect(bytes.readUInt32LE(8)).toBe(15); bytes.writeUInt32LE(12, 8);
    expect(bytes).toEqual(encodeWindowsWorkerCellProvisioning(f.plan, f.custody.parentPath, 3000, f.records[0], f.exchange, true, true, true, true));
    expect(() => encodeWindowsWorkerCellProvisioning(f.plan, f.custody.parentPath, 60001, f.records[0], f.exchange, true, true, true, true, false, true)).toThrow();
    expect(() => encodeWindowsWorkerCellProvisioning(f.plan, f.custody.parentPath, 3000, undefined, true, true, true, true, true, false, true)).toThrow();
    expect(() => encodeWindowsWorkerCellProvisioning(f.plan, f.custody.parentPath, 3000, f.records[0], f.exchange, true, true, true, true, true, true)).toThrow();
    await expect(f.driver.observeBackingCapacity({ ...f.exchange, mountedWorkspaceRecords: [] }, f.authorize)).rejects.toThrow();
    await expect(f.driver.observeBackingCapacity(f.exchange, undefined!)).rejects.toThrow();
    const direct = setup(false, true, true, true, true);
    await expect(direct.driver.observeBackingCapacity(direct.exchange, direct.authorize)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("returns host charges only after receipt, clean exit and a final authority check", async () => {
    const f = setup(true, true, true, true, true), running = f.driver.observeBackingCapacity(f.exchange, f.authorize);
    let delivered = false; void running.then(() => { delivered = true; });
    expect((await f.input()).readUInt32LE(8)).toBe(15); expect(f.child.stdin.writableEnded).toBe(false);
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    await f.authority(1, 21);
    const bytes = backingCapacityObservationFixture(f.exchange), wire = frame(7, bytes);
    f.child.stdout.write(wire.subarray(0, 113)); f.child.stdout.write(wire.subarray(113));
    await new Promise<void>((resolve) => setImmediate(resolve)); expect(delivered).toBe(false);
    const finished = once(f.child.stdin, "finish"); f.child.stdout.write(frame(2, receipt(false, true, true, true, true)));
    await finished; expect(delivered).toBe(false); f.child.close();
    const observed = await running;
    expect(observed).toEqual({ ...decodeWindowsWorkerCellBackingCapacity(bytes, f.exchange), nativeReceiptHex: receipt(false, true, true, true, true).toString("hex") });
    expect(observed.hostFileAllocatedBytes).toBe(observed.backingAllocatedBytes + observed.journalAllocatedBytes);
    expect(Object.isFrozen(observed) && Object.isFrozen(observed.hostDirectoryIdentityHex)).toBe(true);
    expect(observed).not.toHaveProperty("allocatedBytes");
    expect(f.authorize).toHaveBeenCalledTimes(2); expect(f.commit).not.toHaveBeenCalled(); expect(f.child.kill).not.toHaveBeenCalled();
  });
  it.each(["zero-nonce", "assignment", "profile", "head", "parent", "root", "disk", "control", "backing", "unsafe-allocated", "journal", "total",
    "early", "no-authority", "missing", "duplicate", "extra-authority", "no-receipt", "native-error", "creation-receipt", "receipt-count", "failed-exit",
    "short-frame", "long-frame", "truncated-frame", "wrong-kind", "revoked-final", "cancelled-final"])("withholds %s host evidence", async (failure) => {
    const f = setup(true, true, true, true, true), running = f.driver.observeBackingCapacity(f.exchange, f.authorize);
    const rejected = expect(running).rejects.toThrow(); await f.input();
    for (const record of f.records.slice(0, failure === "early" ? 19 : 21)) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    if (failure !== "early" && failure !== "no-authority") await f.authority(1, 21);
    const bytes = backingCapacityObservationFixture(f.exchange);
    if (failure === "zero-nonce") bytes.fill(0, 0, 32);
    for (const [name, offset] of [["assignment", 88], ["profile", 120], ["head", 152], ["parent", 184], ["root", 208], ["disk", 304], ["control", 336], ["backing", 360], ["total", 416]] as const)
      if (failure === name) bytes[offset] = bytes[offset]! ^ 1;
    if (failure === "unsafe-allocated") bytes.writeBigUInt64LE(2n ** 53n, 392);
    if (failure === "journal") bytes.writeBigUInt64LE(5120n, 400);
    if (failure === "revoked-final") f.authorize.mockRejectedValueOnce(new Error("revoked at final authority"));
    if (failure === "cancelled-final") f.authorize.mockImplementationOnce(async () => { f.controller.abort(); });
    f.child.stdin.once("finish", () => f.child.close(failure === "failed-exit" ? 1 : 0));
    const wire = failure === "wrong-kind" ? frame(6, capacityFixture(f)) : frame(7, bytes);
    if (failure === "short-frame") wire.writeUInt32LE(423, 1);
    if (failure === "long-frame") wire.writeUInt32LE(425, 1);
    if (failure === "truncated-frame") f.child.stdout.write(wire.subarray(0, 300));
    else if (failure !== "missing") f.child.stdout.write(wire);
    if (failure === "duplicate") f.child.stdout.write(wire);
    if (failure === "extra-authority") f.child.stdout.write(frame(4, f.challenge(2, 21)));
    if (failure === "no-receipt" || failure === "truncated-frame") f.child.close();
    else {
      const final = receipt(failure === "creation-receipt", true, true, true, true);
      if (failure === "native-error") final.writeUInt32LE(50);
      if (failure === "receipt-count") final.writeUInt32LE(20, 12);
      f.child.stdout.write(frame(2, final));
    }
    await rejected; expect(f.commit).not.toHaveBeenCalled();
  });
  it.each(["complete", "challenge", "bytes"])("enforces the host observation transport bound: %s", async (mode) => {
    const f = setup(true, true, true, true, true), running = f.driver.observeBackingCapacity(f.exchange, f.authorize);
    void running.catch(() => undefined); await f.input();
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    for (let ordinal = 1; ordinal <= 256; ordinal++) await f.authority(ordinal, 21);
    if (mode === "complete") {
      f.child.stdin.once("finish", () => f.child.close());
      f.child.stdout.write(frame(7, backingCapacityObservationFixture(f.exchange))); f.child.stdout.write(frame(2, receipt(false, true, true, true, true)));
      await expect(running).resolves.toMatchObject({ journalBytes: 21504 }); expect(f.authorize).toHaveBeenCalledTimes(257);
    } else {
      f.child.stdout.write(mode === "challenge" ? frame(4, f.challenge(257, 21)) : Buffer.alloc(451));
      await expect(running).rejects.toThrow(); expect(f.authorize).toHaveBeenCalledTimes(256);
    }
    expect(f.commit).not.toHaveBeenCalled();
  });
});
describe.skipIf(process.platform !== "win32")("pinned helper capacity observation", () => {
  it("binds the independent native encoding and preserves full-width identities and sparse counts", () => {
    const f = setup(true, true, true, true, true), bytes = capacityFixture(f);
    const decoded = decodeWindowsWorkerCellCapacity(bytes, f.exchange);
    expect(decoded).toMatchObject({ assignmentId: f.exchange.assignmentId, assignmentGeneration: f.exchange.assignmentGeneration,
      leaseRevision: f.exchange.leaseRevision, planSha256: f.exchange.planSha256, checkpointSha256: f.records[20]!.slice(-64),
      logicalFileBytes: 0x200000005, allocatedBytes: 4096, fileCount: 7, directoryCount: 9 });
    expect(Object.isFrozen(decoded) && Object.isFrozen(decoded.directoryIdentityHex)).toBe(true);
    for (const offset of [32, 55, 56, 87, 88, 119, 120, 151, 152, 183, 184, 207, 208, 231, 232, 255, 256, 279, 280, 303, 304, 327]) {
      const altered = Buffer.from(bytes); altered[offset] = altered[offset]! ^ 1;
      expect(() => decodeWindowsWorkerCellCapacity(altered, f.exchange)).toThrow();
    }
    for (const key of ["records", "volumeRecords", "formatRecords", "protectionRecords", "mountRecords", "mountedWorkspaceRecords"] as const)
      expect(() => decodeWindowsWorkerCellCapacity(bytes, { ...f.exchange, [key]: f.exchange[key]!.slice(1) })).toThrow();
  });
  it("encodes only complete bounded observation requests without changing recovery bytes", async () => {
    const f = setup(true, true, true, true, true);
    const encoded = encodeWindowsWorkerCellProvisioning(f.plan, f.custody.parentPath, 3000, f.records[0], f.exchange, true, true, true, true, true);
    expect(encoded.readUInt32LE(8)).toBe(14); encoded.writeUInt32LE(12, 8);
    expect(encoded).toEqual(encodeWindowsWorkerCellProvisioning(f.plan, f.custody.parentPath, 3000, f.records[0], f.exchange, true, true, true, true));
    expect(() => encodeWindowsWorkerCellProvisioning(f.plan, f.custody.parentPath, 60001, f.records[0], f.exchange, true, true, true, true, true)).toThrow();
    expect(() => encodeWindowsWorkerCellProvisioning(f.plan, f.custody.parentPath, 3000, undefined, true, true, true, true, true, true)).toThrow();
    await expect(f.driver.observeCapacity({ ...f.exchange, mountedWorkspaceRecords: [] }, f.authorize)).rejects.toThrow();
    await expect(f.driver.observeCapacity(f.exchange, undefined!)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("publishes only after the complete stream, successful receipt, clean exit and final authority", async () => {
    const f = setup(true, true, true, true, true), running = f.driver.observeCapacity(f.exchange, f.authorize);
    let delivered = false; void running.then(() => { delivered = true; });
    expect((await f.input()).readUInt32LE(8)).toBe(14); expect(f.child.stdin.writableEnded).toBe(false);
    let written = false;
    const writing = workerLocalStateActivity.mutation(async () => { written = true; });
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    await f.authority(1, 21);
    const wire = frame(6, capacityFixture(f)); f.child.stdout.write(wire.subarray(0, 113)); f.child.stdout.write(wire.subarray(113));
    await new Promise<void>((resolve) => setImmediate(resolve)); expect(delivered).toBe(false);
    const finished = once(f.child.stdin, "finish"); f.child.stdout.write(frame(2, receipt(false, true, true, true, true)));
    await finished; expect(delivered).toBe(false); expect(written).toBe(false); f.child.close();
    await expect(running).resolves.toEqual({ ...decodeWindowsWorkerCellCapacity(capacityFixture(f), f.exchange), nativeReceiptHex: receipt(false, true, true, true, true).toString("hex") });
    await writing; expect(written).toBe(true);
    expect(f.authorize).toHaveBeenCalledTimes(2); expect(f.commit).not.toHaveBeenCalled(); expect(f.child.kill).not.toHaveBeenCalled();
  });
  it.each(["zero-nonce", "assignment", "profile", "head", "root", "unsafe-logical", "unsafe-allocated", "entry-bound", "no-directories", "no-files",
    "early", "no-authority", "missing", "duplicate", "extra-authority", "no-receipt", "native-error", "creation-receipt", "receipt-count", "failed-exit",
    "short-frame", "long-frame", "truncated-frame", "revoked-final", "cancelled-final"])("withholds %s capacity evidence", async (failure) => {
    const f = setup(true, true, true, true, true), running = f.driver.observeCapacity(f.exchange, f.authorize);
    const rejected = expect(running).rejects.toThrow(); await f.input();
    for (const record of f.records.slice(0, failure === "early" ? 19 : 21)) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    if (failure !== "early" && failure !== "no-authority") await f.authority(1, 21);
    const bytes = capacityFixture(f);
    if (failure === "zero-nonce") bytes.fill(0, 0, 32);
    for (const [name, offset] of [["assignment", 88], ["profile", 120], ["head", 152], ["root", 304]] as const)
      if (failure === name) bytes[offset] = bytes[offset]! ^ 1;
    if (failure === "unsafe-logical") bytes.writeBigUInt64LE(9007199254740992n, 328);
    if (failure === "unsafe-allocated") bytes.writeBigUInt64LE(9007199254740992n, 336);
    if (failure === "entry-bound") bytes.writeUInt32LE(20000, 344);
    if (failure === "no-directories") bytes.writeUInt32LE(3, 348);
    if (failure === "no-files") bytes.writeUInt32LE(0, 344);
    if (failure === "revoked-final") f.authorize.mockRejectedValueOnce(new Error("revoked at final authority"));
    if (failure === "cancelled-final") f.authorize.mockImplementationOnce(async () => { f.controller.abort(); });
    f.child.stdin.once("finish", () => f.child.close(failure === "failed-exit" ? 1 : 0));
    const wire = frame(6, bytes);
    if (failure === "short-frame") wire.writeUInt32LE(351, 1);
    if (failure === "long-frame") wire.writeUInt32LE(353, 1);
    if (failure === "truncated-frame") f.child.stdout.write(wire.subarray(0, 300));
    else if (failure !== "missing") f.child.stdout.write(wire);
    if (failure === "duplicate") f.child.stdout.write(wire);
    if (failure === "extra-authority") f.child.stdout.write(frame(4, f.challenge(2, 21)));
    if (failure === "no-receipt" || failure === "truncated-frame") f.child.close();
    else {
      const final = receipt(failure === "creation-receipt", true, true, true, true);
      if (failure === "native-error") final.writeUInt32LE(50);
      if (failure === "receipt-count") final.writeUInt32LE(20, 12);
      f.child.stdout.write(frame(2, final));
    }
    await rejected; expect(f.commit).not.toHaveBeenCalled();
  });
  it.each(["complete", "challenge", "bytes"])("enforces the complete capacity transport bound: %s", async (mode) => {
    const f = setup(true, true, true, true, true), running = f.driver.observeCapacity(f.exchange, f.authorize);
    void running.catch(() => undefined); await f.input();
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    for (let ordinal = 1; ordinal <= 256; ordinal++) await f.authority(ordinal, 21);
    if (mode === "complete") {
      f.child.stdin.once("finish", () => f.child.close());
      f.child.stdout.write(frame(6, capacityFixture(f))); f.child.stdout.write(frame(2, receipt(false, true, true, true, true)));
      await expect(running).resolves.toMatchObject({ fileCount: 7 }); expect(f.authorize).toHaveBeenCalledTimes(257);
    } else {
      f.child.stdout.write(mode === "challenge" ? frame(4, f.challenge(257, 21)) : Buffer.alloc(379));
      await expect(running).rejects.toThrow(); expect(f.authorize).toHaveBeenCalledTimes(256);
    }
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("requires installed controller composition before requesting capacity", async () => {
    const f = setup(false, true, true, true, true);
    await expect(f.driver.observeCapacity(f.exchange, f.authorize)).rejects.toThrow(); expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== "win32")("pinned helper mounted workspace protocol", () => {
  const priorStages = async (f: ReturnType<typeof setup>) => {
    await f.creation(); await f.volume(); await f.format(); await f.protect(); await f.mount();
  };
  it("encodes complete recovery and refuses omitted workspace history before launch", async () => {
    const f = setup(true, true, true, true, true), parent = f.custody.parentPath;
    const create = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, undefined, true, true, true, true, true);
    expect(create.readUInt32LE(8)).toBe(11); create.writeUInt32LE(1, 8);
    expect(create).toEqual(encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000));
    const recover = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, f.records[0], f.exchange, true, true, true, true);
    const base = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, f.records[0]);
    expect(recover.readUInt32LE(8)).toBe(12); recover.writeUInt32LE(2, 8);
    expect(recover.subarray(0, base.length)).toEqual(base);
    expect(recover.subarray(base.length)).toEqual(Buffer.from([
      ...f.exchange.volumeRecords!, ...f.exchange.formatRecords!, ...f.exchange.protectionRecords!,
      ...f.exchange.records, ...f.exchange.mountRecords!, ...f.exchange.mountedWorkspaceRecords!,
    ].join(""), "hex"));
    for (const length of [0, 1]) await expect(f.driver.recoverMountedWorkspace({ ...f.exchange,
      mountedWorkspaceRecords: f.exchange.mountedWorkspaceRecords!.slice(0, length) })).rejects.toThrow();
    for (const recoverEarlier of [f.driver.recoverMount, f.driver.recoverProtection, f.driver.recoverFormat, f.driver.recoverVolume])
      await expect(recoverEarlier(f.exchange)).rejects.toThrow();
    expect(() => encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, undefined, true, true, true, false, true)).toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("acknowledges all 21 records and accepts exactly 256 authority challenges within 33150 bytes", async () => {
    const f = setup(true, true, true, true, true), running = f.start();
    let outputBytes = 0; f.child.stdout.on("data", (chunk: Buffer) => { outputBytes += chunk.length; });
    expect((await f.input()).readUInt32LE(8)).toBe(11); await priorStages(f); await f.mountedWorkspace();
    for (let ordinal = 17; ordinal <= 256; ordinal++) await f.authority(ordinal, 21);
    const ended = once(f.child.stdin, "finish"); f.child.stdout.write(frame(2, receipt(true, true, true, true, true)));
    await ended; f.child.close(); await expect(running).resolves.toBeUndefined();
    expect(outputBytes).toBe(33150); expect(f.authorize).toHaveBeenCalledTimes(256);
    expect(f.commit.mock.calls.map(([record]) => record)).toEqual(f.records); expect(f.child.kill).not.toHaveBeenCalled();
  });
  it("recovers the exact 21 records without granting writes", async () => {
    const f = setup(true, true, true, true, true), running = f.start(true);
    expect((await f.input()).readUInt32LE(8)).toBe(12);
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    f.child.stdout.write(frame(2, receipt(false, true, true, true, true))); f.child.close();
    await expect(running).resolves.toEqual({ records: f.exchange.records, volumeRecords: f.exchange.volumeRecords,
      formatRecords: f.exchange.formatRecords, protectionRecords: f.exchange.protectionRecords,
      mountRecords: f.exchange.mountRecords, mountedWorkspaceRecords: f.exchange.mountedWorkspaceRecords });
    expect(f.commit).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
  });
  it.each([19, 20, 21])("requires fresh authority at workspace boundary %s", async (count) => {
    const f = setup(true, true, true, true, true), running = f.start(); await f.input(); await priorStages(f);
    for (let i = 19; i < count; i++) { await f.authority(i - 4, i); await f.checkpoint(i); }
    f.child.stdout.write(count === 21 ? frame(2, receipt(true, true, true, true, true)) : frame(1, Buffer.from(f.records[count]!, "hex")));
    f.child.close(); await expect(running).rejects.toThrow(); expect(f.commit).toHaveBeenCalledTimes(count);
  });
  it.each([19, 20])("withholds workspace acknowledgement %s for a different canonical digest", async (index) => {
    const f = setup(true, true, true, true, true), running = f.start(); await f.input(); await priorStages(f);
    await f.authority(15, 19); if (index === 20) { await f.checkpoint(19); await f.authority(16, 20); }
    f.commit.mockResolvedValueOnce("f".repeat(64)); const write = vi.spyOn(f.child.stdin, "write");
    f.child.stdout.write(frame(1, Buffer.from(f.records[index]!, "hex")));
    await expect(running).rejects.toThrow(); expect(write).not.toHaveBeenCalled(); expect(f.child.kill).toHaveBeenCalledOnce();
  });
  it.each([328, 360, 392, 432, 456])("rejects rehashed mount, policy, name, root or directory substitution at byte %s", async (offset) => {
    const f = setup(true, true, true, true, true), running = f.start(); await f.input(); await priorStages(f);
    await f.authority(15, 19); await f.checkpoint(19); await f.authority(16, 20);
    const record = Buffer.from(f.records[20]!, "hex"); record[offset] = record[offset]! ^ 1;
    createHash("sha256").update(record.subarray(280, 760)).digest().copy(record, 760);
    createHash("sha256").update(record.subarray(0, 992)).digest().copy(record, 992);
    f.child.stdout.write(frame(1, record)); await expect(running).rejects.toThrow(); expect(f.commit).toHaveBeenCalledTimes(20);
  });
  it.each(["missing", "reordered", "write-authority", "creation-receipt", "extra-record"])("refuses %s workspace evidence on recovery", async (failure) => {
    const f = setup(true, true, true, true, true), running = f.start(true); await f.input();
    for (const record of f.records.slice(0, 19)) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    if (failure === "reordered") f.child.stdout.write(frame(1, Buffer.from(f.records[20]!, "hex")));
    else if (failure === "write-authority") f.child.stdout.write(frame(4, f.challenge(1, 19)));
    else if (failure === "missing") f.child.stdout.write(frame(2, receipt(false, true, true, true)));
    else {
      for (const record of f.records.slice(19)) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
      if (failure === "extra-record") f.child.stdout.write(frame(1, Buffer.from(f.records[20]!, "hex")));
      f.child.stdout.write(frame(2, receipt(failure === "creation-receipt", true, true, true, true)));
    }
    f.child.close(); await expect(running).rejects.toThrow(); expect(f.commit).not.toHaveBeenCalled();
  });
  it.each(["challenge", "bytes"])("refuses workspace output beyond the %s bound", async (mode) => {
    const f = setup(true, true, true, true, true), running = f.start(); await f.input(); await priorStages(f); await f.mountedWorkspace();
    for (let ordinal = 17; ordinal <= 256; ordinal++) await f.authority(ordinal, 21);
    f.child.stdout.write(mode === "challenge" ? frame(4, f.challenge(257, 21)) : Buffer.alloc(22));
    await expect(running).rejects.toThrow(); expect(f.authorize).toHaveBeenCalledTimes(256); expect(f.child.kill).toHaveBeenCalledOnce();
  });
  it("refuses workspace operations without installed controller composition", async () => {
    const f = setup(false, true, true, true, true); await expect(f.start()).rejects.toThrow(); await expect(f.start(true)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe("private native volume input encoding", () => {
  it("preserves legacy creation bytes and appends exactly six canonical records for recovery", () => {
    const f = setup(), parent = f.custody.parentPath;
    const legacy = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000);
    const create = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, undefined, true);
    expect(create.readUInt32LE(8)).toBe(3); create.writeUInt32LE(1, 8); expect(create).toEqual(legacy);
    const recover = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, f.records[0], f.exchange);
    const base = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, f.records[0]);
    expect(recover.readUInt32LE(8)).toBe(4); recover.writeUInt32LE(2, 8);
    expect(recover.subarray(0, base.length)).toEqual(base);
    expect(recover.subarray(base.length)).toEqual(Buffer.from(f.exchange.volumeRecords!.join(""), "hex"));
  });
  it("refuses partial, foreign, or creation/recovery-mixed history before launch", async () => {
    const f = setup();
    for (const length of [0, 1, 2, 3, 4, 5]) await expect(f.driver.recoverVolume({ ...f.exchange,
      volumeRecords: f.exchange.volumeRecords!.slice(0, length) })).rejects.toThrow();
    expect(() => encodeWindowsWorkerCellProvisioning(f.plan, f.custody.parentPath, 3000, f.records[0], true)).toThrow();
    expect(() => encodeWindowsWorkerCellProvisioning({ ...f.plan, cellName: `gc-cell-${"f".repeat(32)}` },
      f.custody.parentPath, 3000, f.records[0], f.exchange)).toThrow();
    expect(() => encodeWindowsWorkerCellProvisioning(workerCellProvisioningFixture().plan,
      f.custody.parentPath, 3000, undefined, true)).toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== "win32")("pinned helper mount protocol", () => {
  it("preserves legacy bytes and independently supplies every creation and mount record on recovery", async () => {
    const f = setup(true, true, true, true), parent = f.custody.parentPath;
    const create = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, undefined, true, true, true, true);
    const legacy = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000);
    expect(create.readUInt32LE(8)).toBe(9); create.writeUInt32LE(1, 8); expect(create).toEqual(legacy);
    const recover = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, f.records[0], f.exchange, true, true, true);
    const base = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, f.records[0]);
    expect(recover.readUInt32LE(8)).toBe(10); recover.writeUInt32LE(2, 8);
    expect(recover.subarray(0, base.length)).toEqual(base);
    expect(recover.subarray(base.length)).toEqual(Buffer.from([...f.records.slice(5, 15), ...f.records.slice(0, 5), ...f.records.slice(15)].join(""), "hex"));
    for (const length of [0, 1, 2, 3]) await expect(f.driver.recoverMount({ ...f.exchange, mountRecords: f.exchange.mountRecords!.slice(0, length) })).rejects.toThrow();
    for (const shorter of [f.driver.recoverProtection, f.driver.recoverFormat, f.driver.recoverVolume]) await expect(shorter(f.exchange)).rejects.toThrow();
    expect(() => encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, undefined, true, true, false, true)).toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("commits nineteen records and all 256 allowed authority challenges within the unchanged output limit", async () => {
    const f = setup(true, true, true, true), running = f.start();
    expect((await f.input()).readUInt32LE(8)).toBe(9);
    await f.creation(); await f.volume(); await f.format(); await f.protect(); await f.mount();
    for (let ordinal = 15; ordinal <= 256; ordinal++) await f.authority(ordinal, 19);
    const ended = once(f.child.stdin, "finish"); f.child.stdout.write(frame(2, receipt(true, true, true, true)));
    await ended; f.child.close(); await expect(running).resolves.toBeUndefined();
    expect(f.commit.mock.calls.map(([record]) => record)).toEqual(f.records);
    expect(f.authorize).toHaveBeenCalledTimes(256); expect(f.child.kill).not.toHaveBeenCalled();
  });
  it("recovers nineteen exact records without write acknowledgements", async () => {
    const f = setup(true, true, true, true), running = f.start(true);
    expect((await f.input()).readUInt32LE(8)).toBe(10);
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    f.child.stdout.write(frame(2, receipt(false, true, true, true))); f.child.close();
    await expect(running).resolves.toEqual({ records: f.exchange.records, volumeRecords: f.exchange.volumeRecords,
      formatRecords: f.exchange.formatRecords, protectionRecords: f.exchange.protectionRecords, mountRecords: f.exchange.mountRecords });
    expect(f.commit).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
  });
  it.each([15, 16, 17, 18, 19])("requires current authority at mount checkpoint boundary %s", async (index) => {
    const f = setup(true, true, true, true), running = f.start(); await f.input();
    await f.creation(); await f.volume(); await f.format(); await f.protect();
    for (let i = 15; i < index; i++) { await f.authority(i - 4, i); await f.checkpoint(i); }
    f.child.stdout.write(index === 19 ? frame(2, receipt(true, true, true, true)) : frame(1, Buffer.from(f.records[index]!, "hex")));
    f.child.close(); await expect(running).rejects.toThrow(); expect(f.commit).toHaveBeenCalledTimes(index);
  });
  it.each([15, 16, 17, 18])("withholds the acknowledgement for mount record %s on canonical digest mismatch", async (index) => {
    const f = setup(true, true, true, true), running = f.start(); await f.input();
    await f.creation(); await f.volume(); await f.format(); await f.protect();
    for (let i = 15; i <= index; i++) { await f.authority(i - 4, i); if (i < index) await f.checkpoint(i); }
    f.commit.mockResolvedValueOnce("f".repeat(64)); const write = vi.spyOn(f.child.stdin, "write");
    f.child.stdout.write(frame(1, Buffer.from(f.records[index]!, "hex")));
    await expect(running).rejects.toThrow(); expect(write).not.toHaveBeenCalled(); expect(f.child.kill).toHaveBeenCalledOnce();
  });
  it.each([328, 360, 392, 408, 432, 456])("rejects rehashed protection, policy, volume, parent, root or directory mismatch at byte %s", async (offset) => {
    const f = setup(true, true, true, true), running = f.start(); await f.input();
    await f.creation(); await f.volume(); await f.format(); await f.protect();
    for (let i = 15; i < 18; i++) { await f.authority(i - 4, i); await f.checkpoint(i); }
    await f.authority(14, 18);
    const record = Buffer.from(f.records[18]!, "hex"); record[offset] = record[offset]! ^ 1;
    createHash("sha256").update(record.subarray(280, 760)).digest().copy(record, 760);
    createHash("sha256").update(record.subarray(0, 992)).digest().copy(record, 992);
    f.child.stdout.write(frame(1, record)); await expect(running).rejects.toThrow(); expect(f.commit).toHaveBeenCalledTimes(18);
  });
  it.each(["missing", "reordered", "write-authority", "creation-receipt", "extra-record", "changed-creation"])("refuses %s mount recovery evidence", async (failure) => {
    const f = setup(true, true, true, true), running = f.start(true); await f.input();
    for (let i = 0; i < 15; i++) {
      const record = Buffer.from(f.records[i]!, "hex");
      if (failure === "changed-creation" && i === 2) {
        record[672] = record[672]! ^ 1; createHash("sha256").update(record.subarray(0, 992)).digest().copy(record, 992);
      }
      f.child.stdout.write(frame(1, record));
    }
    if (failure === "reordered") f.child.stdout.write(frame(1, Buffer.from(f.records[16]!, "hex")));
    else if (failure === "write-authority") f.child.stdout.write(frame(4, f.challenge(1, 15)));
    else if (failure === "missing") f.child.stdout.write(frame(2, receipt(false, true, true)));
    else {
      for (const record of f.records.slice(15)) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
      if (failure === "extra-record") f.child.stdout.write(frame(1, Buffer.from(f.records[18]!, "hex")));
      f.child.stdout.write(frame(2, receipt(failure === "creation-receipt", true, true, true)));
    }
    f.child.close(); await expect(running).rejects.toThrow(); expect(f.commit).not.toHaveBeenCalled();
  });
  it("refuses mount calls without the installed controller composition", async () => {
    const f = setup(false, true, true, true); await expect(f.start()).rejects.toThrow(); await expect(f.start(true)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== "win32")("pinned helper protection protocol", () => {
  it("encodes operations seven/eight and preserves every earlier byte and complete recovery stage", async () => {
    const f = setup(true, true, true), parent = f.custody.parentPath;
    const create = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, undefined, true, true, true);
    const legacy = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000);
    expect(create.readUInt32LE(8)).toBe(7); create.writeUInt32LE(1, 8); expect(create).toEqual(legacy);
    const recover = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, f.records[0], f.exchange, true, true);
    const base = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, f.records[0]);
    expect(recover.readUInt32LE(8)).toBe(8); recover.writeUInt32LE(2, 8);
    expect(recover.subarray(0, base.length)).toEqual(base);
    expect(recover.subarray(base.length)).toEqual(Buffer.from(f.records.slice(5).join(""), "hex"));
    for (const length of [0, 1]) await expect(f.driver.recoverProtection({ ...f.exchange,
      protectionRecords: f.exchange.protectionRecords!.slice(0, length) })).rejects.toThrow();
    await expect(f.driver.recoverFormat(f.exchange)).rejects.toThrow();
    await expect(f.driver.recoverVolume(f.exchange)).rejects.toThrow();
    expect(() => encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, undefined, true, false, true)).toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("commits all fifteen records before success and requires fresh authority after the final acknowledgement", async () => {
    const f = setup(true, true, true), running = f.start();
    expect((await f.input()).readUInt32LE(8)).toBe(7);
    await f.creation(); await f.volume(); await f.format(); await f.protect();
    expect(f.child.stdin.writableEnded).toBe(false); await f.authority(11, 15);
    const ended = once(f.child.stdin, "finish"); f.child.stdout.write(frame(2, receipt(true, true, true)));
    await ended; f.child.close(); await expect(running).resolves.toBeUndefined();
    expect(f.commit.mock.calls.map(([record]) => record)).toEqual(f.records);
    expect(f.authorize).toHaveBeenCalledTimes(11); expect(f.child.kill).not.toHaveBeenCalled();
  });
  it("recovers all fifteen exact canonical records without acknowledgements or authority for writes", async () => {
    const f = setup(true, true, true), running = f.start(true);
    expect((await f.input()).readUInt32LE(8)).toBe(8);
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    f.child.stdout.write(frame(2, receipt(false, true, true))); f.child.close();
    await expect(running).resolves.toEqual({ records: f.exchange.records, volumeRecords: f.exchange.volumeRecords,
      formatRecords: f.exchange.formatRecords, protectionRecords: f.exchange.protectionRecords });
    expect(f.commit).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
  });
  it.each(["intent", "completion", "terminal"])("refuses missing authority at the protection %s boundary", async (boundary) => {
    const f = setup(true, true, true), running = f.start(); await f.input(); await f.creation(); await f.volume(); await f.format();
    if (boundary === "completion") { await f.authority(9, 13); await f.checkpoint(13); }
    if (boundary === "terminal") await f.protect();
    f.child.stdout.write(boundary === "terminal" ? frame(2, receipt(true, true, true)) :
      frame(1, Buffer.from(f.records[boundary === "intent" ? 13 : 14]!, "hex")));
    f.child.close(); await expect(running).rejects.toThrow();
    expect(f.commit).toHaveBeenCalledTimes(boundary === "intent" ? 13 : boundary === "completion" ? 14 : 15);
  });
  it.each([13, 14])("withholds acknowledgement when canonical checkpoint %s has a different digest", async (index) => {
    const f = setup(true, true, true), running = f.start(); await f.input(); await f.creation(); await f.volume(); await f.format();
    await f.authority(9, 13);
    if (index === 14) { await f.checkpoint(13); await f.authority(10, 14); }
    f.commit.mockResolvedValueOnce("f".repeat(64)); const write = vi.spyOn(f.child.stdin, "write");
    f.child.stdout.write(frame(1, Buffer.from(f.records[index]!, "hex")));
    await expect(running).rejects.toThrow(); expect(write).not.toHaveBeenCalled(); expect(f.child.kill).toHaveBeenCalledOnce();
  });
  it.each([328, 360, 392, 448])("rejects a rehashed format/policy/volume/root mismatch at byte %s", async (offset) => {
    const f = setup(true, true, true), running = f.start(); await f.input(); await f.creation(); await f.volume(); await f.format();
    await f.authority(9, 13); await f.checkpoint(13); await f.authority(10, 14);
    const record = Buffer.from(f.records[14]!, "hex"); record[offset] = record[offset]! ^ 1;
    createHash("sha256").update(record.subarray(280, 760)).digest().copy(record, 760);
    createHash("sha256").update(record.subarray(0, 992)).digest().copy(record, 992);
    f.child.stdout.write(frame(1, record)); await expect(running).rejects.toThrow();
    expect(f.commit).toHaveBeenCalledTimes(14);
  });
  it.each(["missing", "reordered", "write-authority", "creation-receipt", "extra-record"])("refuses %s protection evidence on recovery", async (failure) => {
    const f = setup(true, true, true), running = f.start(true); await f.input();
    for (const record of f.records.slice(0, 13)) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    if (failure === "reordered") f.child.stdout.write(frame(1, Buffer.from(f.records[14]!, "hex")));
    else if (failure === "write-authority") f.child.stdout.write(frame(4, f.challenge(1, 13)));
    else if (failure === "missing") f.child.stdout.write(frame(2, receipt(false, true)));
    else {
      for (const record of f.records.slice(13)) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
      if (failure === "extra-record") f.child.stdout.write(frame(1, Buffer.from(f.records[14]!, "hex")));
      f.child.stdout.write(frame(2, receipt(failure === "creation-receipt", true, true)));
    }
    f.child.close(); await expect(running).rejects.toThrow(); expect(f.commit).not.toHaveBeenCalled();
  });
  it("refuses protection calls without installed controller composition", async () => {
    const f = setup(false, true, true); await expect(f.start()).rejects.toThrow(); await expect(f.start(true)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== "win32")("pinned helper format protocol", () => {
  it("encodes new format operations and refuses partial or silently omitted format history before launch", async () => {
    const f = setup(true, true), parent = f.custody.parentPath;
    const create = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, undefined, true, true);
    const legacy = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000);
    expect(create.readUInt32LE(8)).toBe(5); create.writeUInt32LE(1, 8); expect(create).toEqual(legacy);
    const recover = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, f.records[0], f.exchange, true);
    const base = encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, f.records[0]);
    expect(recover.readUInt32LE(8)).toBe(6); recover.writeUInt32LE(2, 8);
    expect(recover.subarray(0, base.length)).toEqual(base);
    expect(recover.subarray(base.length)).toEqual(Buffer.from(f.records.slice(5).join(""), "hex"));
    for (const length of [0, 1]) await expect(f.driver.recoverFormat({ ...f.exchange,
      formatRecords: f.exchange.formatRecords!.slice(0, length) })).rejects.toThrow();
    await expect(f.driver.recoverVolume(f.exchange)).rejects.toThrow();
    expect(() => encodeWindowsWorkerCellProvisioning(f.plan, parent, 3000, undefined, undefined, true)).toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("commits all thirteen records and requires fresh terminal authority before closing input", async () => {
    const f = setup(true, true), running = f.start();
    expect((await f.input()).readUInt32LE(8)).toBe(5);
    await f.creation(); await f.volume(); await f.format();
    expect(f.child.stdin.writableEnded).toBe(false); await f.authority(9, 13);
    const ended = once(f.child.stdin, "finish"); f.child.stdout.write(frame(2, receipt(true, true)));
    await ended; f.child.close(); await expect(running).resolves.toBeUndefined();
    expect(f.commit.mock.calls.map(([record]) => record)).toEqual(f.records);
    expect(f.authorize).toHaveBeenCalledTimes(9); expect(f.child.kill).not.toHaveBeenCalled();
  });
  it("returns all thirteen exact canonical records during recovery without write acknowledgements", async () => {
    const f = setup(true, true), running = f.start(true);
    expect((await f.input()).readUInt32LE(8)).toBe(6);
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    f.child.stdout.write(frame(2, receipt(false, true))); f.child.close();
    await expect(running).resolves.toEqual({ records: f.exchange.records, volumeRecords: f.exchange.volumeRecords,
      formatRecords: f.exchange.formatRecords });
    expect(f.commit).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
  });
  it.each(["intent", "completion", "terminal"])("refuses missing authority at the format %s boundary", async (boundary) => {
    const f = setup(true, true), running = f.start(); await f.input(); await f.creation(); await f.volume();
    if (boundary === "completion") { await f.authority(7, 11); await f.checkpoint(11); }
    if (boundary === "terminal") await f.format();
    f.child.stdout.write(boundary === "terminal" ? frame(2, receipt(true, true)) :
      frame(1, Buffer.from(f.records[boundary === "intent" ? 11 : 12]!, "hex")));
    f.child.close(); await expect(running).rejects.toThrow();
    expect(f.commit).toHaveBeenCalledTimes(boundary === "intent" ? 11 : boundary === "completion" ? 12 : 13);
  });
  it("withholds the format intent acknowledgement when canonical storage returns another hash", async () => {
    const f = setup(true, true), running = f.start(); await f.input(); await f.creation(); await f.volume(); await f.authority(7, 11);
    f.commit.mockResolvedValueOnce("f".repeat(64)); const write = vi.spyOn(f.child.stdin, "write");
    f.child.stdout.write(frame(1, Buffer.from(f.records[11]!, "hex")));
    await expect(running).rejects.toThrow(); expect(write).not.toHaveBeenCalled(); expect(f.child.kill).toHaveBeenCalledOnce();
  });
  it.each(["missing", "reordered", "write-authority", "creation-receipt"])("refuses %s format evidence on recovery", async (failure) => {
    const f = setup(true, true), running = f.start(true); await f.input();
    for (const record of f.records.slice(0, 11)) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    if (failure === "reordered") f.child.stdout.write(frame(1, Buffer.from(f.records[12]!, "hex")));
    else if (failure === "write-authority") f.child.stdout.write(frame(4, f.challenge(1, 11)));
    else if (failure === "creation-receipt") {
      for (const record of f.records.slice(11)) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
      f.child.stdout.write(frame(2, receipt(true, true)));
    } else f.child.stdout.write(frame(2, receipt(false)));
    f.child.close(); await expect(running).rejects.toThrow(); expect(f.commit).not.toHaveBeenCalled();
  });
  it("refuses format calls when the installed controller is not selected", async () => {
    const f = setup(false, true); await expect(f.start()).rejects.toThrow(); await expect(f.start(true)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== "win32")("pinned helper volume protocol", () => {
  it("retains eleven acknowledgements and keeps stdin open for final authority before the receipt", async () => {
    const f = setup(), running = f.start();
    expect((await f.input()).readUInt32LE(8)).toBe(3);
    await f.creation(); await f.volume();
    expect(f.child.stdin.writableEnded).toBe(false);
    await f.authority(7, 11);
    const ended = once(f.child.stdin, "finish"); f.child.stdout.write(frame(2, receipt()));
    await ended; f.child.close(); await expect(running).resolves.toBeUndefined();
    expect(f.commit.mock.calls.map(([record]) => record)).toEqual(f.records);
    expect(f.authorize).toHaveBeenCalledTimes(7); expect(f.child.kill).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(f.executorPath, ["--controller"], expect.objectContaining({ windowsHide: true, shell: false }));
  });
  it("waits for the current canonical authority callback before echoing a challenge", async () => {
    const f = setup(), running = f.start(); await f.input(); await f.creation();
    let release!: () => void, entered!: () => void;
    const admitted = new Promise<void>((resolve) => { entered = resolve; });
    f.authorize.mockImplementationOnce(() => { entered(); return new Promise<void>((resolve) => { release = resolve; }); });
    const write = vi.spyOn(f.child.stdin, "write");
    f.child.stdout.write(frame(4, f.challenge())); await admitted;
    expect(write).not.toHaveBeenCalled(); release(); expect(await f.input()).toEqual(frame(5, f.challenge()));
    f.controller.abort(); await expect(running).rejects.toThrow(); expect(f.child.kill).toHaveBeenCalledOnce();
  });
  it.each(["first", "between", "terminal"])("refuses missing fresh authority at the %s volume boundary", async (boundary) => {
    const f = setup(), running = f.start(); await f.input(); await f.creation();
    if (boundary === "between") { await f.authority(); await f.checkpoint(5); }
    if (boundary === "terminal") await f.volume();
    if (boundary === "terminal") f.child.stdin.once("finish", () => f.child.close());
    f.child.stdout.write(boundary === "terminal" ? frame(2, receipt()) : frame(1, Buffer.from(f.records[boundary === "first" ? 5 : 6]!, "hex")));
    // A clean helper exit cannot turn an omitted authorization into success.
    if (boundary !== "terminal") f.child.close();
    await expect(running).rejects.toThrow();
    expect(f.commit).toHaveBeenCalledTimes(boundary === "first" ? 5 : boundary === "between" ? 6 : 11);
  });
  it.each(["ordinal-zero", "ordinal-skipped", "ordinal-overflow", "count", "head", "length", "replay"])(
    "refuses a malformed or stale %s challenge without authorizing it", async (kind) => {
      const f = setup(), running = f.start(); await f.input(); await f.creation();
      if (kind === "replay") await f.authority();
      let bytes = f.challenge();
      if (kind === "ordinal-zero") bytes.writeUInt32LE(0);
      if (kind === "ordinal-skipped") bytes.writeUInt32LE(2);
      if (kind === "ordinal-overflow") bytes.writeUInt32LE(257);
      if (kind === "count") bytes.writeUInt32LE(6, 4);
      if (kind === "head") bytes[8] = bytes[8]! ^ 1;
      if (kind === "length") bytes = bytes.subarray(0, 39);
      f.child.stdout.write(frame(4, bytes)); await expect(running).rejects.toThrow();
      expect(f.authorize).toHaveBeenCalledTimes(kind === "replay" ? 1 : 0);
      expect(f.commit).toHaveBeenCalledTimes(5); expect(f.child.kill).toHaveBeenCalledOnce();
    },
  );
  it("bounds a correctly numbered but excessive authority conversation", async () => {
    const f = setup(), running = f.start(); await f.input(); await f.creation();
    for (let ordinal = 1; ordinal <= 256; ordinal++) await f.authority(ordinal);
    f.child.stdout.write(frame(4, f.challenge(257))); await expect(running).rejects.toThrow();
    expect(f.authorize).toHaveBeenCalledTimes(256); expect(f.commit).toHaveBeenCalledTimes(5);
  });
  it.each(["denied", "cancelled", "final-denied"])("stops the owned helper when authority is %s", async (kind) => {
    const f = setup(), running = f.start(); await f.input(); await f.creation();
    if (kind === "final-denied") await f.volume();
    f.authorize.mockImplementationOnce(async () => {
      if (kind === "cancelled") { f.controller.abort(); return new Promise<void>(() => undefined); }
      throw new Error("canonical lease revoked");
    });
    f.child.stdout.write(frame(4, f.challenge(kind === "final-denied" ? 7 : 1, kind === "final-denied" ? 11 : 5)));
    await expect(running).rejects.toThrow(); expect(f.child.kill).toHaveBeenCalledOnce(); expect(mocks.spawn).toHaveBeenCalledOnce();
  });
  it("withholds a volume acknowledgement after a mismatched canonical commit", async () => {
    const f = setup(), running = f.start(); await f.input(); await f.creation(); await f.authority();
    f.commit.mockResolvedValueOnce("f".repeat(64)); const write = vi.spyOn(f.child.stdin, "write");
    f.child.stdout.write(frame(1, Buffer.from(f.records[5]!, "hex")));
    await expect(running).rejects.toThrow(); expect(write).not.toHaveBeenCalled(); expect(f.child.kill).toHaveBeenCalledOnce();
  });
  it("recovers the exact complete history read-only with no commit or authority replies", async () => {
    const f = setup(), running = f.start(true), bytes = await f.input();
    expect(bytes.readUInt32LE(8)).toBe(4); await once(f.child.stdin, "finish");
    for (const record of f.records) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    f.child.stdout.write(frame(2, receipt(false))); f.child.close();
    const result = await running; expect(result).toEqual({ records: f.exchange.records, volumeRecords: f.exchange.volumeRecords });
    expect(Object.isFrozen(result)).toBe(true); expect(f.commit).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
  });
  it.each(["different-history", "authority-during-recovery", "creation-receipt"])("refuses %s during recovery", async (kind) => {
    const f = setup(), running = f.start(true); await f.input();
    for (const record of f.records.slice(0, 5)) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
    if (kind === "different-history") f.child.stdout.write(frame(1, Buffer.from(f.records[6]!, "hex")));
    else if (kind === "authority-during-recovery") f.child.stdout.write(frame(4, f.challenge()));
    else {
      for (const record of f.records.slice(5)) f.child.stdout.write(frame(1, Buffer.from(record, "hex")));
      f.child.stdout.write(frame(2, receipt()));
    }
    f.child.close(); await expect(running).rejects.toThrow(); expect(f.commit).not.toHaveBeenCalled();
  });
  it("never falls back to direct creation for an unconfigured controller", async () => {
    const f = setup(false); await expect(f.start()).rejects.toThrow(); await expect(f.start(true)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
