import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { EXTERNAL_SOURCE_LIMITS } from "@goatcitadel/contracts";
import type { ExternalSourceFilesystemStat } from "./external-source-reader.js";
import {
  NodeExternalSourceWindowsSecurity,
  type ExternalSourceWindowsSecurityPort,
} from "./external-source-windows-security.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const ARTIFACT_PREFIX = "external-sources/sha256";

export type ExternalSourceArtifactStoreErrorCode =
  | "cancelled"
  | "digest_mismatch"
  | "filesystem_error"
  | "invalid_address"
  | "limit_exceeded"
  | "not_found"
  | "tampered"
  | "unsafe_path";

const ERROR_MESSAGES: Readonly<Record<ExternalSourceArtifactStoreErrorCode, string>> = Object.freeze({
  cancelled: "External source artifact operation was cancelled.",
  digest_mismatch: "External source artifact digest does not match its immutable address.",
  filesystem_error: "External source artifact filesystem operation failed.",
  invalid_address: "External source artifact address is invalid.",
  limit_exceeded: "External source artifact exceeded a fixed limit.",
  not_found: "External source artifact was not found.",
  tampered: "External source artifact failed immutable verification.",
  unsafe_path: "External source artifact path contains an unsafe filesystem component.",
});

export class ExternalSourceArtifactStoreError extends Error {
  public constructor(public readonly code: ExternalSourceArtifactStoreErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ExternalSourceArtifactStoreError";
  }
}

