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
beforeEach(() => mocks.spawn.mockReset());
afterEach(() => { for (const child of children.splice(0)) child.close(1); });

function setup(controllerService = true, formatted = false, protectedRoot = false, mounted = false, workspace = false) {
  const f = workerCellProvisioningFixture(64), child = new Helper(); children.push(child);
  const exchange = (workspace ? mountedWorkspaceExchangeFixture : mounted ? mountExchangeFixture : protectedRoot ? protectionExchangeFixture : formatted ? formatExchangeFixture : volumeExchangeFixture)({ ...f.exchange, records: f.records });
  const records = [...f.records, ...exchange.volumeRecords!, ...(exchange.formatRecords ?? []), ...(exchange.protectionRecords ?? []), ...(exchange.mountRecords ?? []), ...(exchange.mountedWorkspaceRecords ?? [])];
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
  const driver = createWindowsWorkerCellProvisioning({ parentPath: f.custody.parentPath, wallMs: 3000,
    signal: controller.signal, assertCurrent, controllerService,
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
  return { ...f, child, exchange, records, controller, input, driver, commit, authorize, assertCurrent,
    start, checkpoint, challenge, authority, creation, volume, format, protect, mount, mountedWorkspace, executorPath };
}

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
