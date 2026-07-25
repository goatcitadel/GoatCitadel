/* eslint-disable max-lines -- The artifact transaction, filesystem identity checks, and settlement protocol remain co-located for auditability. */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertSkillHubArtifactManifest,
  assertSkillHubSha256,
  canonicalJsonString,
  skillHubArtifactBundleRelPath,
  type SkillContentIntegrityManifest,
} from "@goatcitadel/contracts";
import {
  captureSkillContentIntegrity,
  shouldIncludeSkillContentPath,
  SKILL_CONTENT_INTEGRITY_LIMITS,
} from "./skill-content-integrity.js";
import { NodeSkillHubWindowsSecurity, type SkillHubWindowsSecurityPort } from "./skill-hub-windows-security.js";

const CLAIM_WAIT_MS = 5_000;
const CLAIM_STALE_MS = 120_000;
const CLAIM_POLL_MS = 10;
const SETTLEMENT_VERSION = "goatcitadel.skill-hub-settlement.v1" as const;

export type SkillHubArtifactStoreErrorCode =
  | "claim_timeout"
  | "filesystem_error"
  | "invalid_address"
  | "source_mismatch"
  | "tampered"
  | "unsafe_path";

const ERROR_MESSAGES: Readonly<Record<SkillHubArtifactStoreErrorCode, string>> = Object.freeze({
  claim_timeout: "Skill Hub artifact publication claim did not settle within its bounded wait.",
  filesystem_error: "Skill Hub artifact filesystem operation failed.",
  invalid_address: "Skill Hub artifact address is invalid.",
  source_mismatch: "Skill Hub artifact source does not match the reviewed content address.",
  tampered: "Skill Hub artifact failed immutable verification.",
  unsafe_path: "Skill Hub artifact path contains an unsafe filesystem component.",
});

export class SkillHubArtifactStoreError extends Error {
  public constructor(public readonly code: SkillHubArtifactStoreErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SkillHubArtifactStoreError";
  }
}

export interface SkillHubArtifactFilesystemStat {
  kind: "directory" | "file" | "other";
  symbolicLink: boolean;
  reparsePoint: boolean;
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  birthtimeNs: bigint;
  mode: bigint;
}

