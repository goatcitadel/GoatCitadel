import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSkillContentIntegrity } from "./skill-content-integrity.js";
import {
  NodeSkillHubArtifactFilesystem,
  SkillHubArtifactStore,
  SkillHubArtifactStoreError,
  type SkillHubArtifactFileHandle,
} from "./skill-hub-artifact-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

class TestArtifactFilesystem extends NodeSkillHubArtifactFilesystem {
  public constructor() {
    super(
      process.platform === "win32"
        ? {
            windowsSecurity: {
              inspectReparsePoint: async () => false,
              applyOwnerOnlyAcl: async () => ({ ownerSid: "S-1-5-21-1" }),
            },
          }
        : {},
    );
  }
}

class TrackingArtifactFilesystem extends TestArtifactFilesystem {
  public readonly chmodModes: number[] = [];
  public fileSyncCount = 0;
  public directorySyncCount = 0;

  public override async chmod(absolutePath: string, mode: number, signal: AbortSignal): Promise<void> {
    this.chmodModes.push(mode);
    await super.chmod(absolutePath, mode, signal);
  }

  public override async openExclusive(
    absolutePath: string,
    mode: number,
    signal: AbortSignal,
  ): Promise<SkillHubArtifactFileHandle> {
    const handle = await super.openExclusive(absolutePath, mode, signal);
    return {
      ...handle,
      sync: async (operationSignal) => {
        this.fileSyncCount += 1;
        await handle.sync(operationSignal);
      },
    };
  }

  public override async syncDirectory(absolutePath: string, signal: AbortSignal): Promise<void> {
    this.directorySyncCount += 1;
    await super.syncDirectory(absolutePath, signal);
  }
}

class ReparseAfterStageFilesystem extends TestArtifactFilesystem {
  public stageCreated = false;
  public renameCount = 0;

  public override async mkdir(absolutePath: string, mode: number, signal: AbortSignal): Promise<void> {
    await super.mkdir(absolutePath, mode, signal);
    if (absolutePath.includes(".staging-")) this.stageCreated = true;
  }

  public override async lstat(absolutePath: string, signal: AbortSignal) {
    const stat = await super.lstat(absolutePath, signal);
    if (this.stageCreated && /^[a-f0-9]{2}$/u.test(path.basename(absolutePath))) {
      return { ...stat, reparsePoint: true };
    }
    return stat;
  }

  public override async renameDirectory(
    sourcePath: string,
    destinationPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.renameCount += 1;
    await super.renameDirectory(sourcePath, destinationPath, signal);
  }
}

class IdentitySwapAfterStageFilesystem extends ReparseAfterStageFilesystem {
  public override async lstat(absolutePath: string, signal: AbortSignal) {
    const stat = await TestArtifactFilesystem.prototype.lstat.call(this, absolutePath, signal);
    if (this.stageCreated && /^[a-f0-9]{2}$/u.test(path.basename(absolutePath))) {
      return { ...stat, inode: stat.inode + 1n, birthtimeNs: stat.birthtimeNs + 1n };
    }
    return stat;
  }
}

class FailStagingPermissionsFilesystem extends TestArtifactFilesystem {
  public override async chmod(absolutePath: string, mode: number, signal: AbortSignal): Promise<void> {
    if (absolutePath.includes(".staging-") && mode === 0o700) {
      throw new Error(`synthetic permission failure: ${absolutePath}`);
    }
    await super.chmod(absolutePath, mode, signal);
  }
}

class ClaimIdentitySwapAfterStageFilesystem extends TestArtifactFilesystem {
  public stageCreated = false;
  public renameCount = 0;

  public override async mkdir(absolutePath: string, mode: number, signal: AbortSignal): Promise<void> {
    await super.mkdir(absolutePath, mode, signal);
    if (absolutePath.includes(".staging-")) this.stageCreated = true;
  }

  public override async lstat(absolutePath: string, signal: AbortSignal) {
    const stat = await super.lstat(absolutePath, signal);
    if (this.stageCreated && absolutePath.endsWith(".claim")) {
      return { ...stat, inode: stat.inode + 1n, birthtimeNs: stat.birthtimeNs + 1n };
    }
    return stat;
  }

  public override async renameDirectory(
    sourcePath: string,
    destinationPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.renameCount += 1;
    await super.renameDirectory(sourcePath, destinationPath, signal);
  }
}

