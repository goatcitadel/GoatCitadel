import { createHash } from "node:crypto";
import path from "node:path";
import {
  REMOTE_WORKER_SETTLEMENT_BOUNDS,
  remoteWorkerArtifactBlobRelPath,
  remoteWorkerArtifactWorkspaceShard,
} from "@goatcitadel/contracts";
import {
  NodeExternalSourceArtifactFilesystem,
  type ExternalSourceArtifactFilesystem,
} from "./external-source-artifact-store.js";
import { assertWorkerCellPathInJail } from "./remote-worker-cell-filesystem.js";
import type { ExternalSourceFilesystemStat } from "./external-source-reader.js";

/**
 * HX-506 remote-worker artifact store (production-dark).
 *
 * REUSES the external-source CAS algorithms — exclusive owner-only no-follow
 * staging, retained-handle digest read-back, fsync, atomic no-replace
 * installation, same-hash convergence, and fail-closed cleanup — and the HX-505
 * filesystem jail, but the namespace and records are HX-506's. Physical paths
 * are server-derived only:
 *
 *   remote-workers/artifacts/<sha256(workspace)>/sha256/<prefix>/<blobSha256>
 *
 * Worker logical paths never become filesystem paths.
 */

const SHA256 = /^[a-f0-9]{64}$/u;

export type RemoteWorkerArtifactStoreErrorCode =
  | "cancelled"
  | "digest_mismatch"
  | "filesystem_error"
  | "invalid_address"
  | "limit_exceeded"
  | "not_found"
  | "tampered"
  | "unsafe_path";

const ERROR_MESSAGES: Readonly<Record<RemoteWorkerArtifactStoreErrorCode, string>> = Object.freeze({
  cancelled: "Remote worker artifact operation was cancelled.",
  digest_mismatch: "Remote worker artifact digest does not match its immutable address.",
  filesystem_error: "Remote worker artifact filesystem operation failed.",
  invalid_address: "Remote worker artifact address is invalid.",
  limit_exceeded: "Remote worker artifact exceeded a fixed limit.",
  not_found: "Remote worker artifact was not found.",
  tampered: "Remote worker artifact failed immutable verification.",
  unsafe_path: "Remote worker artifact path contains an unsafe filesystem component.",
});

export class RemoteWorkerArtifactStoreError extends Error {
  public constructor(public readonly code: RemoteWorkerArtifactStoreErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RemoteWorkerArtifactStoreError";
  }
}

export interface RemoteWorkerInstalledBlob {
  blobSha256: string;
  physicalRelPath: string;
  byteCount: number;
  reused: boolean;
}

export interface RemoteWorkerArtifactStoreDependencies {
  filesystem?: ExternalSourceArtifactFilesystem;
  randomToken?: () => string;
}

export class RemoteWorkerArtifactStore {
  private readonly rootDir: string;
  private readonly filesystem: ExternalSourceArtifactFilesystem;
  private readonly randomToken: () => string;

