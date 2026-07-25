import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EXTERNAL_SOURCE_LIMITS } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExternalSourceArtifactStore,
  ExternalSourceArtifactStoreError,
  NodeExternalSourceArtifactFilesystem,
  externalSourceArtifactRelPath,
  type ExternalSourceArtifactFileHandle,
} from "./external-source-artifact-store.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ExternalSourceArtifactStore", () => {
  it("publishes, fsyncs, reads, and verifies the exact immutable CAS address", async () => {
    const root = await temporaryRoot();
    const filesystem = new TrackingArtifactFilesystem();
    const store = new ExternalSourceArtifactStore(path.join(root, "managed"), {
      filesystem,
      randomToken: () => "token-one",
    });
    const content = bytes("normalized-fixture");
    const expectedSha256 = digest(content);

    const published = await store.publish({ bytes: content, expectedSha256, signal: freshSignal() });
    expect(published).toEqual({
      artifactRelPath: `external-sources/sha256/${expectedSha256}`,
      artifactSha256: expectedSha256,
      byteCount: content.byteLength,
      reused: false,
    });
    const read = await store.read({
      artifactRelPath: published.artifactRelPath,
      expectedSha256,
      signal: freshSignal(),
    });
    expect(read.bytes).toEqual(content);
    await expect(
      store.verify({ artifactRelPath: published.artifactRelPath, expectedSha256, signal: freshSignal() }),
    ).resolves.toBe(true);
    expect(filesystem.fileSyncCount).toBe(1);
    expect(filesystem.directorySyncCount).toBe(1);
    expect(filesystem.chmodCalls).toContainEqual([store.resolveArtifactPath(published.artifactRelPath), 0o600]);
    const hardeningCallsBeforeReplay = filesystem.chmodCalls.filter(
      ([absolutePath, mode]) => absolutePath === store.resolveArtifactPath(published.artifactRelPath) && mode === 0o600,
    ).length;
    await expect(store.publish({ bytes: content, expectedSha256, signal: freshSignal() })).resolves.toMatchObject({
      reused: true,
    });
    expect(
      filesystem.chmodCalls.filter(
        ([absolutePath, mode]) =>
          absolutePath === store.resolveArtifactPath(published.artifactRelPath) && mode === 0o600,
      ),
    ).toHaveLength(hardeningCallsBeforeReplay + 1);

    if (process.platform !== "win32") {
      const stat = await fs.stat(store.resolveArtifactPath(published.artifactRelPath));
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("converges concurrent and repeated same-hash publications without replacement", async () => {
    const root = await temporaryRoot();
    let token = 0;
    const store = new ExternalSourceArtifactStore(path.join(root, "managed"), {
      filesystem: new TestArtifactFilesystem(),
      randomToken: () => `token-${(token += 1)}`,
    });
    const content = bytes("same-hash-fixture");
    const expectedSha256 = digest(content);

    const concurrent = await Promise.all([
      store.publish({ bytes: content, expectedSha256, signal: freshSignal() }),
      store.publish({ bytes: content, expectedSha256, signal: freshSignal() }),
    ]);
    expect(concurrent.filter((result) => result.reused)).toHaveLength(1);
    await expect(store.publish({ bytes: content, expectedSha256, signal: freshSignal() })).resolves.toMatchObject({
      reused: true,
    });
    await expect(
      fs.readFile(store.resolveArtifactPath(externalSourceArtifactRelPath(expectedSha256))),
    ).resolves.toEqual(Buffer.from(content));
    const parent = path.dirname(store.resolveArtifactPath(externalSourceArtifactRelPath(expectedSha256)));
    await expect(fs.readdir(parent)).resolves.toEqual([expectedSha256]);
  });

  it("rejects same-address tampering and never overwrites the CAS object", async () => {
    const root = await temporaryRoot();
    const store = new ExternalSourceArtifactStore(path.join(root, "managed"), {
      filesystem: new TestArtifactFilesystem(),
    });
    const content = bytes("original-fixture");
    const expectedSha256 = digest(content);
    const published = await store.publish({ bytes: content, expectedSha256, signal: freshSignal() });
    const artifactPath = store.resolveArtifactPath(published.artifactRelPath);
    await fs.writeFile(artifactPath, bytes("tampered-fixture"));

    await expectCode(
      store.verify({ artifactRelPath: published.artifactRelPath, expectedSha256, signal: freshSignal() }),
      "tampered",
    );
    await expectCode(store.publish({ bytes: content, expectedSha256, signal: freshSignal() }), "tampered");
    await expect(fs.readFile(artifactPath, "utf8")).resolves.toBe("tampered-fixture");
    await expect(fs.readdir(path.dirname(artifactPath))).resolves.toEqual([expectedSha256]);
  });

  it("enforces the normalized artifact cap and digest before creating managed paths", async () => {
    const root = await temporaryRoot();
    const managed = path.join(root, "managed");
    const store = new ExternalSourceArtifactStore(managed);
    const oversized = new Uint8Array(EXTERNAL_SOURCE_LIMITS.normalizedSessionArtifactBytes + 1);
    await expectCode(
      store.publish({ bytes: oversized, expectedSha256: digest(oversized), signal: freshSignal() }),
      "limit_exceeded",
    );
    await expectCode(
      store.publish({
        bytes: bytes("fixture"),
        expectedSha256: digest(bytes("different")),
        signal: freshSignal(),
      }),
      "digest_mismatch",
    );
    await expect(fs.stat(managed)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-canonical addresses and missing artifacts", async () => {
    const root = await temporaryRoot();
    const store = new ExternalSourceArtifactStore(path.join(root, "managed"));
    const expectedSha256 = digest(bytes("missing"));
    expect(() => store.resolveArtifactPath(`external-sources/sha256/../${expectedSha256}`)).toThrow(
      ExternalSourceArtifactStoreError,
    );
    await expect(
      store.verify({
        artifactRelPath: externalSourceArtifactRelPath(expectedSha256),
        expectedSha256,
        signal: freshSignal(),
      }),
    ).resolves.toBe(false);
  });

  it("fails closed when a managed ancestor swaps to a reparse point after staging", async () => {
    const root = await temporaryRoot();
    const filesystem = new SwapAfterStageFilesystem();
    const store = new ExternalSourceArtifactStore(path.join(root, "managed"), {
      filesystem,
      randomToken: () => "swap-token",
    });
    const content = bytes("swap-fixture");
    await expectCode(
      store.publish({ bytes: content, expectedSha256: digest(content), signal: freshSignal() }),
      "unsafe_path",
    );
    expect(filesystem.atomicInstallCount).toBe(0);
  });

  it("fails closed when a managed ancestor is replaced by another safe directory after staging", async () => {
    const root = await temporaryRoot();
    const filesystem = new SafeDirectorySwapAfterStageFilesystem();
    const store = new ExternalSourceArtifactStore(path.join(root, "managed"), {
      filesystem,
      randomToken: () => "safe-swap-token",
    });
    const content = bytes("safe-swap-fixture");
    await expectCode(
      store.publish({ bytes: content, expectedSha256: digest(content), signal: freshSignal() }),
      "unsafe_path",
    );
    expect(filesystem.atomicInstallCount).toBe(0);
  });

  it("cleans staging on install failure and on a link-success/unlink-error convergence", async () => {
    for (const filesystem of [new FailBeforeInstallFilesystem(), new FailAfterLinkFilesystem()]) {
      const root = await temporaryRoot();
      const store = new ExternalSourceArtifactStore(path.join(root, "managed"), {
        filesystem,
        randomToken: () => "cleanup-token",
      });
      const content = bytes("cleanup-fixture");
      const expectedSha256 = digest(content);
      if (filesystem instanceof FailBeforeInstallFilesystem) {
        await expectCode(store.publish({ bytes: content, expectedSha256, signal: freshSignal() }), "filesystem_error");
        const parent = path.join(root, "managed", "external-sources", "sha256");
        await expect(fs.readdir(parent)).resolves.toEqual([]);
      } else {
        await expect(store.publish({ bytes: content, expectedSha256, signal: freshSignal() })).resolves.toMatchObject({
          reused: true,
        });
        const parent = path.dirname(store.resolveArtifactPath(externalSourceArtifactRelPath(expectedSha256)));
        await expect(fs.readdir(parent)).resolves.toEqual([expectedSha256]);
      }
    }
  });

  it("rejects a real Windows junction in the server-owned store ancestry", async () => {
    if (process.platform !== "win32") return;
    const root = await temporaryRoot();
    const target = path.join(root, "target");
    const junction = path.join(root, "junction");
    await fs.mkdir(target);
    await fs.symlink(target, junction, "junction");
    const store = new ExternalSourceArtifactStore(path.join(junction, "managed"));
    const content = bytes("junction-fixture");
    await expectCode(
      store.publish({ bytes: content, expectedSha256: digest(content), signal: freshSignal() }),
      "unsafe_path",
    );
  });

  it("honors required cancellation without publishing an object", async () => {
    const root = await temporaryRoot();
    const store = new ExternalSourceArtifactStore(path.join(root, "managed"));
    const controller = new AbortController();
    controller.abort();
    const content = bytes("cancelled-fixture");
    await expectCode(
      store.publish({ bytes: content, expectedSha256: digest(content), signal: controller.signal }),
      "cancelled",
    );
  });

  it("fails closed when the filesystem cannot enforce owner-only permissions", async () => {
    const root = await temporaryRoot();
    const managed = path.join(root, "managed");
    const filesystem = new UnsupportedPermissionsFilesystem();
    const store = new ExternalSourceArtifactStore(managed, { filesystem });
    const content = bytes("owner-only-required-fixture");

    await expectCode(
      store.publish({ bytes: content, expectedSha256: digest(content), signal: freshSignal() }),
      "filesystem_error",
    );
    await expect(fs.readdir(managed)).resolves.toEqual([]);

    const capableStore = new ExternalSourceArtifactStore(managed, { filesystem: new TestArtifactFilesystem() });
    const published = await capableStore.publish({
      bytes: content,
      expectedSha256: digest(content),
      signal: freshSignal(),
    });
    await expectCode(
      store.read({
        artifactRelPath: published.artifactRelPath,
        expectedSha256: published.artifactSha256,
        signal: freshSignal(),
      }),
      "filesystem_error",
    );
  });

  it("fails closed and leaves no artifact when Windows ACL enforcement or reparse inspection fails", async () => {
    for (const failure of ["acl", "reparse"] as const) {
      const root = await temporaryRoot();
      const managed = path.join(root, `managed-${failure}`);
      const filesystem = new NodeExternalSourceArtifactFilesystem({
        windowsSecurity: {
          inspectReparsePoint: async (absolutePath) => {
            if (failure === "reparse" && absolutePath === managed) return true;
            return false;
          },
          applyOwnerOnlyAcl: async () => {
            if (failure === "acl") throw new Error("synthetic ACL command failure with a secret path");
            return { ownerSid: "S-1-5-18" };
          },
        },
      });
      const store = new ExternalSourceArtifactStore(managed, { filesystem });
      const content = bytes(`windows-${failure}-fixture`);

      await expectCode(
        store.publish({ bytes: content, expectedSha256: digest(content), signal: freshSignal() }),
        failure === "acl" ? "filesystem_error" : "unsafe_path",
      );
      const entries = await fs.readdir(managed).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      expect(entries).toEqual([]);
    }
  });

  it("detects a safe path replacement during owner-only ACL application", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "acl-replacement-fixture.bin");
    const displaced = path.join(root, "acl-replacement-original.bin");
    await fs.writeFile(target, bytes("original"));
    const filesystem = new NodeExternalSourceArtifactFilesystem({
      windowsSecurity: {
        inspectReparsePoint: async () => false,
        applyOwnerOnlyAcl: async (absolutePath) => {
          await fs.rename(absolutePath, displaced);
          await fs.writeFile(absolutePath, bytes("replacement"));
          return { ownerSid: "S-1-5-18" };
        },
      },
    });

    await expectCode(filesystem.chmod(target, 0o600, freshSignal()), "unsafe_path");
  });

  it("serializes concurrent owner-only ACL application for the same path", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "concurrent-acl-fixture.bin");
    await fs.writeFile(target, bytes("fixture"));
    const windowsSecurity = new ConcurrentAclTrackingWindowsSecurity();
    const filesystem = new NodeExternalSourceArtifactFilesystem({ windowsSecurity });

    await Promise.all([filesystem.chmod(target, 0o600, freshSignal()), filesystem.chmod(target, 0o600, freshSignal())]);

    expect(windowsSecurity.maxConcurrentAclCalls).toBe(1);
  });

  it("cleans a staged object even when cancellation arrives after its first write", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const filesystem = new AbortAfterFirstWriteFilesystem(controller);
    const store = new ExternalSourceArtifactStore(path.join(root, "managed"), {
      filesystem,
      randomToken: () => "cancel-cleanup-token",
    });
    const content = bytes("cancel-after-write-fixture");

    await expectCode(
      store.publish({ bytes: content, expectedSha256: digest(content), signal: controller.signal }),
      "cancelled",
    );
    const parent = path.join(root, "managed", "external-sources", "sha256");
    await expect(fs.readdir(parent)).resolves.toEqual([]);
  });
});