async function expectCode(
  promise: Promise<unknown>,
  code: SkillHubArtifactStoreError["code"],
  secret?: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected Skill Hub artifact error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(SkillHubArtifactStoreError);
    expect((error as SkillHubArtifactStoreError).code).toBe(code);
    if (secret) expect((error as Error).message).not.toContain(secret);
  }
}

async function fixture(): Promise<{ root: string; source: string; storeRoot: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `goatcitadel-hx413-${randomUUID()}-`));
  roots.push(root);
  const source = path.join(root, "source");
  const storeRoot = path.join(root, "store");
  await fs.mkdir(path.join(source, "references"), { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "# Exact skill\n", "utf8");
  await fs.writeFile(path.join(source, "references", "proof.txt"), "proof\n", "utf8");
  await fs.writeFile(path.join(source, "source.json"), '{"generated":true}', "utf8");
  return { root, source, storeRoot };
}

describe("SkillHubArtifactStore", () => {
  it("publishes exact governed bytes once and reuses the verified content address", async () => {
    const { source, storeRoot } = await fixture();
    const expected = await captureSkillContentIntegrity(source);
    const filesystem = new TrackingArtifactFilesystem();
    const store = new SkillHubArtifactStore(storeRoot, { filesystem });

    const first = await store.publishFromDirectory({ sourceDir: source, expectedTreeSha256: expected.treeSha256 });
    expect(first.reused).toBe(false);
    expect(first.manifest).toEqual(expected);
    expect(first.bundleRelPath).toBe(`sha256/${expected.treeSha256.slice(0, 2)}/${expected.treeSha256}`);
    expect(await store.verify(first)).toBe(true);
    await expect(fs.stat(path.join(store.resolveBundlePath(first.bundleRelPath), "source.json"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );

    const replay = await store.publishFromDirectory({ sourceDir: source, expectedTreeSha256: expected.treeSha256 });
    expect(replay).toEqual({ ...first, reused: true });
    expect(filesystem.fileSyncCount).toBeGreaterThanOrEqual(expected.fileCount + 2);
    expect(filesystem.directorySyncCount).toBeGreaterThan(0);
    expect(filesystem.chmodModes).toEqual(expect.arrayContaining([0o600, 0o700]));
  });

  it("converges concurrent publishers on one verified content address", async () => {
    const { source, storeRoot } = await fixture();
    const expected = await captureSkillContentIntegrity(source);
    const store = new SkillHubArtifactStore(storeRoot, { filesystem: new TestArtifactFilesystem() });
    const peerStore = new SkillHubArtifactStore(storeRoot, { filesystem: new TestArtifactFilesystem() });

    const results = await Promise.all([
      store.publishFromDirectory({ sourceDir: source, expectedTreeSha256: expected.treeSha256 }),
      peerStore.publishFromDirectory({ sourceDir: source, expectedTreeSha256: expected.treeSha256 }),
    ]);

    expect(results.map((result) => result.reused).sort()).toEqual([false, true]);
    expect(results[0]?.bundleRelPath).toBe(results[1]?.bundleRelPath);
    expect(await store.verify(results[0]!)).toBe(true);
    const installed = store.resolveBundlePath(results[0]!.bundleRelPath);
    const identity = await fs.stat(installed, { bigint: true });
    await expect(
      store.publishFromDirectory({ sourceDir: source, expectedTreeSha256: expected.treeSha256 }),
    ).resolves.toMatchObject({ reused: true });
    const replayIdentity = await fs.stat(installed, { bigint: true });
    expect(replayIdentity.ino).toBe(identity.ino);
  });

  it("rejects a snapshot tree mismatch before publishing", async () => {
    const { source, storeRoot } = await fixture();
    const store = new SkillHubArtifactStore(storeRoot, { filesystem: new TestArtifactFilesystem() });
    await expect(store.publishFromDirectory({ sourceDir: source, expectedTreeSha256: "f".repeat(64) })).rejects.toThrow(
      SkillHubArtifactStoreError,
    );
  });

  it("detects CAS tampering and never overwrites the conflicting path", async () => {
    const { source, storeRoot } = await fixture();
    const expected = await captureSkillContentIntegrity(source);
    const store = new SkillHubArtifactStore(storeRoot, { filesystem: new TestArtifactFilesystem() });
    const published = await store.publishFromDirectory({
      sourceDir: source,
      expectedTreeSha256: expected.treeSha256,
    });
    const storedSkill = path.join(store.resolveBundlePath(published.bundleRelPath), "SKILL.md");
    await fs.writeFile(storedSkill, "tampered\n", "utf8");

    expect(await store.verify(published)).toBe(false);
    await expect(
      store.publishFromDirectory({ sourceDir: source, expectedTreeSha256: expected.treeSha256 }),
    ).rejects.toThrow(SkillHubArtifactStoreError);
    await expect(fs.readFile(storedSkill, "utf8")).resolves.toBe("tampered\n");
  });

  it("rejects non-canonical or escaping bundle paths", async () => {
    const { source, storeRoot } = await fixture();
    const store = new SkillHubArtifactStore(storeRoot);
    expect(() => store.resolveBundlePath("../escape")).toThrow();
    expect(() => store.resolveBundlePath(`sha256/ff/${"a".repeat(64)}`)).toThrow(SkillHubArtifactStoreError);

    const expected = await captureSkillContentIntegrity(source);
    const unsafeManifest = {
      ...expected,
      files: expected.files
        .map((file, index) => (index === 0 ? { ...file, path: "CON.txt" } : file))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
    await expect(
      store.verify({
        bundleRelPath: `sha256/${expected.treeSha256.slice(0, 2)}/${expected.treeSha256}`,
        manifest: unsafeManifest,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a symlinked managed prefix before publishing outside the store", async () => {
    const { root, source, storeRoot } = await fixture();
    const outside = path.join(root, "outside");
    await fs.mkdir(storeRoot, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    try {
      await fs.symlink(outside, path.join(storeRoot, "sha256"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const expected = await captureSkillContentIntegrity(source);
    const store = new SkillHubArtifactStore(storeRoot, { filesystem: new TestArtifactFilesystem() });
    await expect(
      store.publishFromDirectory({ sourceDir: source, expectedTreeSha256: expected.treeSha256 }),
    ).rejects.toThrow(SkillHubArtifactStoreError);
    await expect(
      store.verify({
        bundleRelPath: `sha256/${expected.treeSha256.slice(0, 2)}/${expected.treeSha256}`,
        manifest: expected,
      }),
    ).resolves.toBe(false);
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("fails closed when the final hash prefix is swapped at the rename boundary", async () => {
    const { root, source, storeRoot } = await fixture();
    const outside = path.join(root, "outside-rename-swap");
    const probe = path.join(root, "junction-probe");
    await fs.mkdir(outside, { recursive: true });
    try {
      await fs.symlink(outside, probe, process.platform === "win32" ? "junction" : "dir");
      await fs.rm(probe, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const expected = await captureSkillContentIntegrity(source);
    const store = new SkillHubArtifactStore(storeRoot, { filesystem: new TestArtifactFilesystem() });
    const prefixDir = path.join(storeRoot, "sha256", expected.treeSha256.slice(0, 2));
    const displacedPrefix = `${prefixDir}-displaced`;
    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      await realRename(prefixDir, displacedPrefix);
      await fs.symlink(outside, prefixDir, process.platform === "win32" ? "junction" : "dir");
      return realRename(from, to);
    });
    try {
      await expect(
        store.publishFromDirectory({ sourceDir: source, expectedTreeSha256: expected.treeSha256 }),
      ).rejects.toThrow();
    } finally {
      renameSpy.mockRestore();
    }

    await expect(fs.readdir(outside)).resolves.toEqual([]);
    await expect(
      store.verify({
        bundleRelPath: `sha256/${expected.treeSha256.slice(0, 2)}/${expected.treeSha256}`,
        manifest: expected,
      }),
    ).resolves.toBe(false);
    const displacedEntries = await fs.readdir(displacedPrefix);
    expect(displacedEntries.some((entry) => entry.includes(".staging-"))).toBe(true);
  });

  it("rejects native reparse, ancestor identity, and claim ownership swaps before installation", async () => {
    for (const filesystem of [
      new ReparseAfterStageFilesystem(),
      new IdentitySwapAfterStageFilesystem(),
      new ClaimIdentitySwapAfterStageFilesystem(),
    ]) {
      const { source, storeRoot } = await fixture();
      const expected = await captureSkillContentIntegrity(source);
      const store = new SkillHubArtifactStore(storeRoot, { filesystem });

      await expectCode(
        store.publishFromDirectory({ sourceDir: source, expectedTreeSha256: expected.treeSha256 }),
        "unsafe_path",
      );
      expect(filesystem.renameCount).toBe(0);
    }
  });

  it("fails closed on owner-only permission enforcement failure and removes its owned staging tree", async () => {
    const { source, storeRoot } = await fixture();
    const expected = await captureSkillContentIntegrity(source);
    const store = new SkillHubArtifactStore(storeRoot, { filesystem: new FailStagingPermissionsFilesystem() });

    await expectCode(
      store.publishFromDirectory({ sourceDir: source, expectedTreeSha256: expected.treeSha256 }),
      "filesystem_error",
      storeRoot,
    );
    const prefix = path.join(storeRoot, "sha256", expected.treeSha256.slice(0, 2));
    await expect(fs.readdir(prefix)).resolves.toEqual([]);
  });

  it("recovers an exact directory installed before settlement without replacing its identity", async () => {
    const { source, storeRoot } = await fixture();
    const expected = await captureSkillContentIntegrity(source);
    const crashing = new SkillHubArtifactStore(storeRoot, {
      filesystem: new TestArtifactFilesystem(),
      hooks: {
        afterDirectoryInstall: () => {
          throw new Error(`synthetic crash after install: ${source}`);
        },
      },
    });

    await expectCode(
      crashing.publishFromDirectory({ sourceDir: source, expectedTreeSha256: expected.treeSha256 }),
      "filesystem_error",
      source,
    );
    const bundleRelPath = `sha256/${expected.treeSha256.slice(0, 2)}/${expected.treeSha256}`;
    const finalDir = crashing.resolveBundlePath(bundleRelPath);
    const installedIdentity = await fs.stat(finalDir, { bigint: true });

    const recovering = new SkillHubArtifactStore(storeRoot, { filesystem: new TestArtifactFilesystem() });
    await expect(
      recovering.publishFromDirectory({ sourceDir: source, expectedTreeSha256: expected.treeSha256 }),
    ).resolves.toMatchObject({ reused: true, bundleRelPath });
    expect((await fs.stat(finalDir, { bigint: true })).ino).toBe(installedIdentity.ino);
    await expect(recovering.verify({ bundleRelPath, manifest: expected })).resolves.toBe(true);
    const prefixEntries = await fs.readdir(path.dirname(finalDir));
    expect(prefixEntries.some((entry) => entry.endsWith(".claim") || entry.includes(".staging-"))).toBe(false);
  });

  it("takes over a stale pre-install claim and settles the exact content address", async () => {
    const { source, storeRoot } = await fixture();
    const expected = await captureSkillContentIntegrity(source);
    const prefix = path.join(storeRoot, "sha256", expected.treeSha256.slice(0, 2));
    const claimPath = path.join(prefix, `.${expected.treeSha256}.claim`);
    const staleStaging = path.join(prefix, `.${expected.treeSha256}.staging-crashed`);
    await fs.mkdir(prefix, { recursive: true });
    await fs.writeFile(claimPath, "crashed-owner\n", "utf8");
    await fs.mkdir(staleStaging);
    await fs.writeFile(path.join(staleStaging, "partial.bin"), "partial", "utf8");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(claimPath, old, old);

    const store = new SkillHubArtifactStore(storeRoot, {
      filesystem: new TestArtifactFilesystem(),
      claimStaleMs: 1,
    });
    const published = await store.publishFromDirectory({
      sourceDir: source,
      expectedTreeSha256: expected.treeSha256,
    });

    expect(published.reused).toBe(false);
    await expect(store.verify(published)).resolves.toBe(true);
    await expect(fs.stat(claimPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(staleStaging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects extra or changed bytes and never leaks paths or content through public errors", async () => {
    const { source, storeRoot } = await fixture();
    const expected = await captureSkillContentIntegrity(source);
    const store = new SkillHubArtifactStore(storeRoot, { filesystem: new TestArtifactFilesystem() });
    const published = await store.publishFromDirectory({
      sourceDir: source,
      expectedTreeSha256: expected.treeSha256,
    });
    const finalDir = store.resolveBundlePath(published.bundleRelPath);
    await fs.writeFile(path.join(finalDir, "source.json"), `sensitive payload from ${source}`, "utf8");

    await expect(store.verify(published)).resolves.toBe(false);
    await expectCode(
      store.publishFromDirectory({ sourceDir: source, expectedTreeSha256: expected.treeSha256 }),
      "tampered",
      source,
    );
    await expect(fs.readFile(path.join(finalDir, "source.json"), "utf8")).resolves.toContain("sensitive payload");
  });
});