export interface SkillHubArtifactFileHandle {
  stat(signal: AbortSignal): Promise<SkillHubArtifactFilesystemStat>;
  read(buffer: Uint8Array, offset: number, length: number, position: number, signal: AbortSignal): Promise<number>;
  write(buffer: Uint8Array, offset: number, length: number, position: number, signal: AbortSignal): Promise<number>;
  sync(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface SkillHubArtifactFilesystem {
  readonly ownerOnlyPermissions: "posix_mode" | "windows_acl" | "unsupported";
  lstat(absolutePath: string, signal: AbortSignal): Promise<SkillHubArtifactFilesystemStat>;
  realpath(absolutePath: string, signal: AbortSignal): Promise<string>;
  readdir(absolutePath: string, signal: AbortSignal): Promise<string[]>;
  mkdir(absolutePath: string, mode: number, signal: AbortSignal): Promise<void>;
  chmod(absolutePath: string, mode: number, signal: AbortSignal): Promise<void>;
  openExclusive(absolutePath: string, mode: number, signal: AbortSignal): Promise<SkillHubArtifactFileHandle>;
  openReadOnly(absolutePath: string, signal: AbortSignal): Promise<SkillHubArtifactFileHandle>;
  renameDirectory(sourcePath: string, destinationPath: string, signal: AbortSignal): Promise<void>;
  linkNoReplace(sourcePath: string, destinationPath: string, signal: AbortSignal): Promise<void>;
  unlink(absolutePath: string, signal: AbortSignal): Promise<void>;
  removeTree(absolutePath: string, signal: AbortSignal): Promise<void>;
  syncDirectory(absolutePath: string, signal: AbortSignal): Promise<void>;
}

export interface SkillHubArtifactStoreDependencies {
  filesystem?: SkillHubArtifactFilesystem;
  randomToken?: () => string;
  nowMs?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  claimWaitMs?: number;
  claimStaleMs?: number;
  hooks?: {
    afterDirectoryInstall?(): Promise<void> | void;
  };
}

export interface SkillHubPublishedArtifact {
  bundleRelPath: string;
  manifest: SkillContentIntegrityManifest;
  manifestSha256: string;
  reused: boolean;
}

interface DirectoryBinding {
  absolutePath: string;
  stat: SkillHubArtifactFilesystemStat;
}

interface OwnedNode {
  absolutePath: string;
  stat: SkillHubArtifactFilesystemStat;
}

interface SettlementRecord {
  manifestVersion: typeof SETTLEMENT_VERSION;
  manifestSha256: string;
  treeSha256: string;
}

type SettlementState = "absent" | "settled" | "unsettled";

/**
 * Content-addressed, create-only storage for reviewed upstream skill bytes.
 *
 * Node does not expose a portable directory equivalent of
 * renameat2(RENAME_NOREPLACE). Publication is therefore serialized by a
 * create-exclusive per-address claim. The immutable settlement file is
 * installed with a hard-link no-replace operation only after every staged file
 * and directory has been synced and the final directory identity has been
 * revalidated. A process that dies after directory rename can be recovered by
 * the next claim owner only when the complete final tree still matches exactly.
 */
export class SkillHubArtifactStore {
  private readonly rootDir: string;
  private readonly filesystem: SkillHubArtifactFilesystem;
  private readonly randomToken: () => string;
  private readonly nowMs: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly claimWaitMs: number;
  private readonly claimStaleMs: number;
  private readonly hooks: NonNullable<SkillHubArtifactStoreDependencies["hooks"]>;

  public constructor(rootDir: string, dependencies: SkillHubArtifactStoreDependencies = {}) {
    if (typeof rootDir !== "string" || !rootDir.trim()) {
      throw new TypeError("Skill Hub artifact store root is required.");
    }
    this.rootDir = path.resolve(rootDir);
    if (sameCanonicalPath(this.rootDir, path.parse(this.rootDir).root)) {
      throw new TypeError("Skill Hub artifact store cannot use a filesystem root.");
    }
    this.filesystem = dependencies.filesystem ?? new NodeSkillHubArtifactFilesystem();
    this.randomToken = dependencies.randomToken ?? randomUUID;
    this.nowMs = dependencies.nowMs ?? Date.now;
    this.wait = dependencies.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.claimWaitMs = boundedDuration(dependencies.claimWaitMs, CLAIM_WAIT_MS);
    this.claimStaleMs = boundedDuration(dependencies.claimStaleMs, CLAIM_STALE_MS);
    this.hooks = dependencies.hooks ?? {};
  }

  public async publishFromDirectory(input: {
    sourceDir: string;
    expectedTreeSha256: string;
  }): Promise<SkillHubPublishedArtifact> {
    assertSkillHubSha256(input.expectedTreeSha256, "expected content tree");
    const signal = new AbortController().signal;
    try {
      const sourceDir = path.resolve(input.sourceDir);
      const sourceManifest = await this.captureSourceManifest(sourceDir, signal);
      assertSkillHubArtifactManifest(sourceManifest);
      assertPortableManifestPaths(sourceManifest);
      if (sourceManifest.treeSha256 !== input.expectedTreeSha256) {
        throw new SkillHubArtifactStoreError("source_mismatch");
      }

      const bundleRelPath = skillHubArtifactBundleRelPath(sourceManifest.treeSha256);
      const finalDir = this.resolveBundlePath(bundleRelPath);
      const parentRelPath = path.posix.dirname(bundleRelPath);
      const parentDir = await this.ensureManagedDirectory(parentRelPath, signal);
      const settlementPath = path.join(parentDir, `.${sourceManifest.treeSha256}.settled`);
      const claimPath = path.join(parentDir, `.${sourceManifest.treeSha256}.claim`);

      if ((await this.inspectSettlement(finalDir, settlementPath, sourceManifest, signal)) === "settled") {
        return this.result(bundleRelPath, sourceManifest, true);
      }

      const claim = await this.acquireClaim(claimPath, finalDir, settlementPath, sourceManifest, signal);
      if (!claim) return this.result(bundleRelPath, sourceManifest, true);
      try {
        await this.assertOwnedFile(claim, signal);
        await this.cleanupStalePublicationTemps(parentDir, sourceManifest.treeSha256, signal);
        const state = await this.inspectSettlement(finalDir, settlementPath, sourceManifest, signal);
        if (state === "settled") return this.result(bundleRelPath, sourceManifest, true);
        if (state === "unsettled") {
          await this.assertExactDirectory(finalDir, sourceManifest, signal);
          await this.assertOwnedFile(claim, signal);
          await this.publishSettlement(settlementPath, sourceManifest, parentDir, signal);
          return this.result(bundleRelPath, sourceManifest, true);
        }

        const directoryBinding = await this.captureDirectoryBinding(parentDir, signal);
        const token = this.validatedToken();
        const stagingPath = path.join(parentDir, `.${sourceManifest.treeSha256}.staging-${token}`);
        await this.filesystem.mkdir(stagingPath, 0o700, signal);
        const stagingNode: OwnedNode = { absolutePath: stagingPath, stat: await this.safeLstat(stagingPath, signal) };
        let installed = false;
        try {
          await this.applyOwnerOnlyPermissions(stagingPath, "directory", signal);
          await this.copyManifestFiles(sourceDir, stagingPath, sourceManifest, signal);
          await this.assertExactDirectory(stagingPath, sourceManifest, signal);
          await this.syncTreeDirectories(stagingPath, sourceManifest, signal);
          await this.assertDirectoryBinding(directoryBinding, signal);
          await this.assertOwnedFile(claim, signal);
          const finalState = await this.tryLstat(finalDir, signal);
          if (finalState) throw new SkillHubArtifactStoreError("tampered");
          const stagedBeforeRename = await this.safeLstat(stagingPath, signal);
          assertSafeStat(stagedBeforeRename, "directory");
          await this.filesystem.renameDirectory(stagingPath, finalDir, signal);
          installed = true;
          const installedStat = await this.safeLstat(finalDir, signal);
          if (!sameFilesystemIdentity(stagedBeforeRename, installedStat)) {
            throw new SkillHubArtifactStoreError("unsafe_path");
          }
          await this.assertDirectoryBinding(directoryBinding, signal);
          await this.syncManagedDirectory(parentDir, signal);
          await this.assertExactDirectory(finalDir, sourceManifest, signal);
          await this.hooks.afterDirectoryInstall?.();
          await this.assertOwnedFile(claim, signal);
          await this.publishSettlement(settlementPath, sourceManifest, parentDir, signal);
          await this.assertDirectoryBinding(directoryBinding, signal);
          return this.result(bundleRelPath, sourceManifest, false);
        } finally {
          if (!installed) await this.removeOwnedTreeIfSafe(stagingNode, signal);
        }
      } finally {
        await this.releaseClaim(claim, signal);
      }
    } catch (error) {
      throw mapArtifactError(error);
    }
  }

  public async verify(input: { bundleRelPath: string; manifest: SkillContentIntegrityManifest }): Promise<boolean> {
    assertSkillHubArtifactManifest(input.manifest);
    if (input.bundleRelPath !== skillHubArtifactBundleRelPath(input.manifest.treeSha256)) return false;
    const signal = new AbortController().signal;
    try {
      assertPortableManifestPaths(input.manifest);
      const finalDir = this.resolveBundlePath(input.bundleRelPath);
      const settlementPath = path.join(path.dirname(finalDir), `.${input.manifest.treeSha256}.settled`);
      return (await this.inspectSettlement(finalDir, settlementPath, input.manifest, signal)) === "settled";
    } catch (error) {
      const mapped = mapArtifactError(error);
      if (["invalid_address", "tampered", "unsafe_path"].includes(mapped.code) || isErrno(error, "ENOENT")) {
        return false;
      }
      throw mapped;
    }
  }

  public resolveBundlePath(bundleRelPath: string): string {
    if (typeof bundleRelPath !== "string") throw new SkillHubArtifactStoreError("invalid_address");
    const segments = bundleRelPath.split("/");
    const treeSha256 = segments.length === 3 ? segments[2] : undefined;
    try {
      assertSkillHubSha256(treeSha256, "bundle path tree");
    } catch {
      throw new SkillHubArtifactStoreError("invalid_address");
    }
    if (bundleRelPath !== skillHubArtifactBundleRelPath(treeSha256!)) {
      throw new SkillHubArtifactStoreError("invalid_address");
    }
    return this.resolveManagedPath(bundleRelPath);
  }

  private result(
    bundleRelPath: string,
    manifest: SkillContentIntegrityManifest,
    reused: boolean,
  ): SkillHubPublishedArtifact {
    return {
      bundleRelPath,
      manifest,
      manifestSha256: manifestDigest(manifest),
      reused,
    };
  }

  private async captureSourceManifest(sourceDir: string, signal: AbortSignal): Promise<SkillContentIntegrityManifest> {
    const binding = await this.captureDirectoryBinding(sourceDir, signal);
    const nodes = await this.captureTreeNodes(sourceDir, false, signal);
    const manifest = await captureSkillContentIntegrity(sourceDir);
    await this.assertTreeNodesUnchanged(nodes, signal);
    await this.assertDirectoryBinding(binding, signal);
    return manifest;
  }

  private async copyManifestFiles(
    sourceDir: string,
    stagingDir: string,
    manifest: SkillContentIntegrityManifest,
    signal: AbortSignal,
  ): Promise<void> {
    const directories = expectedDirectories(manifest);
    for (const relativePath of directories) {
      const destination = resolveContainedChild(stagingDir, relativePath);
      await this.filesystem.mkdir(destination, 0o700, signal);
      await this.applyOwnerOnlyPermissions(destination, "directory", signal);
    }
    for (const file of manifest.files) {
      if (!shouldIncludeSkillContentPath(file.path)) throw new SkillHubArtifactStoreError("tampered");
      const sourcePath = resolveContainedChild(sourceDir, file.path);
      const bytes = await this.readVerifiedFile(sourcePath, file.bytes, file.sha256, signal);
      const destinationPath = resolveContainedChild(stagingDir, file.path);
      const handle = await this.filesystem.openExclusive(destinationPath, 0o600, signal);
      try {
        await this.applyOwnerOnlyPermissions(destinationPath, "file", signal);
        const pathStat = await this.safeLstat(destinationPath, signal);
        const handleStat = await handle.stat(signal);
        if (!sameFilesystemIdentity(pathStat, handleStat)) throw new SkillHubArtifactStoreError("unsafe_path");
        await writeAll(handle, bytes, signal);
        await handle.sync(signal);
        const written = await handle.stat(signal);
        if (written.size !== BigInt(bytes.byteLength)) throw new SkillHubArtifactStoreError("tampered");
      } finally {
        await handle.close().catch(() => undefined);
      }
      await this.readVerifiedFile(destinationPath, file.bytes, file.sha256, signal);
    }
  }

  private async readVerifiedFile(
    absolutePath: string,
    expectedBytes: number,
    expectedSha256: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    await this.assertSafeChain(absolutePath, "file", false, signal);
    const before = await this.safeLstat(absolutePath, signal);
    assertSafeStat(before, "file");
    if (before.size !== BigInt(expectedBytes)) throw new SkillHubArtifactStoreError("tampered");
    const handle = await this.filesystem.openReadOnly(absolutePath, signal);
    let bytes: Uint8Array;
    try {
      const opened = await handle.stat(signal);
      if (!sameIdentityAndVersion(before, opened)) throw new SkillHubArtifactStoreError("unsafe_path");
      bytes = new Uint8Array(expectedBytes);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const length = Math.min(64 * 1024, bytes.byteLength - offset);
        const count = await handle.read(bytes, offset, length, offset, signal);
        if (!Number.isSafeInteger(count) || count < 1 || count > length) {
          throw new SkillHubArtifactStoreError("tampered");
        }
        offset += count;
      }
      const afterHandle = await handle.stat(signal);
      if (!sameIdentityAndVersion(before, afterHandle)) throw new SkillHubArtifactStoreError("unsafe_path");
    } finally {
      await handle.close().catch(() => undefined);
    }
    await this.assertSafeChain(absolutePath, "file", false, signal);
    const afterPath = await this.safeLstat(absolutePath, signal);
    if (!sameIdentityAndVersion(before, afterPath) || digestBytes(bytes) !== expectedSha256) {
      throw new SkillHubArtifactStoreError("tampered");
    }
    return bytes;
  }

  private async assertExactDirectory(
    directory: string,
    expected: SkillContentIntegrityManifest,
    signal: AbortSignal,
  ): Promise<void> {
    await this.assertSafeChain(directory, "directory", false, signal);
    const expectedEntries = expectedDirectoryEntries(expected);
    const nodes: OwnedNode[] = [];
    for (const [relativeDirectory, expectedNames] of expectedEntries) {
      const absoluteDirectory = relativeDirectory ? resolveContainedChild(directory, relativeDirectory) : directory;
      await this.applyOwnerOnlyPermissions(absoluteDirectory, "directory", signal);
      const observedNames = (await this.filesystem.readdir(absoluteDirectory, signal)).sort(compareText);
      if (canonicalJsonString(observedNames) !== canonicalJsonString(expectedNames)) {
        throw new SkillHubArtifactStoreError("tampered");
      }
      nodes.push({ absolutePath: absoluteDirectory, stat: await this.safeLstat(absoluteDirectory, signal) });
      for (const name of observedNames) {
        const relativeChild = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        const childPath = resolveContainedChild(directory, relativeChild);
        const expectedKind = expectedEntries.has(relativeChild) ? "directory" : "file";
        const childStat = await this.safeLstat(childPath, signal);
        await this.assertSafeNode(childPath, childStat, expectedKind, signal);
        await this.applyOwnerOnlyPermissions(childPath, expectedKind, signal);
        nodes.push({ absolutePath: childPath, stat: await this.safeLstat(childPath, signal) });
      }
    }
    const observed = await captureSkillContentIntegrity(directory);
    assertSkillHubArtifactManifest(observed);
    if (canonicalJsonString(observed) !== canonicalJsonString(expected)) {
      throw new SkillHubArtifactStoreError("tampered");
    }
    await this.assertTreeNodesUnchanged(nodes, signal);
    await this.assertSafeChain(directory, "directory", false, signal);
  }

  private async captureTreeNodes(root: string, exactArtifact: boolean, signal: AbortSignal): Promise<OwnedNode[]> {
    await this.assertSafeChain(root, "directory", false, signal);
    const queue = [root];
    const nodes: OwnedNode[] = [];
    let entryCount = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentStat = await this.safeLstat(current, signal);
      await this.assertSafeNode(current, currentStat, "directory", signal);
      nodes.push({ absolutePath: current, stat: currentStat });
      for (const name of await this.filesystem.readdir(current, signal)) {
        entryCount += 1;
        if (entryCount > SKILL_CONTENT_INTEGRITY_LIMITS.maxEntries) {
          throw new SkillHubArtifactStoreError("filesystem_error");
        }
        const child = path.join(current, name);
        const relative = path.relative(root, child).split(path.sep).join("/");
        const stat = await this.safeLstat(child, signal);
        const kind = stat.kind;
        if (stat.symbolicLink || stat.reparsePoint || (kind !== "directory" && kind !== "file")) {
          throw new SkillHubArtifactStoreError("unsafe_path");
        }
        await this.assertSafeNode(child, stat, kind, signal);
        nodes.push({ absolutePath: child, stat });
        if (!exactArtifact && !shouldIncludeSkillContentPath(relative)) continue;
        if (kind === "directory") queue.push(child);
      }
    }
    return nodes;
  }

