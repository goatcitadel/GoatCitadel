import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWindowsWorkerCellProvisioning, decodeWindowsWorkerCellControllerCustody, readWindowsWorkerCellControllerCustody } from "./worker-windows-cell-provisioning.js";
import { workerCellProvisioningFixture } from "./worker-cell-provisioning-test-fixture.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

// Independent fixture, also checked against the actual C++ encoder in the named
// native client-identity lane. These bytes alone never confer installation trust.
const parentPath = "C:\\ProgramData\\GoatCitadel\\RemoteWorker\\cells";
function custodyBytes(parent = parentPath): Buffer {
  const encodedPath = Buffer.from(parent);
  const bytes = Buffer.alloc(132 + encodedPath.length);
  bytes.write("GCCINF01"); bytes.writeUInt32LE(encodedPath.length, 8); bytes.write("GCCUST01", 12);
  bytes.fill(0x11, 20, 52); bytes.fill(0x22, 52, 84);
  bytes.writeBigUInt64LE(0x0102030405060708n, 84); bytes.fill(0x33, 92, 108);
  bytes.writeBigUInt64LE(0x0102030405060708n, 108); bytes.fill(0x44, 116, 132);
  encodedPath.copy(bytes, 132);
  return bytes;
}

describe("installed controller custody decoding", () => {
  it("returns an immutable projection with the hash of the exact custody record", () => {
    const bytes = custodyBytes();
    const snapshot = decodeWindowsWorkerCellControllerCustody(bytes);
    expect(snapshot).toEqual({ schemaVersion: "goatcitadel.worker-windows-cell-controller-custody.v1", parentPath,
      controllerSha256: "11".repeat(32), provisioningSha256: "22".repeat(32),
      nativeDirectoryIdentityHex: "0807060504030201" + "33".repeat(16),
      parentIdentityHex: "0807060504030201" + "44".repeat(16),
      custodySha256: createHash("sha256").update(bytes.subarray(12, 132)).digest("hex") });
    expect(Object.isFrozen(snapshot)).toBe(true);
    bytes.fill(0);
    expect(snapshot.controllerSha256).toBe("11".repeat(32));
    expect(decodeWindowsWorkerCellControllerCustody(custodyBytes(parentPath.replace("C:", "D:"))).parentPath).toMatch(/^D:/u);
  });

  const malformed: Array<[string, (bytes: Buffer) => Buffer]> = [
    ["short header", (bytes) => bytes.subarray(0, 12)],
    ["truncated record", (bytes) => bytes.subarray(0, 131)],
    ["truncated path", (bytes) => bytes.subarray(0, -1)],
    ["trailing byte", (bytes) => Buffer.concat([bytes, Buffer.alloc(1)])],
    ["oversized frame", () => Buffer.alloc(8325)],
    ["zero path length", (bytes) => { bytes.writeUInt32LE(0, 8); return bytes; }],
    ["future frame magic", (bytes) => { bytes[7] = 0x32; return bytes; }],
    ["high-bit frame alias", (bytes) => { bytes[0] = 0xc7; return bytes; }],
    ["high-bit record alias", (bytes) => { bytes[12] = 0xc7; return bytes; }],
    ["zero controller hash", (bytes) => bytes.fill(0, 20, 52)],
    ["zero helper hash", (bytes) => bytes.fill(0, 52, 84)],
    ["equal image hashes", (bytes) => bytes.fill(0x11, 52, 84)],
    ["zero volume", (bytes) => bytes.fill(0, 84, 92)],
    ["foreign parent volume", (bytes) => { bytes[108] = 9; return bytes; }],
    ["zero native directory", (bytes) => bytes.fill(0, 92, 108)],
    ["zero parent directory", (bytes) => bytes.fill(0, 116, 132)],
    ["same directory", (bytes) => bytes.fill(0x33, 116, 132)],
    ["invalid UTF-8", (bytes) => { bytes[bytes.length - 1] = 0xff; return bytes; }],
  ];
  it.each(malformed)("refuses %s", (_name, mutate) => {
    expect(() => decodeWindowsWorkerCellControllerCustody(mutate(custodyBytes()))).toThrow();
  });
  it.each(["", "relative", parentPath + "\0", parentPath + "\\..\\cells", parentPath + "\\", parentPath + ":stream",
    "\\\\host\\share\\cells", "\\\\?\\" + parentPath, parentPath.replaceAll("\\", "/"), parentPath.toLowerCase()])(
    "refuses a noncanonical installed parent %j", (parent) => {
      expect(() => decodeWindowsWorkerCellControllerCustody(custodyBytes(parent))).toThrow();
    },
  );
});