class TestArtifactFilesystem extends NodeExternalSourceArtifactFilesystem {
  public override readonly ownerOnlyPermissions = process.platform === "win32" ? "windows_acl" : "posix_mode";
}

class UnsupportedPermissionsFilesystem extends TestArtifactFilesystem {
  public override readonly ownerOnlyPermissions = "unsupported";
}

class SwapAfterStageFilesystem extends TestArtifactFilesystem {
  public swapped = false;
  public atomicInstallCount = 0;

  public override async openExclusive(absolutePath: string, mode: number, signal: AbortSignal) {
    const handle = await super.openExclusive(absolutePath, mode, signal);
    this.swapped = true;
    return handle;
  }

  public override async lstat(absolutePath: string, signal: AbortSignal) {
    const stat = await super.lstat(absolutePath, signal);
    if (this.swapped && absolutePath.endsWith(`${path.sep}external-sources${path.sep}sha256`)) {
      return { ...stat, reparsePoint: true };
    }
    return stat;
  }

  public override async atomicRenameNoReplace(
    sourcePath: string,
    destinationPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.atomicInstallCount += 1;
    return super.atomicRenameNoReplace(sourcePath, destinationPath, signal);
  }
}

class SafeDirectorySwapAfterStageFilesystem extends TestArtifactFilesystem {
  public swapped = false;
  public atomicInstallCount = 0;