  private async assertTreeNodesUnchanged(nodes: readonly OwnedNode[], signal: AbortSignal): Promise<void> {
    for (const node of nodes) {
      const observed = await this.safeLstat(node.absolutePath, signal);
      await this.assertSafeNode(
        node.absolutePath,
        observed,
        node.stat.kind === "directory" ? "directory" : "file",
        signal,
      );
      if (!sameIdentityAndVersion(node.stat, observed) || node.stat.mode !== observed.mode) {
        throw new SkillHubArtifactStoreError("unsafe_path");
      }
    }
  }

  private async inspectSettlement(
    finalDir: string,
    settlementPath: string,
    manifest: SkillContentIntegrityManifest,
    signal: AbortSignal,
  ): Promise<SettlementState> {
    const settlementStat = await this.tryLstat(settlementPath, signal);
    const finalStat = await this.tryLstat(finalDir, signal);
    if (!settlementStat) return finalStat ? "unsettled" : "absent";
    if (!finalStat) throw new SkillHubArtifactStoreError("tampered");
    const bytes = settlementBytes(manifest);
    await this.applyOwnerOnlyPermissions(settlementPath, "file", signal);
    await this.readVerifiedFile(settlementPath, bytes.byteLength, digestBytes(bytes), signal);
    await this.assertExactDirectory(finalDir, manifest, signal);
    return "settled";
  }

