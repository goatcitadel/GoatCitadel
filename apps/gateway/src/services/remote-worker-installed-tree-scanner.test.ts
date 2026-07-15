import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeInstalledTreeAttestation } from "./remote-worker-attestation-service.js";
import {
  RemoteWorkerInstalledTreeScanner,
  assertRemoteWorkerWindowsObservationSafe,
  exerciseRemoteWorkerPosixScanHelperForTesting,
  remoteWorkerPosixScanHelperDiagnostics,
} from "./remote-worker-installed-tree-scanner.js";
import {
  remoteWorkerWindowsNoFollowHelperDiagnostics,
  type RemoteWorkerWindowsFileObservation,
} from "./remote-worker-windows-no-follow.js";

const MANIFEST_SHA256 = "a".repeat(64);
const NOW = new Date("2026-07-15T08:00:00.000Z");
const cleanupRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function observation(overrides: Partial<RemoteWorkerWindowsFileObservation> = {}): RemoteWorkerWindowsFileObservation {
  const ownerSid = "S-1-5-21-1-2-3-1001";
  return {
    volumeSerial: "0000000000000001",
    fileId: "00000000000000000000000000000002",
    sizeBytes: 3,
    linkCount: 1,
    attributes: 0x20,
    reparseTag: 0,
    creationTime: "133969248000000000",
    lastWriteTime: "133969248000000001",
    changeTime: "133969248000000002",
    ownerSid,
    sddl: `O:${ownerSid}D:P(A;;FA;;;${ownerSid})(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;BU)`,
    streams: ["::$DATA"],
    ...overrides,
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function validTree(vendorPayload: string | Buffer = "vendor"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "goat-worker-tree-"));
  cleanupRoots.push(root);
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot as string;
    const { stdout } = await execFileAsync(join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    const sid = /"(S-1-[0-9-]+)"/u.exec(stdout)?.[1];
    if (sid === undefined) throw new Error("Unable to resolve the Windows test operator SID.");
    await execFileAsync(join(systemRoot, "System32", "icacls.exe"), [
      root,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ]);
  }
  for (const directory of ["bundle", "locks", "launcher", "vendor/pkg", "runtime/bin"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, "bundle", "worker.js"), "bundle");
  await writeFile(join(root, "locks", "pnpm-lock.yaml"), "lock");
  await writeFile(join(root, "launcher", "start.cmd"), "launcher");
  await writeFile(join(root, "vendor", "pkg", "index.js"), vendorPayload);
  await writeFile(join(root, "runtime", "bin", "node.exe"), "runtime");
  return root;
}