class OwnedChild extends EventEmitter {
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

describe.skipIf(process.platform !== "win32")("pinned controller custody read owner", () => {
  const children: OwnedChild[] = [];
  beforeEach(() => mocks.spawn.mockReset());
  afterEach(() => { for (const child of children.splice(0)) child.close(1); });
  function setup(onInputClosed: (child: OwnedChild) => void = () => undefined) {
    const child = new OwnedChild(); children.push(child);
    const controller = new AbortController();
    const executorPath = path.join(process.cwd(), "fixture", "GoatCitadelRemoteWorkerCellProvisioning.exe");
    const imageGuard = { pinCellProvisioningExecutor: vi.fn(() => ({ executorPath, lease: {} })) };
    const assertCurrent = vi.fn(async () => undefined);
    child.stdin.on("finish", () => onInputClosed(child));
    mocks.spawn.mockReturnValueOnce(child);
    return { child, controller, executorPath, imageGuard, assertCurrent,
      options: { signal: controller.signal, wallMs: 1000, imageGuard, assertCurrent } };
  }
  it("reads only the pinned helper with empty stdin and checks authority before and after", async () => {
    const f = setup((child) => {
      const bytes = custodyBytes();
      child.stdout.write(bytes.subarray(0, 40)); child.stdout.write(bytes.subarray(40));
      bytes.fill(0); child.close();
    });
    const write = vi.spyOn(f.child.stdin, "write");
    await expect(readWindowsWorkerCellControllerCustody(f.options)).resolves.toEqual(decodeWindowsWorkerCellControllerCustody(custodyBytes()));
    expect(f.assertCurrent).toHaveBeenCalledTimes(2);
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(f.executorPath, ["--controller-custody"], {
      cwd: path.dirname(f.executorPath), windowsHide: true, shell: false,
      env: { SystemRoot: process.env.SystemRoot }, stdio: ["pipe", "pipe", "pipe"] });
    expect(write).not.toHaveBeenCalled(); expect(f.child.kill).not.toHaveBeenCalled();
  });
  it("does not launch after cancellation or refused initial authority", async () => {
    const f = setup(); f.controller.abort();
    await expect(readWindowsWorkerCellControllerCustody(f.options)).rejects.toThrow();
    expect(f.assertCurrent).not.toHaveBeenCalled();
    const current = new AbortController();
    f.assertCurrent.mockRejectedValueOnce(new Error("lease revoked"));
    await expect(readWindowsWorkerCellControllerCustody({ ...f.options, signal: current.signal })).rejects.toThrow("lease revoked");
    expect(f.imageGuard.pinCellProvisioningExecutor).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each([99, 10001, 100.5, NaN])("refuses invalid timeout %j before admission", async (wallMs) => {
    const f = setup();
    await expect(readWindowsWorkerCellControllerCustody({ ...f.options, wallMs })).rejects.toThrow();
    expect(f.assertCurrent).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("refuses a substituted helper path before launch", async () => {
    const f = setup();
    f.imageGuard.pinCellProvisioningExecutor.mockReturnValueOnce({ executorPath: "C:\\untrusted.exe", lease: {} });
    await expect(readWindowsWorkerCellControllerCustody(f.options)).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  const failures: Array<[string, (child: OwnedChild) => void]> = [
    ["stderr output", (child) => child.stderr.write("refused")],
    ["oversized output", (child) => child.stdout.write(Buffer.alloc(8325))],
    ["process error", (child) => child.emit("error", new Error("spawn failed"))],
    ["stdin error", (child) => child.stdin.emit("error", new Error("input failed"))],
    ["stdout error", (child) => child.stdout.emit("error", new Error("output failed"))],
    ["stderr error", (child) => child.stderr.emit("error", new Error("output failed"))],
  ];
  it.each(failures)("joins its own child after %s", async (_name, fail) => {
    const f = setup(fail);
    await expect(readWindowsWorkerCellControllerCustody(f.options)).rejects.toThrow();
    expect(f.child.kill).toHaveBeenCalled(); expect(f.child.signalCode).toBe("SIGTERM");
    expect(f.assertCurrent).toHaveBeenCalledTimes(1);
  });
  it.each([1, 5])("rejects complete-looking output on nonzero exit %i", async (code) => {
    const f = setup((child) => { child.stdout.write(custodyBytes()); child.close(code); });
    await expect(readWindowsWorkerCellControllerCustody(f.options)).rejects.toThrow();
    expect(f.assertCurrent).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed output even after a clean exit", async () => {
    const f = setup((child) => { child.stdout.write("invalid"); child.close(); });
    await expect(readWindowsWorkerCellControllerCustody(f.options)).rejects.toThrow();
    expect(f.assertCurrent).toHaveBeenCalledTimes(1);
  });
  it("joins its child on cancellation without exposing partial metadata", async () => {
    const f = setup((child) => { child.stdout.write(custodyBytes()); f.controller.abort(); });
    await expect(readWindowsWorkerCellControllerCustody(f.options)).rejects.toThrow();
    expect(f.child.signalCode).toBe("SIGTERM"); expect(f.assertCurrent).toHaveBeenCalledTimes(1);
  });
  it("bounds a child which never closes", async () => {
    const f = setup();
    await expect(readWindowsWorkerCellControllerCustody({ ...f.options, wallMs: 100 })).rejects.toThrow();
    expect(f.child.signalCode).toBe("SIGTERM");
  });
  it("refuses metadata if authority changes during the query", async () => {
    const f = setup((child) => { child.stdout.write(custodyBytes()); child.close(); });
    f.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("lease revoked after read"));
    await expect(readWindowsWorkerCellControllerCustody(f.options)).rejects.toThrow("lease revoked after read");
    expect(f.assertCurrent).toHaveBeenCalledTimes(2);
  });
  it("interrupts a stalled final authority check after the child has closed", async () => {
    const f = setup((child) => { child.stdout.write(custodyBytes()); child.close(); });
    f.assertCurrent.mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    await expect(readWindowsWorkerCellControllerCustody({ ...f.options, wallMs: 100 })).rejects.toThrow();
    expect(f.child.exitCode).toBe(0); expect(f.child.kill).not.toHaveBeenCalled();
  });
  it("native creation cancellation kills only its live child once and drains close", async () => {
    const f = setup();
    f.child.stdin.once("data", () => f.controller.abort());
    const driver = createWindowsWorkerCellProvisioning({ ...f.options, parentPath, controllerService: true });
    await expect(driver.create(workerCellProvisioningFixture().plan, async () => "0".repeat(64))).rejects.toThrow();
    expect(f.child.kill).toHaveBeenCalledOnce(); expect(f.child.signalCode).toBe("SIGTERM");
  });
});