  private async publishSettlement(
    settlementPath: string,
    manifest: SkillContentIntegrityManifest,
    parentDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    const bytes = settlementBytes(manifest);
    const temporaryPath = `${settlementPath}-${this.validatedToken()}.tmp`;
    let temporary: OwnedNode | undefined;
    let temporaryOpenedStat: SkillHubArtifactFilesystemStat | undefined;
    let temporaryCreated = false;
    try {
      const handle = await this.filesystem.openExclusive(temporaryPath, 0o600, signal);
      temporaryCreated = true;
      try {
        temporaryOpenedStat = await handle.stat(signal);
        await this.applyOwnerOnlyPermissions(temporaryPath, "file", signal);
        await writeAll(handle, bytes, signal);
        await handle.sync(signal);
      } finally {
        await handle.close().catch(() => undefined);
      }
      temporary = { absolutePath: temporaryPath, stat: await this.safeLstat(temporaryPath, signal) };
      await this.readVerifiedFile(temporaryPath, bytes.byteLength, digestBytes(bytes), signal);
      let linked = false;
      try {
        await this.filesystem.linkNoReplace(temporaryPath, settlementPath, signal);
        linked = true;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        await this.readVerifiedFile(settlementPath, bytes.byteLength, digestBytes(bytes), signal);
      }
      if (linked) {
        const installed = await this.safeLstat(settlementPath, signal);
        if (!sameFilesystemIdentity(temporary.stat, installed)) {
          throw new SkillHubArtifactStoreError("unsafe_path");
        }
      }
      await this.applyOwnerOnlyPermissions(settlementPath, "file", signal);
      await this.readVerifiedFile(settlementPath, bytes.byteLength, digestBytes(bytes), signal);
      await this.syncManagedDirectory(parentDir, signal);
    } finally {
      if (temporaryCreated && !temporary) {
        const stat = await this.tryLstat(temporaryPath, signal).catch(() => undefined);
        if (stat && temporaryOpenedStat && sameFilesystemIdentity(temporaryOpenedStat, stat)) {
          temporary = { absolutePath: temporaryPath, stat };
        }
      }
      if (temporary) await this.removeOwnedFileIfSafe(temporary, signal);
    }
  }