export interface ExternalSourceArtifactFileHandle {
  stat(signal: AbortSignal): Promise<ExternalSourceFilesystemStat>;
  read(buffer: Uint8Array, offset: number, length: number, position: number, signal: AbortSignal): Promise<number>;
  write(buffer: Uint8Array, offset: number, length: number, position: number, signal: AbortSignal): Promise<number>;
  sync(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface ExternalSourceArtifactFilesystem {
  readonly ownerOnlyPermissions: "posix_mode" | "windows_acl" | "unsupported";
  lstat(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceFilesystemStat>;
  realpath(absolutePath: string, signal: AbortSignal): Promise<string>;
  mkdir(absolutePath: string, mode: number, signal: AbortSignal): Promise<void>;
  chmod(absolutePath: string, mode: number, signal: AbortSignal): Promise<void>;
  openExclusive(absolutePath: string, mode: number, signal: AbortSignal): Promise<ExternalSourceArtifactFileHandle>;
  openReadOnly(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceArtifactFileHandle>;
  atomicRenameNoReplace(sourcePath: string, destinationPath: string, signal: AbortSignal): Promise<void>;
  unlink(absolutePath: string, signal: AbortSignal): Promise<void>;
  syncDirectory(absolutePath: string, signal: AbortSignal): Promise<void>;
}

export interface ExternalSourceArtifactStoreDependencies {
  filesystem?: ExternalSourceArtifactFilesystem;
  randomToken?: () => string;
}

export interface ExternalSourcePublishedArtifact {
  artifactRelPath: string;
  artifactSha256: string;
  byteCount: number;
  reused: boolean;
}

export interface ExternalSourceReadArtifact extends Omit<ExternalSourcePublishedArtifact, "reused"> {
  bytes: Uint8Array;
}

interface ExternalSourceArtifactDirectoryBinding {
  absolutePath: string;
  stat: ExternalSourceFilesystemStat;
}

export class ExternalSourceArtifactStore {
  private readonly rootDir: string;
  private readonly filesystem: ExternalSourceArtifactFilesystem;
  private readonly randomToken: () => string;

  public constructor(rootDir: string, dependencies: ExternalSourceArtifactStoreDependencies = {}) {
    if (typeof rootDir !== "string" || !rootDir.trim()) {
      throw new TypeError("External source artifact store root is required.");
    }
    this.rootDir = path.resolve(rootDir);
    if (this.rootDir === path.parse(this.rootDir).root) {
      throw new TypeError("External source artifact store cannot use a filesystem root.");
    }
    this.filesystem = dependencies.filesystem ?? new NodeExternalSourceArtifactFilesystem();
    this.randomToken = dependencies.randomToken ?? randomUUID;
  }

  public async publish(input: {
    bytes: Uint8Array;
    expectedSha256: string;
    signal: AbortSignal;
  }): Promise<ExternalSourcePublishedArtifact> {
    assertAbortSignal(input.signal);
    assertDigest(input.expectedSha256);
    if (!(input.bytes instanceof Uint8Array)) throw new TypeError("External source artifact bytes are required.");
    if (input.bytes.byteLength > EXTERNAL_SOURCE_LIMITS.normalizedSessionArtifactBytes) {
      throw new ExternalSourceArtifactStoreError("limit_exceeded");
    }
    throwIfAborted(input.signal);
    const observedSha256 = digestBytes(input.bytes);
    if (observedSha256 !== input.expectedSha256) {
      throw new ExternalSourceArtifactStoreError("digest_mismatch");
    }

    const artifactRelPath = externalSourceArtifactRelPath(input.expectedSha256);
    const finalPath = this.resolveArtifactPath(artifactRelPath);
    const parentPath = await this.ensureManagedDirectory(ARTIFACT_PREFIX, input.signal);
    const directoryBinding = await this.captureDirectoryBinding(parentPath, input.signal);
    const existing = await this.inspectExisting(finalPath, input.expectedSha256, input.signal);
    if (existing !== undefined) {
      await this.applyOwnerOnlyPermissions(finalPath, 0o600, input.signal);
      const verified = await this.readVerifiedFile(finalPath, input.expectedSha256, input.signal);
      await this.assertDirectoryBinding(directoryBinding, input.signal);
      return this.result(artifactRelPath, input.expectedSha256, verified.byteLength, true);
    }

    const token = this.randomToken();
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(token)) {
      throw new ExternalSourceArtifactStoreError("filesystem_error");
    }
    const stagingPath = path.join(parentPath, `.${input.expectedSha256}.tmp-${token}`);
    let stagingCreated = false;
    try {
      const handle = await this.openExclusive(stagingPath, input.signal);
      stagingCreated = true;
      try {
        await this.applyOwnerOnlyPermissions(stagingPath, 0o600, input.signal);
        let offset = 0;
        while (offset < input.bytes.byteLength) {
          throwIfAborted(input.signal);
          const length = Math.min(64 * 1024, input.bytes.byteLength - offset);
          const written = await handle.write(input.bytes, offset, length, offset, input.signal);
          if (!Number.isSafeInteger(written) || written < 1 || written > length) {
            throw new ExternalSourceArtifactStoreError("filesystem_error");
          }
          offset += written;
        }
        await handle.sync(input.signal);
        const stagedStat = await handle.stat(input.signal);
        assertSafeFile(stagedStat);
        if (stagedStat.size !== BigInt(input.bytes.byteLength)) {
          throw new ExternalSourceArtifactStoreError("tampered");
        }
      } finally {
        await handle.close().catch(() => undefined);
      }

      await this.readVerifiedFile(stagingPath, input.expectedSha256, input.signal);
      await this.assertDirectoryBinding(directoryBinding, input.signal);
      await this.assertSafeChain(finalPath, "file", true, input.signal);
      try {
        await this.filesystem.atomicRenameNoReplace(stagingPath, finalPath, input.signal);
        stagingCreated = false;
      } catch (error) {
        await this.assertDirectoryBinding(directoryBinding, input.signal);
        const raced = await this.inspectExisting(finalPath, input.expectedSha256, input.signal).catch(
          (inspectionError: unknown) => {
            if (inspectionError instanceof ExternalSourceArtifactStoreError && inspectionError.code === "not_found") {
              return undefined;
            }
            throw inspectionError;
          },
        );
        if (raced !== undefined) {
          await this.syncManagedDirectory(parentPath, input.signal);
          await this.applyOwnerOnlyPermissions(finalPath, 0o600, input.signal);
          const verified = await this.readVerifiedFile(finalPath, input.expectedSha256, input.signal);
          await this.assertDirectoryBinding(directoryBinding, input.signal);
          return this.result(artifactRelPath, input.expectedSha256, verified.byteLength, true);
        }
        throw mapArtifactError(error, input.signal);
      }
      await this.assertDirectoryBinding(directoryBinding, input.signal);
      await this.syncManagedDirectory(parentPath, input.signal);
      await this.applyOwnerOnlyPermissions(finalPath, 0o600, input.signal);
      const installed = await this.readVerifiedFile(finalPath, input.expectedSha256, input.signal);
      await this.assertDirectoryBinding(directoryBinding, input.signal);
      return this.result(artifactRelPath, input.expectedSha256, installed.byteLength, false);
    } catch (error) {
      throw mapArtifactError(error, input.signal);
    } finally {
      if (stagingCreated) {
        // Caller cancellation must stop publication, but it must not disable
        // best-effort cleanup of a server-owned temporary file.
        await this.removeStagingIfSafe(stagingPath, new AbortController().signal);
      }
    }
  }

  public async read(input: {
    artifactRelPath: string;
    expectedSha256: string;
    signal: AbortSignal;
  }): Promise<ExternalSourceReadArtifact> {
    assertAbortSignal(input.signal);
    assertDigest(input.expectedSha256);
    if (input.artifactRelPath !== externalSourceArtifactRelPath(input.expectedSha256)) {
      throw new ExternalSourceArtifactStoreError("invalid_address");
    }
    const absolutePath = this.resolveArtifactPath(input.artifactRelPath);
    try {
      await this.readVerifiedFile(absolutePath, input.expectedSha256, input.signal);
      await this.applyOwnerOnlyPermissions(absolutePath, 0o600, input.signal);
      const bytes = await this.readVerifiedFile(absolutePath, input.expectedSha256, input.signal);
      return {
        artifactRelPath: input.artifactRelPath,
        artifactSha256: input.expectedSha256,
        byteCount: bytes.byteLength,
        bytes,
      };
    } catch (error) {
      throw mapArtifactError(error, input.signal);
    }
  }

  public async verify(input: {
    artifactRelPath: string;
    expectedSha256: string;
    signal: AbortSignal;
  }): Promise<boolean> {
    try {
      await this.read(input);
      return true;
    } catch (error) {
      if (error instanceof ExternalSourceArtifactStoreError && error.code === "not_found") return false;
      throw error;
    }
  }

  public resolveArtifactPath(artifactRelPath: string): string {
    if (typeof artifactRelPath !== "string") throw new ExternalSourceArtifactStoreError("invalid_address");
    const match = /^external-sources\/sha256\/([a-f0-9]{64})$/u.exec(artifactRelPath);
    if (!match?.[1] || artifactRelPath !== externalSourceArtifactRelPath(match[1])) {
      throw new ExternalSourceArtifactStoreError("invalid_address");
    }
    const resolved = path.resolve(this.rootDir, ...artifactRelPath.split("/"));
    assertContained(this.rootDir, resolved);
    return resolved;
  }

  private result(
    artifactRelPath: string,
    artifactSha256: string,
    byteCount: number,
    reused: boolean,
  ): ExternalSourcePublishedArtifact {
    return { artifactRelPath, artifactSha256, byteCount, reused };
  }

  private async inspectExisting(
    absolutePath: string,
    expectedSha256: string,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    try {
      const bytes = await this.readVerifiedFile(absolutePath, expectedSha256, signal);
      return bytes.byteLength;
    } catch (error) {
      if (error instanceof ExternalSourceArtifactStoreError && error.code === "not_found") return undefined;
      throw error;
    }
  }

  private async readVerifiedFile(
    absolutePath: string,
    expectedSha256: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    throwIfAborted(signal);
    await this.assertSafeChain(absolutePath, "file", false, signal);
    const before = await this.safeLstat(absolutePath, signal);
    assertSafeFile(before);
    if (before.size > BigInt(EXTERNAL_SOURCE_LIMITS.normalizedSessionArtifactBytes)) {
      throw new ExternalSourceArtifactStoreError("tampered");
    }
    const handle = await this.openReadOnly(absolutePath, signal);
    let bytes: Uint8Array;
    try {
      const opened = await handle.stat(signal);
      if (!sameIdentityAndVersion(before, opened)) throw new ExternalSourceArtifactStoreError("tampered");
      bytes = new Uint8Array(Number(before.size));
      let offset = 0;
      while (offset < bytes.byteLength) {
        throwIfAborted(signal);
        const length = Math.min(64 * 1024, bytes.byteLength - offset);
        const bytesRead = await handle.read(bytes, offset, length, offset, signal);
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > length) {
          throw new ExternalSourceArtifactStoreError("tampered");
        }
        offset += bytesRead;
      }
      const afterHandle = await handle.stat(signal);
      if (!sameIdentityAndVersion(before, afterHandle)) throw new ExternalSourceArtifactStoreError("tampered");
    } finally {
      await handle.close().catch(() => undefined);
    }
    await this.assertSafeChain(absolutePath, "file", false, signal);
    const afterPath = await this.safeLstat(absolutePath, signal);
    if (!sameIdentityAndVersion(before, afterPath) || digestBytes(bytes) !== expectedSha256) {
      throw new ExternalSourceArtifactStoreError("tampered");
    }
    return bytes;
  }

  private async ensureManagedDirectory(relativePath: string, signal: AbortSignal): Promise<string> {
    await this.ensureRootDirectory(signal);
    let current = this.rootDir;
    for (const component of relativePath.split("/")) {
      assertSafeComponent(component);
      current = path.join(current, component);
      await this.ensureDirectory(current, true, signal);
    }
    return current;
  }

  private async ensureRootDirectory(signal: AbortSignal): Promise<void> {
    const parsed = path.parse(this.rootDir);
    const relative = path.relative(parsed.root, this.rootDir);
    let current = parsed.root;
    await this.assertExistingSafeNode(current, "directory", signal);
    for (const component of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const managed = sameCanonicalPath(current, this.rootDir);
      await this.ensureDirectory(current, managed, signal);
    }
  }

  private async ensureDirectory(absolutePath: string, harden: boolean, signal: AbortSignal): Promise<void> {
    let stat = await this.tryLstat(absolutePath, signal);
    if (!stat) {
      try {
        await this.filesystem.mkdir(absolutePath, 0o700, signal);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw mapArtifactError(error, signal);
      }
      stat = await this.safeLstat(absolutePath, signal);
    }
    await this.assertSafeNode(absolutePath, stat, "directory", signal);
    if (harden || isContainedOrEqual(this.rootDir, absolutePath)) {
      await this.applyOwnerOnlyPermissions(absolutePath, 0o700, signal);
    }
  }

  private async assertSafeChain(
    absoluteTarget: string,
    leafKind: "directory" | "file",
    allowMissingLeaf: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    assertContainedOrEqual(this.rootDir, absoluteTarget);
    const parsed = path.parse(absoluteTarget);
    const relative = path.relative(parsed.root, absoluteTarget);
    let current = parsed.root;
    await this.assertExistingSafeNode(current, "directory", signal);
    const components = relative.split(path.sep).filter(Boolean);
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index] ?? "");
      const kind = index === components.length - 1 ? leafKind : "directory";
      const stat = await this.tryLstat(current, signal);
      if (!stat) {
        if (allowMissingLeaf && index === components.length - 1) return;
        throw new ExternalSourceArtifactStoreError("not_found");
      }
      await this.assertSafeNode(current, stat, kind, signal);
    }
  }

  private async captureDirectoryBinding(
    absoluteDirectory: string,
    signal: AbortSignal,
  ): Promise<readonly ExternalSourceArtifactDirectoryBinding[]> {
    assertContainedOrEqual(this.rootDir, absoluteDirectory);
    const parsed = path.parse(absoluteDirectory);
    const components = path.relative(parsed.root, absoluteDirectory).split(path.sep).filter(Boolean);
    const binding: ExternalSourceArtifactDirectoryBinding[] = [];
    let current = parsed.root;
    const rootStat = await this.safeLstat(current, signal);
    await this.assertSafeNode(current, rootStat, "directory", signal);
    binding.push({ absolutePath: current, stat: rootStat });
    for (const component of components) {
      current = path.join(current, component);
      const stat = await this.safeLstat(current, signal);
      await this.assertSafeNode(current, stat, "directory", signal);
      binding.push({ absolutePath: current, stat });
    }
    return binding;
  }

  private async assertDirectoryBinding(
    binding: readonly ExternalSourceArtifactDirectoryBinding[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const expected of binding) {
      const observed = await this.safeLstat(expected.absolutePath, signal);
      await this.assertSafeNode(expected.absolutePath, observed, "directory", signal);
      if (!sameFilesystemIdentityAndMode(expected.stat, observed)) {
        throw new ExternalSourceArtifactStoreError("unsafe_path");
      }
    }
  }

  private async assertExistingSafeNode(
    absolutePath: string,
    kind: "directory" | "file",
    signal: AbortSignal,
  ): Promise<void> {
    const stat = await this.safeLstat(absolutePath, signal);
    await this.assertSafeNode(absolutePath, stat, kind, signal);
  }

  private async assertSafeNode(
    absolutePath: string,
    stat: ExternalSourceFilesystemStat,
    kind: "directory" | "file",
    signal: AbortSignal,
  ): Promise<void> {
    assertValidStat(stat);
    if (stat.symbolicLink || stat.reparsePoint || stat.kind !== kind) {
      throw new ExternalSourceArtifactStoreError("unsafe_path");
    }
    let canonicalPath: string;
    try {
      canonicalPath = await this.filesystem.realpath(absolutePath, signal);
    } catch (error) {
      throw mapArtifactError(error, signal);
    }
    if (!sameCanonicalPath(canonicalPath, absolutePath)) {
      throw new ExternalSourceArtifactStoreError("unsafe_path");
    }
  }

  private async applyOwnerOnlyPermissions(absolutePath: string, mode: number, signal: AbortSignal): Promise<void> {
    if (this.filesystem.ownerOnlyPermissions === "unsupported") {
      throw new ExternalSourceArtifactStoreError("filesystem_error");
    }
    try {
      await this.filesystem.chmod(absolutePath, mode, signal);
    } catch (error) {
      throw mapArtifactError(error, signal);
    }
    if (this.filesystem.ownerOnlyPermissions === "posix_mode") {
      const stat = await this.safeLstat(absolutePath, signal);
      if (Number(stat.mode & 0o777n) !== mode) {
        throw new ExternalSourceArtifactStoreError("filesystem_error");
      }
    }
  }

  private async syncManagedDirectory(absolutePath: string, signal: AbortSignal): Promise<void> {
    await this.filesystem.syncDirectory(absolutePath, signal).catch((error) => {
      if (!isUnsupportedSync(error)) throw mapArtifactError(error, signal);
    });
  }

  private async removeStagingIfSafe(absolutePath: string, signal: AbortSignal): Promise<void> {
    try {
      const stat = await this.tryLstat(absolutePath, signal);
      if (!stat) return;
      await this.assertSafeChain(absolutePath, "file", false, signal);
      await this.filesystem.unlink(absolutePath, signal);
    } catch {
      // Fail closed: an unsafe or swapped staging path is deliberately left for operator cleanup.
    }
  }

  private async safeLstat(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceFilesystemStat> {
    try {
      return await this.filesystem.lstat(absolutePath, signal);
    } catch (error) {
      throw mapArtifactError(error, signal);
    }
  }

  private async tryLstat(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceFilesystemStat | undefined> {
    try {
      return await this.filesystem.lstat(absolutePath, signal);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw mapArtifactError(error, signal);
    }
  }

  private async openExclusive(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceArtifactFileHandle> {
    try {
      return await this.filesystem.openExclusive(absolutePath, 0o600, signal);
    } catch (error) {
      throw mapArtifactError(error, signal);
    }
  }

  private async openReadOnly(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceArtifactFileHandle> {
    try {
      return await this.filesystem.openReadOnly(absolutePath, signal);
    } catch (error) {
      throw mapArtifactError(error, signal);
    }
  }
}

export interface NodeExternalSourceArtifactFilesystemDependencies {
  windowsSecurity?: ExternalSourceWindowsSecurityPort;
}

export class NodeExternalSourceArtifactFilesystem implements ExternalSourceArtifactFilesystem {
  public readonly ownerOnlyPermissions: ExternalSourceArtifactFilesystem["ownerOnlyPermissions"];
  private readonly windowsSecurity: ExternalSourceWindowsSecurityPort | undefined;
  private readonly permissionQueues = new Map<string, Promise<void>>();

  public constructor(dependencies: NodeExternalSourceArtifactFilesystemDependencies = {}) {
    this.windowsSecurity =
      dependencies.windowsSecurity ??
      (process.platform === "win32" ? new NodeExternalSourceWindowsSecurity() : undefined);
    this.ownerOnlyPermissions = this.windowsSecurity ? "windows_acl" : "posix_mode";
  }

  public async lstat(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceFilesystemStat> {
    throwIfAborted(signal);
    const stat = await fs.lstat(absolutePath, { bigint: true });
    const reparsePoint =
      stat.isSymbolicLink() ||
      (this.windowsSecurity ? await this.windowsSecurity.inspectReparsePoint(absolutePath, signal) : false);
    throwIfAborted(signal);
    return fromNodeStat(stat, reparsePoint);
  }

  public async realpath(absolutePath: string, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const canonicalPath = await fs.realpath(absolutePath);
    throwIfAborted(signal);
    return canonicalPath;
  }

  public async mkdir(absolutePath: string, mode: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await fs.mkdir(absolutePath, { recursive: false, mode });
    throwIfAborted(signal);
  }

  public async chmod(absolutePath: string, mode: number, signal: AbortSignal): Promise<void> {
    const queueKey = canonicalPathKey(absolutePath);
    const prior = this.permissionQueues.get(queueKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(() => current);
    this.permissionQueues.set(queueKey, tail);
    await prior.catch(() => undefined);
    try {
      await this.applyPermissions(absolutePath, mode, signal);
    } finally {
      release();
      if (this.permissionQueues.get(queueKey) === tail) this.permissionQueues.delete(queueKey);
    }
  }

  private async applyPermissions(absolutePath: string, mode: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const kind = mode === 0o700 ? "directory" : mode === 0o600 ? "file" : undefined;
    if (!kind) throw new ExternalSourceArtifactStoreError("filesystem_error");
    // A directory legitimately changes mtime/size while sibling publications add
    // CAS entries into it concurrently, so hardening a directory verifies node
    // identity only (device, inode, birthtime, type) — enough to detect a TOCTOU
    // swap — while a content file is still pinned to its exact version.
    const sameNode = kind === "directory" ? sameFilesystemIdentity : sameIdentityAndVersion;
    const before = await this.lstat(absolutePath, signal);
    if (before.kind !== kind || before.symbolicLink || before.reparsePoint) {
      throw new ExternalSourceArtifactStoreError("unsafe_path");
    }
    if (this.windowsSecurity) {
      await this.windowsSecurity.applyOwnerOnlyAcl(absolutePath, kind, signal);
    } else {
      const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const opened = fromNodeStat(await handle.stat({ bigint: true }));
        if (!sameNode(before, opened) || opened.kind !== kind) {
          throw new ExternalSourceArtifactStoreError("unsafe_path");
        }
        await handle.chmod(mode);
        const hardened = fromNodeStat(await handle.stat({ bigint: true }));
        if (!sameNode(before, hardened) || hardened.kind !== kind || Number(hardened.mode & 0o777n) !== mode) {
          throw new ExternalSourceArtifactStoreError("filesystem_error");
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    throwIfAborted(signal);
    const after = await this.lstat(absolutePath, signal);
    if (!sameFilesystemIdentity(before, after) || after.kind !== kind || after.symbolicLink || after.reparsePoint) {
      throw new ExternalSourceArtifactStoreError("unsafe_path");
    }
  }

  public async openExclusive(
    absolutePath: string,
    mode: number,
    signal: AbortSignal,
  ): Promise<ExternalSourceArtifactFileHandle> {
    const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    return this.openHandle(
      absolutePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
      mode,
      signal,
    );
  }

  public async openReadOnly(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceArtifactFileHandle> {
    const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    return this.openHandle(absolutePath, fsConstants.O_RDONLY | noFollow, 0o600, signal);
  }

  public async atomicRenameNoReplace(sourcePath: string, destinationPath: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    // Node rename can overwrite an existing file (including on Windows under
    // concurrency). A same-filesystem hard-link is the portable atomic
    // no-replace install; removing the temporary name leaves the installed
    // inode at its immutable CAS address.
    await fs.link(sourcePath, destinationPath);
    await fs.unlink(sourcePath);
    throwIfAborted(signal);
  }

  public async unlink(absolutePath: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await fs.unlink(absolutePath);
    throwIfAborted(signal);
  }

  public async syncDirectory(absolutePath: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    // Node cannot open/fsync directories on Windows. The staged file is always
    // fsynced before install; directory fsync is additionally performed on
    // platforms where Node exposes it.
    if (process.platform === "win32") return;
    const handle = await fs.open(absolutePath, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfAborted(signal);
  }

  private async openHandle(
    absolutePath: string,
    flags: number,
    mode: number,
    signal: AbortSignal,
  ): Promise<ExternalSourceArtifactFileHandle> {
    throwIfAborted(signal);
    const handle = await fs.open(absolutePath, flags, mode);
    if (signal.aborted) {
      await handle.close().catch(() => undefined);
      throw new ExternalSourceArtifactStoreError("cancelled");
    }
    return {
      stat: async (operationSignal) => {
        throwIfAborted(operationSignal);
        const stat = await handle.stat({ bigint: true });
        throwIfAborted(operationSignal);
        return fromNodeStat(stat);
      },
      read: async (buffer, offset, length, position, operationSignal) => {
        throwIfAborted(operationSignal);
        const result = await handle.read(buffer, offset, length, position);
        throwIfAborted(operationSignal);
        return result.bytesRead;
      },
      write: async (buffer, offset, length, position, operationSignal) => {
        throwIfAborted(operationSignal);
        const result = await handle.write(buffer, offset, length, position);
        throwIfAborted(operationSignal);
        return result.bytesWritten;
      },
      sync: async (operationSignal) => {
        throwIfAborted(operationSignal);
        await handle.sync();
        throwIfAborted(operationSignal);
      },
      close: () => handle.close(),
    };
  }
}

export function externalSourceArtifactRelPath(sha256: string): string {
  assertDigest(sha256);
  return `${ARTIFACT_PREFIX}/${sha256}`;
}

function assertDigest(value: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ExternalSourceArtifactStoreError("invalid_address");
  }
}

function assertSafeComponent(value: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new ExternalSourceArtifactStoreError("unsafe_path");
  }
}

function assertSafeFile(stat: ExternalSourceFilesystemStat): void {
  assertValidStat(stat);
  if (stat.kind !== "file" || stat.symbolicLink || stat.reparsePoint) {
    throw new ExternalSourceArtifactStoreError("unsafe_path");
  }
}

function assertValidStat(stat: ExternalSourceFilesystemStat): void {
  if (
    !stat ||
    !["directory", "file", "other"].includes(stat.kind) ||
    typeof stat.symbolicLink !== "boolean" ||
    typeof stat.reparsePoint !== "boolean" ||
    [stat.device, stat.inode, stat.size, stat.mtimeNs, stat.birthtimeNs, stat.mode].some(
      (value) => typeof value !== "bigint" || value < 0n,
    )
  ) {
    throw new ExternalSourceArtifactStoreError("filesystem_error");
  }
}

function sameIdentityAndVersion(left: ExternalSourceFilesystemStat, right: ExternalSourceFilesystemStat): boolean {
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

function sameFilesystemIdentity(left: ExternalSourceFilesystemStat, right: ExternalSourceFilesystemStat): boolean {
  return (
    left.kind === right.kind &&
    left.symbolicLink === right.symbolicLink &&
    left.reparsePoint === right.reparsePoint &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameFilesystemIdentityAndMode(
  left: ExternalSourceFilesystemStat,
  right: ExternalSourceFilesystemStat,
): boolean {
  return (
    left.kind === right.kind &&
    left.symbolicLink === right.symbolicLink &&
    left.reparsePoint === right.reparsePoint &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs &&
    left.mode === right.mode
  );
}

function assertContained(root: string, candidate: string): void {
  if (!isContainedOrEqual(root, candidate) || sameCanonicalPath(root, candidate)) {
    throw new ExternalSourceArtifactStoreError("unsafe_path");
  }
}

function assertContainedOrEqual(root: string, candidate: string): void {
  if (!isContainedOrEqual(root, candidate)) throw new ExternalSourceArtifactStoreError("unsafe_path");
}

function isContainedOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sameCanonicalPath(left: string, right: string): boolean {
  return canonicalPathKey(left) === canonicalPathKey(right);
}

function canonicalPathKey(value: string): string {
  const normalized = normalizeExtendedPath(path.resolve(value));
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function normalizeExtendedPath(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fromNodeStat(
  stat: Awaited<ReturnType<typeof fs.lstat>> & { size: bigint },
  reparsePoint = stat.isSymbolicLink(),
): ExternalSourceFilesystemStat {
  const bigintStat = stat as unknown as {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    birthtimeNs: bigint;
    mode: bigint;
  };
  return {
    kind: bigintStat.isDirectory() ? "directory" : bigintStat.isFile() ? "file" : "other",
    symbolicLink: bigintStat.isSymbolicLink(),
    reparsePoint,
    device: bigintStat.dev,
    inode: bigintStat.ino,
    size: bigintStat.size,
    mtimeNs: bigintStat.mtimeNs,
    birthtimeNs: bigintStat.birthtimeNs,
    mode: bigintStat.mode,
  };
}

function mapArtifactError(error: unknown, signal: AbortSignal): ExternalSourceArtifactStoreError {
  if (error instanceof ExternalSourceArtifactStoreError) return error;
  if (signal.aborted || isErrno(error, "ABORT_ERR")) return new ExternalSourceArtifactStoreError("cancelled");
  if (isErrno(error, "ENOENT")) return new ExternalSourceArtifactStoreError("not_found");
  if (isErrno(error, "ELOOP")) return new ExternalSourceArtifactStoreError("unsafe_path");
  return new ExternalSourceArtifactStoreError("filesystem_error");
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
    throw new TypeError("External source artifact AbortSignal is required.");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExternalSourceArtifactStoreError("cancelled");
}