  public override async openExclusive(absolutePath: string, mode: number, signal: AbortSignal) {
    const handle = await super.openExclusive(absolutePath, mode, signal);
    this.swapped = true;
    return handle;
  }

  public override async lstat(absolutePath: string, signal: AbortSignal) {
    const stat = await super.lstat(absolutePath, signal);
    if (this.swapped && absolutePath.endsWith(`${path.sep}external-sources${path.sep}sha256`)) {
      return { ...stat, inode: stat.inode + 1n, birthtimeNs: stat.birthtimeNs + 1n };
    }
    return stat;
  }

  public override async atomicRenameNoReplace(
    sourcePath: string,
    destinationPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.atomicInstallCount += 1;
    return super.atomicRenameNoReplace(sourcePath, destinationPath, signal);
  }
}

class TrackingArtifactFilesystem extends TestArtifactFilesystem {
  public readonly chmodCalls: Array<[string, number]> = [];
  public fileSyncCount = 0;
  public directorySyncCount = 0;

  public override async chmod(absolutePath: string, mode: number, signal: AbortSignal): Promise<void> {
    this.chmodCalls.push([absolutePath, mode]);
    return super.chmod(absolutePath, mode, signal);
  }

  public override async openExclusive(
    absolutePath: string,
    mode: number,
    signal: AbortSignal,
  ): Promise<ExternalSourceArtifactFileHandle> {
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
    return super.syncDirectory(absolutePath, signal);
  }
}