  private async acquireClaim(
    claimPath: string,
    finalDir: string,
    settlementPath: string,
    manifest: SkillContentIntegrityManifest,
    signal: AbortSignal,
  ): Promise<OwnedNode | undefined> {
    const startedAt = this.nowMs();
    for (;;) {
      const token = this.validatedToken();
      let claimCreated = false;
      let claimOpenedStat: SkillHubArtifactFilesystemStat | undefined;
      try {
        const handle = await this.filesystem.openExclusive(claimPath, 0o600, signal);
        claimCreated = true;
        let writtenStat: SkillHubArtifactFilesystemStat;
        try {
          const openedStat = await handle.stat(signal);
          claimOpenedStat = openedStat;
          await this.applyOwnerOnlyPermissions(claimPath, "file", signal);
          const hardenedPathStat = await this.safeLstat(claimPath, signal);
          if (!sameFilesystemIdentity(openedStat, hardenedPathStat)) {
            throw new SkillHubArtifactStoreError("unsafe_path");
          }
          const claimBytes = Buffer.from(`${token}\n`, "utf8");
          await writeAll(handle, claimBytes, signal);
          await handle.sync(signal);
          writtenStat = await handle.stat(signal);
          if (writtenStat.size !== BigInt(claimBytes.byteLength)) {
            throw new SkillHubArtifactStoreError("filesystem_error");
          }
        } finally {
          await handle.close().catch(() => undefined);
        }
        const claimStat = await this.safeLstat(claimPath, signal);
        if (!sameIdentityAndVersion(writtenStat!, claimStat)) {
          throw new SkillHubArtifactStoreError("unsafe_path");
        }
        await this.syncManagedDirectory(path.dirname(claimPath), signal);
        return { absolutePath: claimPath, stat: claimStat };
      } catch (error) {
        if (claimCreated) {
          const stat = await this.tryLstat(claimPath, signal).catch(() => undefined);
          if (stat && claimOpenedStat && sameFilesystemIdentity(claimOpenedStat, stat)) {
            await this.removeOwnedFileIfSafe({ absolutePath: claimPath, stat }, signal);
          }
          throw error;
        }
        if (!isErrno(error, "EEXIST")) throw error;
      }

      if ((await this.inspectSettlement(finalDir, settlementPath, manifest, signal)) === "settled") {
        return undefined;
      }
      const claimStat = await this.tryLstat(claimPath, signal);
      if (claimStat && this.nowMs() - Number(claimStat.mtimeNs / 1_000_000n) >= this.claimStaleMs) {
        await this.removeOwnedFileIfSafe({ absolutePath: claimPath, stat: claimStat }, signal);
        continue;
      }
      if (this.nowMs() - startedAt >= this.claimWaitMs) {
        throw new SkillHubArtifactStoreError("claim_timeout");
      }
      await this.wait(CLAIM_POLL_MS);
    }
  }

  private async releaseClaim(claim: OwnedNode, signal: AbortSignal): Promise<void> {
    await this.removeOwnedFileIfSafe(claim, signal);
    await this.syncManagedDirectory(path.dirname(claim.absolutePath), signal).catch(() => undefined);
  }

  private async assertOwnedFile(node: OwnedNode, signal: AbortSignal): Promise<void> {
    await this.assertSafeChain(node.absolutePath, "file", false, signal);
    await this.applyOwnerOnlyPermissions(node.absolutePath, "file", signal);
    const observed = await this.safeLstat(node.absolutePath, signal);
    if (!sameIdentityAndVersion(node.stat, observed)) throw new SkillHubArtifactStoreError("unsafe_path");
  }

  private async cleanupStalePublicationTemps(
    parentDir: string,
    treeSha256: string,
    signal: AbortSignal,
  ): Promise<void> {
    const stagingPattern = new RegExp(`^\\.${treeSha256}\\.staging-[a-zA-Z0-9_-]{1,128}$`, "u");
    const settlementPattern = new RegExp(`^\\.${treeSha256}\\.settled-[a-zA-Z0-9_-]{1,128}\\.tmp$`, "u");
    for (const name of await this.filesystem.readdir(parentDir, signal)) {
      const kind = stagingPattern.test(name) ? "directory" : settlementPattern.test(name) ? "file" : undefined;
      if (!kind) continue;
      const absolutePath = path.join(parentDir, name);
      await this.assertSafeChain(absolutePath, kind, false, signal);
      await this.applyOwnerOnlyPermissions(absolutePath, kind, signal);
      const node = { absolutePath, stat: await this.safeLstat(absolutePath, signal) };
      if (kind === "directory") {
        await this.captureTreeNodes(absolutePath, true, signal);
        const beforeRemoval = await this.safeLstat(absolutePath, signal);
        if (!sameIdentityAndVersion(node.stat, beforeRemoval)) {
          throw new SkillHubArtifactStoreError("unsafe_path");
        }
        await this.filesystem.removeTree(absolutePath, signal);
      } else {
        const beforeRemoval = await this.safeLstat(absolutePath, signal);
        if (!sameIdentityAndVersion(node.stat, beforeRemoval)) {
          throw new SkillHubArtifactStoreError("unsafe_path");
        }
        await this.filesystem.unlink(absolutePath, signal);
      }
      if (await this.tryLstat(absolutePath, signal)) throw new SkillHubArtifactStoreError("filesystem_error");
    }
    await this.syncManagedDirectory(parentDir, signal);
  }

