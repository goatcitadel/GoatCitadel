import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enumerateRemoteWorkerWindowsDirectory,
  hashRemoteWorkerWindowsFile,
  readRemoteWorkerWindowsFile,
  remoteWorkerWindowsNoFollowHelperDiagnostics,
  validateRemoteWorkerWindowsNoFollowResponse,
} from "./remote-worker-windows-no-follow.js";

const ROOT = "C:\\GoatCitadel\\worker";
const cleanupRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ownerSid: "S-1-5-21-1-2-3-1001",
    sddl: "O:S-1-5-21-1-2-3-1001D:P(A;;FR;;;SY)(A;;FR;;;BA)",
    streams: ["::$DATA"],
    ...overrides,
  };
}

function enumerateResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "goatcitadel.remote-worker-windows-no-follow.v1",
    operation: "enumerate",
    operatorSid: "S-1-5-21-1-2-3-1001",
    rootPath: ROOT,
    relativePath: "vendor",
    rootBefore: observation({ attributes: 0x10, sizeBytes: 0 }),
    rootAfter: observation({ attributes: 0x10, sizeBytes: 0 }),
    directoryBefore: observation({ attributes: 0x10, sizeBytes: 0 }),
    directoryAfter: observation({ attributes: 0x10, sizeBytes: 0 }),
    firstNames: ["a.js"],
    secondNames: ["a.js"],
    entries: [{ name: "a.js", kind: "regular_file", observation: observation() }],
    ...overrides,
  };
}

function readResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "goatcitadel.remote-worker-windows-no-follow.v1",
    operation: "read_file",
    operatorSid: "S-1-5-21-1-2-3-1001",
    rootPath: ROOT,
    relativePath: "vendor/a.js",
    before: observation(),
    after: observation(),
    ancestorsBefore: [observation({ attributes: 0x10, sizeBytes: 0 })],
    ancestorsAfter: [observation({ attributes: 0x10, sizeBytes: 0 })],
    contentBase64: Buffer.from("abc").toString("base64"),
    ...overrides,
  };
}

function hashResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "goatcitadel.remote-worker-windows-no-follow.v1",
    operation: "hash_file",
    operatorSid: "S-1-5-21-1-2-3-1001",
    rootPath: ROOT,
    relativePath: "vendor/a.js",
    before: observation(),
    after: observation(),
    ancestorsBefore: [observation({ attributes: 0x10, sizeBytes: 0 })],
    ancestorsAfter: [observation({ attributes: 0x10, sizeBytes: 0 })],
    sizeBytes: 3,
    sha256: createHash("sha256").update("abc", "utf8").digest("hex"),
    ...overrides,
  };
}