class FailBeforeInstallFilesystem extends TestArtifactFilesystem {
  public override async atomicRenameNoReplace(): Promise<void> {
    throw Object.assign(new Error("synthetic install failure"), { code: "EIO" });
  }
}

class FailAfterLinkFilesystem extends TestArtifactFilesystem {
  public override async atomicRenameNoReplace(sourcePath: string, destinationPath: string): Promise<void> {
    await fs.link(sourcePath, destinationPath);
    throw Object.assign(new Error("synthetic unlink failure"), { code: "EIO" });
  }
}

class AbortAfterFirstWriteFilesystem extends TestArtifactFilesystem {
  public constructor(private readonly controller: AbortController) {
    super();
  }

  public override async openExclusive(
    absolutePath: string,
    mode: number,
    signal: AbortSignal,
  ): Promise<ExternalSourceArtifactFileHandle> {
    const handle = await super.openExclusive(absolutePath, mode, signal);
    let aborted = false;
    return {
      ...handle,
      write: async (buffer, offset, length, position, operationSignal) => {
        const written = await handle.write(buffer, offset, length, position, operationSignal);
        if (!aborted) {
          aborted = true;
          this.controller.abort();
        }
        return written;
      },
    };
  }
}

class ConcurrentAclTrackingWindowsSecurity {
  public maxConcurrentAclCalls = 0;
  private activeAclCalls = 0;

  public async inspectReparsePoint(): Promise<boolean> {
    return false;
  }

  public async applyOwnerOnlyAcl(): Promise<{ ownerSid: string }> {
    this.activeAclCalls += 1;
    this.maxConcurrentAclCalls = Math.max(this.maxConcurrentAclCalls, this.activeAclCalls);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    this.activeAclCalls -= 1;
    return { ownerSid: "S-1-5-18" };
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-external-artifact-"));
  temporaryRoots.push(root);
  return root;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

async function expectCode(promise: Promise<unknown>, code: ExternalSourceArtifactStoreError["code"]): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected external source artifact store error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalSourceArtifactStoreError);
    expect((error as ExternalSourceArtifactStoreError).code).toBe(code);
    expect((error as Error).message).not.toMatch(/original-fixture|tampered-fixture|junction-fixture/u);
  }
}