  private async removeOwnedFileIfSafe(node: OwnedNode, signal: AbortSignal): Promise<void> {
    try {
      await this.assertSafeChain(node.absolutePath, "file", false, signal);
      const observed = await this.safeLstat(node.absolutePath, signal);
      if (!sameIdentityAndVersion(node.stat, observed)) return;
      await this.filesystem.unlink(node.absolutePath, signal);
    } catch {
      // Fail closed: swapped or unsafe cleanup targets remain for operator inspection.
    }
  }

  private async removeOwnedTreeIfSafe(node: OwnedNode, signal: AbortSignal): Promise<void> {
    try {
      await this.assertSafeChain(node.absolutePath, "directory", false, signal);
      const observed = await this.safeLstat(node.absolutePath, signal);
      if (!sameFilesystemIdentity(node.stat, observed)) return;
      await this.captureTreeNodes(node.absolutePath, true, signal);
      await this.filesystem.removeTree(node.absolutePath, signal);
    } catch {
      // Fail closed: swapped or unsafe cleanup targets remain for operator inspection.
    }
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
    let current = parsed.root;
    await this.assertExistingSafeNode(current, "directory", signal);
    for (const component of path.relative(parsed.root, this.rootDir).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      await this.ensureDirectory(current, sameCanonicalPath(current, this.rootDir), signal);
    }
  }