describe("remote worker Windows no-follow protocol", () => {
  it("accepts only exact request-bound, double-enumerated handle evidence", () => {
    const evidence = validateRemoteWorkerWindowsNoFollowResponse(enumerateResponse(), {
      operation: "enumerate",
      rootPath: ROOT,
      relativePath: "vendor",
    });
    expect(evidence).toMatchObject({ rootPath: ROOT, relativeDirectory: "vendor" });
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it("rejects enumeration drift, unknown fields, getters, and non-canonical ordering", () => {
    expect(() =>
      validateRemoteWorkerWindowsNoFollowResponse(enumerateResponse({ secondNames: ["b.js"] }), {
        operation: "enumerate",
        rootPath: ROOT,
        relativePath: "vendor",
      }),
    ).toThrow("enumeration changed");
    expect(() =>
      validateRemoteWorkerWindowsNoFollowResponse(enumerateResponse({ unexpected: true }), {
        operation: "enumerate",
        rootPath: ROOT,
        relativePath: "vendor",
      }),
    ).toThrow("missing or unknown");
    const getter = enumerateResponse();
    Object.defineProperty(getter, "rootPath", { enumerable: true, get: () => ROOT });
    expect(() =>
      validateRemoteWorkerWindowsNoFollowResponse(getter, {
        operation: "enumerate",
        rootPath: ROOT,
        relativePath: "vendor",
      }),
    ).toThrow("plain data");
    expect(() =>
      validateRemoteWorkerWindowsNoFollowResponse(
        enumerateResponse({ firstNames: ["z.js", "a.js"], secondNames: ["z.js", "a.js"] }),
        { operation: "enumerate", rootPath: ROOT, relativePath: "vendor" },
      ),
    ).toThrow("canonical byte order");
  });

  it("binds read bytes to exact path, size, and observation bounds", () => {
    const evidence = validateRemoteWorkerWindowsNoFollowResponse(readResponse(), {
      operation: "read_file",
      rootPath: ROOT,
      relativePath: "vendor/a.js",
      maxBytes: 3,
    });
    expect(evidence).toMatchObject({ relativePath: "vendor/a.js", content: Buffer.from("abc") });
    expect(() =>
      validateRemoteWorkerWindowsNoFollowResponse(readResponse(), {
        operation: "read_file",
        rootPath: ROOT,
        relativePath: "vendor/a.js",
        maxBytes: 2,
      }),
    ).toThrow("byte limit");
    expect(() =>
      validateRemoteWorkerWindowsNoFollowResponse(readResponse({ after: observation({ sizeBytes: 2 }) }), {
        operation: "read_file",
        rootPath: ROOT,
        relativePath: "vendor/a.js",
        maxBytes: 3,
      }),
    ).toThrow("identity changed");
    expect(() =>
      validateRemoteWorkerWindowsNoFollowResponse(
        readResponse({ before: observation({ sizeBytes: 2 }), after: observation({ sizeBytes: 2 }) }),
        {
          operation: "read_file",
          rootPath: ROOT,
          relativePath: "vendor/a.js",
          maxBytes: 3,
        },
      ),
    ).toThrow("size changed");
  });

  it("binds contentless hash evidence to retained before/after identity", () => {
    const evidence = validateRemoteWorkerWindowsNoFollowResponse(hashResponse(), {
      operation: "hash_file",
      rootPath: ROOT,
      relativePath: "vendor/a.js",
      maxBytes: 512 * 1024 * 1024,
    });
    expect(evidence).toMatchObject({
      relativePath: "vendor/a.js",
      sizeBytes: 3,
      sha256: createHash("sha256").update("abc", "utf8").digest("hex"),
    });
    expect(evidence).not.toHaveProperty("content");
    expect(() =>
      validateRemoteWorkerWindowsNoFollowResponse(hashResponse({ after: observation({ changeTime: "1" }) }), {
        operation: "hash_file",
        rootPath: ROOT,
        relativePath: "vendor/a.js",
        maxBytes: 3,
      }),
    ).toThrow("identity changed");
  });

  it.each([
    "\\\\server\\share\\worker",
    "\\\\?\\C:\\worker",
    "\\\\.\\C:\\worker",
    "C:\\worker:stream",
    "C:\\worker\\",
    "c:\\worker",
    "C:/worker",
  ])("rejects non-canonical, device, UNC, or ADS root %s", (rootPath) => {
    expect(() =>
      validateRemoteWorkerWindowsNoFollowResponse(enumerateResponse({ rootPath }), {
        operation: "enumerate",
        rootPath,
        relativePath: "vendor",
      }),
    ).toThrow("canonical local-drive path");
  });

  it.each(["CON", "aux.txt", "thing. ", "thing.", "thing:ads", "../outside", "vendor\\file"])(
    "rejects the Windows alias segment %s",
    (relativePath) => {
      expect(() =>
        validateRemoteWorkerWindowsNoFollowResponse(enumerateResponse({ relativePath }), {
          operation: "enumerate",
          rootPath: ROOT,
          relativePath,
        }),
      ).toThrow("path");
    },
  );

  it("exposes only fixed-host, secret-free helper diagnostics", () => {
    const diagnostics = remoteWorkerWindowsNoFollowHelperDiagnostics();
    expect(diagnostics).toMatchObject({
      executableKind: "system32_windows_powershell",
      relativeHandleWalker: true,
      maximumContentFileBytes: 1024 * 1024,
      maximumHashFileBytes: 512 * 1024 * 1024,
      maximumHashResponseBytes: 1024 * 1024,
      maximumProtocolResponseBytes: 16 * 1024 * 1024,
      nativeFixedVolumeRootOnly: true,
    });
    expect(JSON.stringify(diagnostics)).not.toContain(ROOT);
    expect(JSON.stringify(diagnostics)).not.toContain("powershell.exe");
  });

  it("cannot route the installed-tree 512 MiB cap through proportional content stdout", async () => {
    await expect(readRemoteWorkerWindowsFile(ROOT, "vendor/a.js", 512 * 1024 * 1024)).rejects.toThrow(
      "content file byte limit",
    );
    const diagnostics = remoteWorkerWindowsNoFollowHelperDiagnostics();
    expect(diagnostics.maximumHashResponseBytes).toBeLessThan(diagnostics.maximumHashFileBytes / 100);
  });

  it.runIf(process.platform === "win32")(
    "rejects SUBST aliases instead of treating them as native fixed-volume roots",
    async () => {
      const drive = [..."ZYXWVUTSRQPONMLK"]
        .map((letter) => `${letter}:`)
        .find((candidate) => !existsSync(`${candidate}\\`));
      if (drive === undefined) return;
      const root = await mkdtemp(join(tmpdir(), "goat-worker-no-follow-subst-"));
      cleanupRoots.push(root);
      await mkdir(join(root, "worker"));
      await writeFile(join(root, "worker", "payload.bin"), Buffer.from("abc"));
      const subst = join(process.env.SystemRoot as string, "System32", "subst.exe");
      await execFileAsync(subst, [drive, root]);
      try {
        await expect(
          enumerateRemoteWorkerWindowsDirectory(`${drive}\\worker`, "", { deadlineMs: 30_000 }),
        ).rejects.toThrow("inspection failed");
      } finally {
        await execFileAsync(subst, [drive, "/D"]);
      }
    },
    60_000,
  );

  it.runIf(process.platform === "win32")(
    "round-trips a real file through relative native handles",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "goat-worker-no-follow-"));
      cleanupRoots.push(root);
      await writeFile(join(root, "payload.bin"), Buffer.from("abc"));
      const listing = await enumerateRemoteWorkerWindowsDirectory(root, "", { deadlineMs: 30_000 });
      expect(listing.firstNames).toEqual(["payload.bin"]);
      expect(listing.entries[0]).toMatchObject({ name: "payload.bin", kind: "regular_file" });
      const file = await readRemoteWorkerWindowsFile(root, "payload.bin", 3, { deadlineMs: 30_000 });
      expect(file.content).toEqual(Buffer.from("abc"));
      expect(file.before).toEqual(file.after);
    },
    60_000,
  );

  it.runIf(process.platform === "win32")(
    "hashes a real multi-megabyte file without returning content and preserves the bounded trust read frame",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "goat-worker-no-follow-hash-"));
      cleanupRoots.push(root);
      const bulkBytes = 64 * 1024 * 1024;
      const bulkPath = join(root, "bulk.bin");
      const bulkHandle = await open(bulkPath, "w");
      await bulkHandle.truncate(bulkBytes);
      await bulkHandle.close();
      const trust = Buffer.alloc(1024 * 1024, 0x41);
      await writeFile(join(root, "trust.bin"), trust);
      const expectedBulkHash = createHash("sha256");
      const zeroChunk = Buffer.alloc(64 * 1024);
      for (let remaining = bulkBytes; remaining > 0; remaining -= zeroChunk.byteLength)
        expectedBulkHash.update(zeroChunk);
      const hashed = await hashRemoteWorkerWindowsFile(root, "bulk.bin", 512 * 1024 * 1024, {
        deadlineMs: 30_000,
      });
      expect(hashed.sizeBytes).toBe(bulkBytes);
      expect(hashed.sha256).toBe(expectedBulkHash.digest("hex"));
      expect(hashed.before).toEqual(hashed.after);
      expect(hashed).not.toHaveProperty("content");

      const read = await readRemoteWorkerWindowsFile(root, "trust.bin", trust.byteLength, { deadlineMs: 30_000 });
      expect(read.content).toEqual(trust);
      read.content.fill(0);
      zeroChunk.fill(0);
      trust.fill(0);
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
    "reports real hardlink, ADS, and junction evidence for fail-closed policy",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "goat-worker-no-follow-negative-"));
      cleanupRoots.push(root);
      const payload = join(root, "payload.bin");
      await writeFile(payload, Buffer.from("abc"));
      await link(payload, join(root, "alias.bin"));
      await writeFile(`${payload}:hidden`, Buffer.from("secret"));
      await mkdir(join(root, "target"));
      await symlink(join(root, "target"), join(root, "junction"), "junction");
      const listing = await enumerateRemoteWorkerWindowsDirectory(root, "", { deadlineMs: 30_000 });
      const byName = new Map(listing.entries.map((entry) => [entry.name, entry]));
      expect(byName.get("payload.bin")?.observation.linkCount).toBe(2);
      expect(byName.get("alias.bin")?.observation.linkCount).toBe(2);
      expect(byName.get("payload.bin")?.observation.streams).toContain(":hidden:$DATA");
      expect(byName.get("junction")?.kind).toBe("reparse");
      expect(byName.get("junction")?.observation.reparseTag).not.toBe(0);
    },
    60_000,
  );

  it.runIf(process.platform === "win32")(
    "keeps the singleton lease poisoned until an aborted helper actually closes",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "goat-worker-no-follow-abort-"));
      cleanupRoots.push(root);
      await writeFile(join(root, "payload.bin"), Buffer.from("abc"));
      const controller = new AbortController();
      const first = enumerateRemoteWorkerWindowsDirectory(root, "", {
        signal: controller.signal,
        deadlineMs: 30_000,
      });
      controller.abort();
      const overlapping = enumerateRemoteWorkerWindowsDirectory(root, "", { deadlineMs: 30_000 });
      await expect(overlapping).rejects.toThrow("already active");
      await expect(first).rejects.toThrow("aborted");
      await vi.waitFor(() => expect(remoteWorkerWindowsNoFollowHelperDiagnostics().active).toBe(false), {
        timeout: 10_000,
        interval: 25,
      });
    },
    30_000,
  );
});