  public constructor(rootDir: string, dependencies: RemoteWorkerArtifactStoreDependencies = {}) {
    if (typeof rootDir !== "string" || !rootDir.trim()) {
      throw new TypeError("Remote worker artifact store root is required.");
    }
    this.rootDir = path.resolve(rootDir);
    if (this.rootDir === path.parse(this.rootDir).root) {
      throw new TypeError("Remote worker artifact store cannot use a filesystem root.");
    }
    this.filesystem = dependencies.filesystem ?? new NodeExternalSourceArtifactFilesystem();
    this.randomToken =
      dependencies.randomToken ??
      (() => createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 32));
  }

  /** Server-derived CAS relative path for a blob under a workspace shard. */
  public blobRelPath(executionWorkspaceId: string, blobSha256: string): string {
    return remoteWorkerArtifactBlobRelPath(
      remoteWorkerArtifactWorkspaceShard(executionWorkspaceId),
      assertDigest(blobSha256),
    );
  }

  /**
   * Install artifact bytes at their immutable CAS address, streaming and hashing
   * through a retained handle before atomically installing without replacement.
   * Converges only after full retained-handle verification; fails closed.
   */
  public async installBlob(input: {
    executionWorkspaceId: string;
    blobSha256: string;
    bytes: Uint8Array;
    signal: AbortSignal;
  }): Promise<RemoteWorkerInstalledBlob> {
    assertAbortSignal(input.signal);
    const blobSha256 = assertDigest(input.blobSha256);
    if (!(input.bytes instanceof Uint8Array)) throw new TypeError("Remote worker artifact bytes are required.");
    if (input.bytes.byteLength > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxTotalBytes) {
      throw new RemoteWorkerArtifactStoreError("limit_exceeded");
    }
    throwIfAborted(input.signal);
    if (digestBytes(input.bytes) !== blobSha256) throw new RemoteWorkerArtifactStoreError("digest_mismatch");

    const relPath = this.blobRelPath(input.executionWorkspaceId, blobSha256);
    const finalPath = this.resolvePath(relPath);
    const parentPath = await this.ensureManagedDirectory(path.dirname(relPath), input.signal);

    const existing = await this.inspectExisting(finalPath, blobSha256, input.signal);
    if (existing !== undefined) {
      return { blobSha256, physicalRelPath: relPath, byteCount: existing, reused: true };
    }

    const token = this.randomToken();
    if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(token)) throw new RemoteWorkerArtifactStoreError("filesystem_error");
    // Staging paths use only server-derived hashes; never a worker logical path.
    const stagingPath = path.join(parentPath, `.${blobSha256}.tmp-${token}`);
    assertWorkerCellPathInJail(stagingPath, this.rootDir);
    let stagingCreated = false;
    try {
      const handle = await this.filesystem.openExclusive(stagingPath, 0o600, input.signal);
      stagingCreated = true;
      try {
        let offset = 0;
        while (offset < input.bytes.byteLength) {
          throwIfAborted(input.signal);
          const length = Math.min(64 * 1024, input.bytes.byteLength - offset);
          const written = await handle.write(input.bytes, offset, length, offset, input.signal);
          if (!Number.isSafeInteger(written) || written < 1 || written > length) {
            throw new RemoteWorkerArtifactStoreError("filesystem_error");
          }
          offset += written;
        }
        await handle.sync(input.signal);
        const staged = await handle.stat(input.signal);
        if (staged.kind !== "file" || staged.symbolicLink || staged.reparsePoint) {
          throw new RemoteWorkerArtifactStoreError("unsafe_path");
        }
        if (staged.size !== BigInt(input.bytes.byteLength)) throw new RemoteWorkerArtifactStoreError("tampered");
      } finally {
        await handle.close().catch(() => undefined);
      }
      await this.readVerified(stagingPath, blobSha256, input.signal);
      try {
        await this.filesystem.atomicRenameNoReplace(stagingPath, finalPath, input.signal);
        stagingCreated = false;
      } catch (error) {
        const raced = await this.inspectExisting(finalPath, blobSha256, input.signal).catch((inner: unknown) => {
          if (inner instanceof RemoteWorkerArtifactStoreError && inner.code === "not_found") return undefined;
          throw inner;
        });
        if (raced !== undefined) {
          return { blobSha256, physicalRelPath: relPath, byteCount: raced, reused: true };
        }
        throw mapError(error, input.signal);
      }
      await this.syncDirectory(parentPath, input.signal);
      const installed = await this.readVerified(finalPath, blobSha256, input.signal);
      return { blobSha256, physicalRelPath: relPath, byteCount: installed.byteLength, reused: false };
    } catch (error) {
      throw mapError(error, input.signal);
    } finally {
      if (stagingCreated) {
        await this.removeStagingIfSafe(stagingPath);
      }
    }
  }

  /** Read and verify immutable CAS bytes for a blob (used by trusted verification rehash). */
  public async readBlob(input: {
    executionWorkspaceId: string;
    blobSha256: string;
    signal: AbortSignal;
  }): Promise<Uint8Array> {
    assertAbortSignal(input.signal);
    const blobSha256 = assertDigest(input.blobSha256);
    const relPath = this.blobRelPath(input.executionWorkspaceId, blobSha256);
    return this.readVerified(this.resolvePath(relPath), blobSha256, input.signal);
  }

  public resolvePath(relPath: string): string {
    if (typeof relPath !== "string" || !relPath.startsWith("remote-workers/artifacts/")) {
      throw new RemoteWorkerArtifactStoreError("invalid_address");
    }
    const resolved = path.resolve(this.rootDir, ...relPath.split("/"));
    assertWorkerCellPathInJail(resolved, this.rootDir);
    return resolved;
  }

  private async inspectExisting(
    absolutePath: string,
    blobSha256: string,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    try {
      return (await this.readVerified(absolutePath, blobSha256, signal)).byteLength;
    } catch (error) {
      if (error instanceof RemoteWorkerArtifactStoreError && error.code === "not_found") return undefined;
      throw error;
    }
  }

  private async readVerified(absolutePath: string, blobSha256: string, signal: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);
    const before = await this.safeLstat(absolutePath, signal);
    if (before.kind !== "file" || before.symbolicLink || before.reparsePoint) {
      throw new RemoteWorkerArtifactStoreError("unsafe_path");
    }
    if (before.size > BigInt(REMOTE_WORKER_SETTLEMENT_BOUNDS.maxTotalBytes)) {
      throw new RemoteWorkerArtifactStoreError("tampered");
    }
    const handle = await this.filesystem.openReadOnly(absolutePath, signal);
    let bytes: Uint8Array;
    try {
      const opened = await handle.stat(signal);
      if (!sameIdentity(before, opened)) throw new RemoteWorkerArtifactStoreError("tampered");
      bytes = new Uint8Array(Number(before.size));
      let offset = 0;
      while (offset < bytes.byteLength) {
        throwIfAborted(signal);
        const length = Math.min(64 * 1024, bytes.byteLength - offset);
        const read = await handle.read(bytes, offset, length, offset, signal);
        if (!Number.isSafeInteger(read) || read < 1 || read > length) {
          throw new RemoteWorkerArtifactStoreError("tampered");
        }
        offset += read;
      }
      if (!sameIdentity(before, await handle.stat(signal))) throw new RemoteWorkerArtifactStoreError("tampered");
    } finally {
      await handle.close().catch(() => undefined);
    }
    const after = await this.safeLstat(absolutePath, signal);
    if (!sameIdentity(before, after) || digestBytes(bytes) !== blobSha256) {
      throw new RemoteWorkerArtifactStoreError("tampered");
    }
    return bytes;
  }

  private async ensureManagedDirectory(relPath: string, signal: AbortSignal): Promise<string> {
    let current = this.rootDir;
    await this.ensureDirectory(current, signal);
    for (const component of relPath.split("/")) {
      if (!component || component === "." || component === "..")
        throw new RemoteWorkerArtifactStoreError("unsafe_path");
      current = path.join(current, component);
      assertWorkerCellPathInJail(current, this.rootDir);
      await this.ensureDirectory(current, signal);
    }
    return current;
  }

  private async ensureDirectory(absolutePath: string, signal: AbortSignal): Promise<void> {
    const stat = await this.tryLstat(absolutePath, signal);
    if (!stat) {
      try {
        await this.filesystem.mkdir(absolutePath, 0o700, signal);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw mapError(error, signal);
      }
    }
    const observed = await this.safeLstat(absolutePath, signal);
    if (observed.kind !== "directory" || observed.symbolicLink || observed.reparsePoint) {
      throw new RemoteWorkerArtifactStoreError("unsafe_path");
    }
  }

  private async syncDirectory(absolutePath: string, signal: AbortSignal): Promise<void> {
    await this.filesystem.syncDirectory(absolutePath, signal).catch((error) => {
      if (!isUnsupportedSync(error)) throw mapError(error, signal);
    });
  }

  private async removeStagingIfSafe(absolutePath: string): Promise<void> {
    try {
      const signal = new AbortController().signal;
      const stat = await this.tryLstat(absolutePath, signal);
      if (!stat) return;
      if (stat.kind !== "file" || stat.symbolicLink || stat.reparsePoint) return;
      await this.filesystem.unlink(absolutePath, signal);
    } catch {
      // Fail closed: leave a swapped or unsafe staging path for operator cleanup.
    }
  }

  private async safeLstat(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceFilesystemStat> {
    try {
      return await this.filesystem.lstat(absolutePath, signal);
    } catch (error) {
      throw mapError(error, signal);
    }
  }

  private async tryLstat(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceFilesystemStat | undefined> {
    try {
      return await this.filesystem.lstat(absolutePath, signal);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw mapError(error, signal);
    }
  }
}

function assertDigest(value: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new RemoteWorkerArtifactStoreError("invalid_address");
  return value;
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(left: ExternalSourceFilesystemStat, right: ExternalSourceFilesystemStat): boolean {
  return (
    left.kind === right.kind &&
    left.symbolicLink === right.symbolicLink &&
    left.reparsePoint === right.reparsePoint &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function mapError(error: unknown, signal: AbortSignal): RemoteWorkerArtifactStoreError {
  if (error instanceof RemoteWorkerArtifactStoreError) return error;
  if (signal.aborted || isErrno(error, "ABORT_ERR")) return new RemoteWorkerArtifactStoreError("cancelled");
  if (isErrno(error, "ENOENT")) return new RemoteWorkerArtifactStoreError("not_found");
  if (isErrno(error, "ELOOP")) return new RemoteWorkerArtifactStoreError("unsafe_path");
  return new RemoteWorkerArtifactStoreError("filesystem_error");
}

function isUnsupportedSync(error: unknown): boolean {
  return (
    isErrno(error, "ENOSYS") ||
    isErrno(error, "ENOTSUP") ||
    isErrno(error, "EOPNOTSUPP") ||
    isErrno(error, "EINVAL") ||
    isErrno(error, "EISDIR")
  );
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === code;
}

function assertAbortSignal(signal: AbortSignal): void {
  if (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function") {
    throw new TypeError("Remote worker artifact AbortSignal is required.");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RemoteWorkerArtifactStoreError("cancelled");
}