  private async ensureDirectory(absolutePath: string, harden: boolean, signal: AbortSignal): Promise<void> {
    let stat = await this.tryLstat(absolutePath, signal);
    let created = false;
    if (!stat) {
      try {
        await this.filesystem.mkdir(absolutePath, 0o700, signal);
        created = true;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      stat = await this.safeLstat(absolutePath, signal);
    }
    await this.assertSafeNode(absolutePath, stat, "directory", signal);
    if (harden) await this.applyOwnerOnlyPermissions(absolutePath, "directory", signal);
    if (created) {
      await this.syncManagedDirectory(absolutePath, signal);
      await this.syncManagedDirectory(path.dirname(absolutePath), signal);
    }
  }

  private async applyOwnerOnlyPermissions(
    absolutePath: string,
    kind: "directory" | "file",
    signal: AbortSignal,
  ): Promise<void> {
    if (this.filesystem.ownerOnlyPermissions === "unsupported") {
      throw new SkillHubArtifactStoreError("filesystem_error");
    }
    const mode = kind === "directory" ? 0o700 : 0o600;
    await this.filesystem.chmod(absolutePath, mode, signal);
    const stat = await this.safeLstat(absolutePath, signal);
    await this.assertSafeNode(absolutePath, stat, kind, signal);
    if (this.filesystem.ownerOnlyPermissions === "posix_mode" && Number(stat.mode & 0o777n) !== mode) {
      throw new SkillHubArtifactStoreError("filesystem_error");
    }
  }

  private async syncTreeDirectories(
    root: string,
    manifest: SkillContentIntegrityManifest,
    signal: AbortSignal,
  ): Promise<void> {
    for (const relative of [...expectedDirectories(manifest)].sort((a, b) => b.length - a.length)) {
      await this.syncManagedDirectory(resolveContainedChild(root, relative), signal);
    }
    await this.syncManagedDirectory(root, signal);
  }

  private async syncManagedDirectory(absolutePath: string, signal: AbortSignal): Promise<void> {
    try {
      await this.filesystem.syncDirectory(absolutePath, signal);
    } catch (error) {
      if (!isUnsupportedSync(error)) throw error;
    }
  }

  private async assertSafeChain(
    absoluteTarget: string,
    leafKind: "directory" | "file",
    allowMissingLeaf: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const parsed = path.parse(absoluteTarget);
    let current = parsed.root;
    await this.assertExistingSafeNode(current, "directory", signal);
    const components = path.relative(parsed.root, absoluteTarget).split(path.sep).filter(Boolean);
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]!);
      const kind = index === components.length - 1 ? leafKind : "directory";
      const stat = await this.tryLstat(current, signal);
      if (!stat) {
        if (allowMissingLeaf && index === components.length - 1) return;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      await this.assertSafeNode(current, stat, kind, signal);
    }
  }

  private async captureDirectoryBinding(
    absoluteDirectory: string,
    signal: AbortSignal,
  ): Promise<readonly DirectoryBinding[]> {
    const parsed = path.parse(absoluteDirectory);
    let current = parsed.root;
    const binding: DirectoryBinding[] = [];
    const rootStat = await this.safeLstat(current, signal);
    await this.assertSafeNode(current, rootStat, "directory", signal);
    binding.push({ absolutePath: current, stat: rootStat });
    for (const component of path.relative(parsed.root, absoluteDirectory).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const stat = await this.safeLstat(current, signal);
      await this.assertSafeNode(current, stat, "directory", signal);
      binding.push({ absolutePath: current, stat });
    }
    return binding;
  }

  private async assertDirectoryBinding(binding: readonly DirectoryBinding[], signal: AbortSignal): Promise<void> {
    for (const expected of binding) {
      const observed = await this.safeLstat(expected.absolutePath, signal);
      await this.assertSafeNode(expected.absolutePath, observed, "directory", signal);
      if (!sameFilesystemIdentityAndMode(expected.stat, observed)) {
        throw new SkillHubArtifactStoreError("unsafe_path");
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
    stat: SkillHubArtifactFilesystemStat,
    kind: "directory" | "file",
    signal: AbortSignal,
  ): Promise<void> {
    assertValidStat(stat);
    if (stat.kind !== kind || stat.symbolicLink || stat.reparsePoint) {
      throw new SkillHubArtifactStoreError("unsafe_path");
    }
    const canonicalPath = await this.filesystem.realpath(absolutePath, signal);
    if (!sameCanonicalPath(canonicalPath, absolutePath)) throw new SkillHubArtifactStoreError("unsafe_path");
  }

  private async safeLstat(absolutePath: string, signal: AbortSignal): Promise<SkillHubArtifactFilesystemStat> {
    return this.filesystem.lstat(absolutePath, signal);
  }

  private async tryLstat(
    absolutePath: string,
    signal: AbortSignal,
  ): Promise<SkillHubArtifactFilesystemStat | undefined> {
    try {
      return await this.filesystem.lstat(absolutePath, signal);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private resolveManagedPath(relativePath: string): string {
    if (!relativePath || relativePath.includes("\\") || path.posix.isAbsolute(relativePath)) {
      throw new SkillHubArtifactStoreError("invalid_address");
    }
    const segments = relativePath.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new SkillHubArtifactStoreError("invalid_address");
    }
    const resolved = path.resolve(this.rootDir, ...segments);
    assertContained(this.rootDir, resolved);
    return resolved;
  }

  private validatedToken(): string {
    const token = this.randomToken();
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(token)) throw new SkillHubArtifactStoreError("filesystem_error");
    return token;
  }
}

export interface NodeSkillHubArtifactFilesystemDependencies {
  windowsSecurity?: SkillHubWindowsSecurityPort;
}

export class NodeSkillHubArtifactFilesystem implements SkillHubArtifactFilesystem {
  public readonly ownerOnlyPermissions: SkillHubArtifactFilesystem["ownerOnlyPermissions"];
  private readonly windowsSecurity: SkillHubWindowsSecurityPort | undefined;

  public constructor(dependencies: NodeSkillHubArtifactFilesystemDependencies = {}) {
    this.windowsSecurity =
      dependencies.windowsSecurity ?? (process.platform === "win32" ? new NodeSkillHubWindowsSecurity() : undefined);
    this.ownerOnlyPermissions = this.windowsSecurity ? "windows_acl" : "posix_mode";
  }

  public async lstat(absolutePath: string, signal: AbortSignal): Promise<SkillHubArtifactFilesystemStat> {
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
    const result = await fs.realpath(absolutePath);
    throwIfAborted(signal);
    return result;
  }

  public async readdir(absolutePath: string, signal: AbortSignal): Promise<string[]> {
    throwIfAborted(signal);
    const result = await fs.readdir(absolutePath);
    throwIfAborted(signal);
    return result;
  }

  public async mkdir(absolutePath: string, mode: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await fs.mkdir(absolutePath, { recursive: false, mode });
    throwIfAborted(signal);
  }

  public async chmod(absolutePath: string, mode: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const kind = mode === 0o700 ? "directory" : mode === 0o600 ? "file" : undefined;
    if (!kind) throw new SkillHubArtifactStoreError("filesystem_error");
    const before = await this.lstat(absolutePath, signal);
    assertSafeStat(before, kind);
    if (this.windowsSecurity) {
      await this.windowsSecurity.applyOwnerOnlyAcl(absolutePath, kind, signal);
    } else {
      const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const opened = fromNodeStat(await handle.stat({ bigint: true }));
        if (!sameFilesystemIdentity(before, opened) || opened.kind !== kind) {
          throw new SkillHubArtifactStoreError("unsafe_path");
        }
        await handle.chmod(mode);
        const hardened = fromNodeStat(await handle.stat({ bigint: true }));
        if (
          !sameFilesystemIdentity(before, hardened) ||
          hardened.kind !== kind ||
          Number(hardened.mode & 0o777n) !== mode
        ) {
          throw new SkillHubArtifactStoreError("filesystem_error");
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    const after = await this.lstat(absolutePath, signal);
    if (!sameFilesystemIdentity(before, after) || after.kind !== kind || after.symbolicLink || after.reparsePoint) {
      throw new SkillHubArtifactStoreError("unsafe_path");
    }
  }

  public openExclusive(absolutePath: string, mode: number, signal: AbortSignal): Promise<SkillHubArtifactFileHandle> {
    const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    return this.openHandle(
      absolutePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollow,
      mode,
      signal,
    );
  }

  public openReadOnly(absolutePath: string, signal: AbortSignal): Promise<SkillHubArtifactFileHandle> {
    const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    return this.openHandle(absolutePath, fsConstants.O_RDONLY | noFollow, 0o600, signal);
  }

  public async renameDirectory(sourcePath: string, destinationPath: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await fs.rename(sourcePath, destinationPath);
    throwIfAborted(signal);
  }

  public async linkNoReplace(sourcePath: string, destinationPath: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await fs.link(sourcePath, destinationPath);
    throwIfAborted(signal);
  }

  public async unlink(absolutePath: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await fs.unlink(absolutePath);
    throwIfAborted(signal);
  }

  public async removeTree(absolutePath: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await fs.rm(absolutePath, { recursive: true, force: false });
    throwIfAborted(signal);
  }

  public async syncDirectory(absolutePath: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
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
  ): Promise<SkillHubArtifactFileHandle> {
    throwIfAborted(signal);
    const handle = await fs.open(absolutePath, flags, mode);
    if (signal.aborted) {
      await handle.close().catch(() => undefined);
      throw new SkillHubArtifactStoreError("filesystem_error");
    }
    return {
      stat: async (operationSignal) => {
        throwIfAborted(operationSignal);
        return fromNodeStat(await handle.stat({ bigint: true }));
      },
      read: async (buffer, offset, length, position, operationSignal) => {
        throwIfAborted(operationSignal);
        return (await handle.read(buffer, offset, length, position)).bytesRead;
      },
      write: async (buffer, offset, length, position, operationSignal) => {
        throwIfAborted(operationSignal);
        return (await handle.write(buffer, offset, length, position)).bytesWritten;
      },
      sync: async (operationSignal) => {
        throwIfAborted(operationSignal);
        await handle.sync();
      },
      close: () => handle.close(),
    };
  }
}

function expectedDirectories(manifest: SkillContentIntegrityManifest): string[] {
  const directories = new Set<string>();
  for (const file of manifest.files) {
    const segments = file.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return [...directories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || compareText(left, right);
  });
}

function assertPortableManifestPaths(manifest: SkillContentIntegrityManifest): void {
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const file of manifest.files) {
    const relativePath = file.path;
    const segments = relativePath.split("/");
    if (
      relativePath.length > 4_096 ||
      relativePath !== relativePath.normalize("NFKC") ||
      segments.some(
        (segment) =>
          !segment ||
          segment.length > 255 ||
          containsAsciiControlCharacter(segment) ||
          segment.includes(":") ||
          /[. ]$/u.test(segment) ||
          segment.toLowerCase() === ".git" ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment),
      )
    ) {
      throw new SkillHubArtifactStoreError("unsafe_path");
    }
    const fileKey = relativePath.toLowerCase();
    if (files.has(fileKey) || directories.has(fileKey)) throw new SkillHubArtifactStoreError("unsafe_path");
    files.add(fileKey);
    for (let index = 1; index < segments.length; index += 1) {
      const directoryKey = segments.slice(0, index).join("/").toLowerCase();
      if (files.has(directoryKey)) throw new SkillHubArtifactStoreError("unsafe_path");
      directories.add(directoryKey);
    }
  }
}

function expectedDirectoryEntries(manifest: SkillContentIntegrityManifest): Map<string, string[]> {
  const entries = new Map<string, Set<string>>([["", new Set<string>()]]);
  for (const directory of expectedDirectories(manifest)) {
    entries.set(directory, new Set<string>());
    const segments = directory.split("/");
    const parent = segments.slice(0, -1).join("/");
    entries.get(parent)!.add(segments.at(-1)!);
  }
  for (const file of manifest.files) {
    const segments = file.path.split("/");
    const parent = segments.slice(0, -1).join("/");
    entries.get(parent)!.add(segments.at(-1)!);
  }
  return new Map([...entries].map(([directory, names]) => [directory, [...names].sort(compareText)]));
}

function settlementBytes(manifest: SkillContentIntegrityManifest): Uint8Array {
  const record: SettlementRecord = {
    manifestVersion: SETTLEMENT_VERSION,
    manifestSha256: manifestDigest(manifest),
    treeSha256: manifest.treeSha256,
  };
  return Buffer.from(`${canonicalJsonString(record)}\n`, "utf8");
}

function manifestDigest(manifest: SkillContentIntegrityManifest): string {
  return createHash("sha256").update(canonicalJsonString(manifest), "utf8").digest("hex");
}

function resolveContainedChild(root: string, relativePath: string): string {
  const resolved = path.resolve(root, ...relativePath.split("/"));
  assertContained(root, resolved);
  return resolved;
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SkillHubArtifactStoreError("unsafe_path");
  }
}