describe("remote worker installed-tree scanner", () => {
  it("binds construction to one canonical manifest payload digest", () => {
    expect(() => new RemoteWorkerInstalledTreeScanner("A".repeat(64))).toThrow("manifest payload digest");
    expect(() => new RemoteWorkerInstalledTreeScanner("a".repeat(63))).toThrow("manifest payload digest");
  });

  it("rejects reparse points, hardlinks, ADS, and foreign writable ACLs from native evidence", () => {
    expect(() => assertRemoteWorkerWindowsObservationSafe(observation())).not.toThrow();
    expect(() =>
      assertRemoteWorkerWindowsObservationSafe(observation({ attributes: 0x420, reparseTag: 0xa000000c })),
    ).toThrow("reparse-backed");
    expect(() => assertRemoteWorkerWindowsObservationSafe(observation({ linkCount: 2 }))).toThrow("linked");
    expect(() =>
      assertRemoteWorkerWindowsObservationSafe(observation({ streams: ["::$DATA", ":hidden:$DATA"] })),
    ).toThrow("alternate stream");
    expect(() =>
      assertRemoteWorkerWindowsObservationSafe(
        observation({
          sddl: "O:S-1-5-21-1-2-3-1001D:P(A;;FA;;;S-1-5-21-1-2-3-1001)(A;;FW;;;BU)",
        }),
      ),
    ).toThrow("non-operator writes");
  });

  it.each([
    "O:S-1-5-21-1-2-3-1001D:P(XA;;FW;;;BU)",
    "O:S-1-5-21-1-2-3-1001D:P(ZA;;FW;;;BU)",
    "O:S-1-5-21-1-2-3-1001D:P(XA;;FW;;;BU;(@User.Member_of{SID(S-1-5-32-544)}))",
    "O:S-1-5-21-1-2-3-1001D:P(A;;FW;;BU)",
    "O:S-1-5-21-1-2-3-1001D:P(A;OIlD;FW;;;BU)",
    "O:S-1-5-21-1-2-3-1001D:P(A;;FW;;;sy)",
    "O:S-1-5-21-1-2-3-1001D:P(A;;ZZ;;;BU)",
  ])("fails closed for callback, conditional, malformed, or non-canonical ACE %s", (sddl) => {
    expect(() => assertRemoteWorkerWindowsObservationSafe(observation({ sddl }))).toThrow("Windows ACL");
  });

  it("treats object allows as grants and admits write only for the frozen trusted SID set", () => {
    const guid = "00112233-4455-6677-8899-aabbccddeeff";
    expect(() =>
      assertRemoteWorkerWindowsObservationSafe(observation({ sddl: `O:S-1-5-21-1-2-3-1001D:P(OA;;FW;${guid};;BU)` })),
    ).toThrow("non-operator writes");
    expect(() =>
      assertRemoteWorkerWindowsObservationSafe(
        observation({ sddl: `O:S-1-5-21-1-2-3-1001D:P(OA;OICI;FW;${guid};;BA)` }),
      ),
    ).not.toThrow();
  });

  it.runIf(process.platform === "win32")(
    "scans a real fixed-role tree through native relative handles and emits normalized attestation",
    async () => {
      const root = await validTree();
      const scanner = new RemoteWorkerInstalledTreeScanner(MANIFEST_SHA256, () => new Date(NOW));
      const attestation = await scanner.scan({
        root,
        maxFileCount: 10,
        maxFileBytes: 1_024,
        maxTotalBytes: 10_000,
      });
      expect(attestation.runtimeManifestPayloadSha256).toBe(MANIFEST_SHA256);
      expect(attestation.scannedAt).toBe(NOW.toISOString());
      expect(attestation.files.map((file) => [file.path, file.role])).toEqual([
        ["bundle/worker.js", "bundle"],
        ["launcher/start.cmd", "launcher"],
        ["locks/pnpm-lock.yaml", "dependency_lock"],
        ["runtime/bin/node.exe", "runtime"],
        ["vendor/pkg/index.js", "vendor"],
      ]);
      expect(attestation.files.every((file) => file.beforeStatSha256 === file.afterStatSha256)).toBe(true);
      expect(normalizeInstalledTreeAttestation(attestation, NOW)).toEqual(attestation);
    },
    120_000,
  );

  it.runIf(process.platform === "win32")(
    "hashes a real multi-megabyte installed file through bounded metadata-only native evidence",
    async () => {
      const vendorPayload = Buffer.alloc(2 * 1024 * 1024, 0x56);
      const root = await validTree(vendorPayload);
      const scanner = new RemoteWorkerInstalledTreeScanner(MANIFEST_SHA256, () => new Date(NOW));
      const attestation = await scanner.scan({
        root,
        maxFileCount: 10,
        maxFileBytes: 512 * 1024 * 1024,
        maxTotalBytes: 512 * 1024 * 1024,
      });
      const vendor = attestation.files.find((file) => file.role === "vendor");
      expect(vendor).toMatchObject({
        sizeBytes: vendorPayload.byteLength,
        sha256: createHash("sha256").update(vendorPayload).digest("hex"),
      });
      expect(remoteWorkerWindowsNoFollowHelperDiagnostics().maximumHashResponseBytes).toBe(1024 * 1024);
      vendorPayload.fill(0);
    },
    120_000,
  );

  it.runIf(process.platform === "win32")(
    "enforces one absolute deadline across the tree's many native helper invocations",
    async () => {
      const root = await validTree();
      const scanner = new RemoteWorkerInstalledTreeScanner(MANIFEST_SHA256, () => new Date(NOW));
      const startedAt = Date.now();
      await expect(
        scanner.scan({
          root,
          maxFileCount: 10,
          maxFileBytes: 1_024,
          maxTotalBytes: 10_000,
          deadlineMs: 5_000,
        }),
      ).rejects.toThrow("deadline");
      expect(Date.now() - startedAt).toBeLessThan(12_000);
      expect(remoteWorkerWindowsNoFollowHelperDiagnostics().active).toBe(false);
    },
    30_000,
  );

  it.runIf(process.platform !== "win32")(
    "streams POSIX installed files and enforces the absolute scan deadline",
    async () => {
      const vendorPayload = Buffer.alloc(2 * 1024 * 1024, 0x50);
      const root = await validTree(vendorPayload);
      const scanner = new RemoteWorkerInstalledTreeScanner(MANIFEST_SHA256, () => new Date(NOW));
      const attestation = await scanner.scan({
        root,
        maxFileCount: 10,
        maxFileBytes: vendorPayload.byteLength,
        maxTotalBytes: vendorPayload.byteLength + 1_024,
      });
      expect(attestation.files.find((file) => file.role === "vendor")?.sha256).toBe(
        createHash("sha256").update(vendorPayload).digest("hex"),
      );
      await expect(
        scanner.scan({
          root,
          maxFileCount: 10,
          maxFileBytes: vendorPayload.byteLength,
          maxTotalBytes: vendorPayload.byteLength + 1_024,
          deadlineMs: 1,
        }),
      ).rejects.toThrow("deadline");
      vendorPayload.fill(0);
    },
    60_000,
  );

  it("kills a hanging POSIX scan helper, remains poisoned until close, and permits a later scan", async () => {
    let overlap: Promise<void> | undefined;
    let hangingPid: number | undefined;
    const startedAt = performance.now();
    const hanging = exerciseRemoteWorkerPosixScanHelperForTesting({
      behavior: "hang",
      deadlineMs: 1_500,
      onTerminationRequested: () => {
        const diagnostics = remoteWorkerPosixScanHelperDiagnostics();
        expect(diagnostics.active).toBe(true);
        expect(diagnostics.receivedResponseBytes).toBeGreaterThan(4);
        hangingPid = diagnostics.activePid;
        overlap = exerciseRemoteWorkerPosixScanHelperForTesting({ behavior: "success", deadlineMs: 5_000 });
        void overlap.catch(() => undefined);
      },
    });

    await expect(hanging).rejects.toThrow("deadline");
    expect(performance.now() - startedAt).toBeLessThan(4_000);
    await expect(overlap).rejects.toThrow("already active");
    expect(remoteWorkerPosixScanHelperDiagnostics()).toMatchObject({
      active: false,
      activePid: undefined,
      receivedResponseBytes: 0,
    });
    expect(hangingPid).toBeTypeOf("number");
    expect(processExists(hangingPid as number)).toBe(false);
    await expect(
      exerciseRemoteWorkerPosixScanHelperForTesting({ behavior: "success", deadlineMs: 5_000 }),
    ).resolves.toBeUndefined();
  }, 15_000);

  it("kills and closes the POSIX scan helper before rejecting an abort", async () => {
    const controller = new AbortController();
    let abortedPid: number | undefined;
    const hanging = exerciseRemoteWorkerPosixScanHelperForTesting({
      behavior: "hang",
      deadlineMs: 10_000,
      signal: controller.signal,
      onTerminationRequested: () => {
        abortedPid = remoteWorkerPosixScanHelperDiagnostics().activePid;
      },
    });
    await vi.waitFor(() => expect(remoteWorkerPosixScanHelperDiagnostics().receivedResponseBytes).toBeGreaterThan(4), {
      timeout: 5_000,
    });
    controller.abort();

    await expect(hanging).rejects.toThrow("aborted");
    expect(remoteWorkerPosixScanHelperDiagnostics()).toMatchObject({
      active: false,
      activePid: undefined,
      receivedResponseBytes: 0,
    });
    expect(abortedPid).toBeTypeOf("number");
    expect(processExists(abortedPid as number)).toBe(false);
  }, 15_000);

  it.runIf(process.platform === "win32")(
    "rejects root files and unknown role directories before hashing",
    async () => {
      const root = await validTree();
      await writeFile(join(root, "unexpected.txt"), "no");
      const scanner = new RemoteWorkerInstalledTreeScanner(MANIFEST_SHA256, () => new Date(NOW));
      await expect(
        scanner.scan({ root, maxFileCount: 10, maxFileBytes: 1_024, maxTotalBytes: 10_000 }),
      ).rejects.toThrow("root layout");
    },
    60_000,
  );

  it("rejects invalid caps and never includes an operator root in bounded errors", async () => {
    const secretRoot = "operator-private-root-token";
    const scanner = new RemoteWorkerInstalledTreeScanner(MANIFEST_SHA256);
    let caught: unknown;
    try {
      await scanner.scan({ root: secretRoot, maxFileCount: 0, maxFileBytes: 1, maxTotalBytes: 1 });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).not.toContain(secretRoot);
    expect(String(caught)).toContain("file count limit");
  });
});