function assertSafeComponent(value: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new SkillHubArtifactStoreError("unsafe_path");
  }
}

function assertSafeStat(stat: SkillHubArtifactFilesystemStat, kind: "directory" | "file"): void {
  assertValidStat(stat);
  if (stat.kind !== kind || stat.symbolicLink || stat.reparsePoint) {
    throw new SkillHubArtifactStoreError("unsafe_path");
  }
}

function assertValidStat(stat: SkillHubArtifactFilesystemStat): void {
  if (
    !stat ||
    !["directory", "file", "other"].includes(stat.kind) ||
    typeof stat.symbolicLink !== "boolean" ||
    typeof stat.reparsePoint !== "boolean" ||
    [stat.device, stat.inode, stat.size, stat.mtimeNs, stat.birthtimeNs, stat.mode].some(
      (value) => typeof value !== "bigint" || value < 0n,
    )
  ) {
    throw new SkillHubArtifactStoreError("filesystem_error");
  }
}

function sameFilesystemIdentity(left: SkillHubArtifactFilesystemStat, right: SkillHubArtifactFilesystemStat): boolean {
  return (
    left.kind === right.kind &&
    left.symbolicLink === right.symbolicLink &&
    left.reparsePoint === right.reparsePoint &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameIdentityAndVersion(left: SkillHubArtifactFilesystemStat, right: SkillHubArtifactFilesystemStat): boolean {
  return sameFilesystemIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function sameFilesystemIdentityAndMode(
  left: SkillHubArtifactFilesystemStat,
  right: SkillHubArtifactFilesystemStat,
): boolean {
  return sameFilesystemIdentity(left, right) && left.mode === right.mode;
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = normalizeExtendedPath(path.resolve(left));
  const normalizedRight = normalizeExtendedPath(path.resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function normalizeExtendedPath(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function fromNodeStat(
  stat: Awaited<ReturnType<typeof fs.lstat>> & { size: bigint },
  reparsePoint = stat.isSymbolicLink(),
): SkillHubArtifactFilesystemStat {
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

async function writeAll(handle: SkillHubArtifactFileHandle, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const length = Math.min(64 * 1024, bytes.byteLength - offset);
    const count = await handle.write(bytes, offset, length, offset, signal);
    if (!Number.isSafeInteger(count) || count < 1 || count > length) {
      throw new SkillHubArtifactStoreError("filesystem_error");
    }
    offset += count;
  }
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10 * 60_000) {
    throw new TypeError("Skill Hub artifact duration is invalid.");
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mapArtifactError(error: unknown): SkillHubArtifactStoreError {
  if (error instanceof SkillHubArtifactStoreError) return error;
  if (isErrno(error, "ELOOP")) return new SkillHubArtifactStoreError("unsafe_path");
  return new SkillHubArtifactStoreError("filesystem_error");
}

function isUnsupportedSync(error: unknown): boolean {
  return ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EINVAL", "EISDIR"].some((code) => isErrno(error, code));
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === code;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SkillHubArtifactStoreError("filesystem_error");
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}
