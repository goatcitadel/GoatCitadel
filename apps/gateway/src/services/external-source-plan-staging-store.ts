import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  EXTERNAL_SOURCE_LIMITS,
  assertExternalSourceImportPlan,
  canonicalJsonString,
  type ExternalSourceAdapterId,
  type ExternalSourceImportPlan,
} from "@goatcitadel/contracts";
import {
  ExternalSourceArtifactStore,
  ExternalSourceArtifactStoreError,
  NodeExternalSourceArtifactFilesystem,
  type ExternalSourceArtifactFilesystem,
} from "./external-source-artifact-store.js";
import type { ExternalSourceFilesystemStat } from "./external-source-reader.js";
import type { ExternalSourceWindowsSecurityPort } from "./external-source-windows-security.js";

const STAGING_SCHEMA_VERSION = "goatcitadel.external-source-staging.v1" as const;
const MANIFEST_NAME = "manifest.json";
const MAX_MANIFEST_BYTES = EXTERNAL_SOURCE_LIMITS.canonicalJsonBytes;
const LEASE_ID = /^[a-zA-Z0-9_-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type ExternalSourcePlanStagingStoreErrorCode =
  | "cancelled"
  | "conflict"
  | "expired"
  | "filesystem_error"
  | "invalid_lease"
  | "missing"
  | "tampered";

export class ExternalSourcePlanStagingStoreError extends Error {
  public constructor(public readonly code: ExternalSourcePlanStagingStoreErrorCode) {
    super(`External source plan staging ${code.replaceAll("_", " ")}.`);
    this.name = "ExternalSourcePlanStagingStoreError";
  }
}

export interface ExternalSourceStagedItemInput {
  itemId: string;
  ordinal: number;
  adapterId: ExternalSourceAdapterId;
  adapterVersion: string;
  producerVersion?: string;
  rawSha256: string;
  rawByteCount: number;
  normalizedArtifactSha256: string;
  normalizedByteCount: number;
  normalizedBytes: Uint8Array;
}

export interface ExternalSourceStagingManifestItem extends Omit<ExternalSourceStagedItemInput, "normalizedBytes"> {
  artifactRelPath: string;
}

export interface ExternalSourceStagingManifest {
  schemaVersion: typeof STAGING_SCHEMA_VERSION;
  leaseId: string;
  workspaceId: string;
  sourceId: string;
  scanId: string;
  planId: string;
  planSha256: string;
  selectedItemSetSha256: string;
  rawSetSha256: string;
  normalizedSetSha256: string;
  expiresAt: string;
  items: ExternalSourceStagingManifestItem[];
}

export interface ExternalSourceStagedLease {
  manifest: ExternalSourceStagingManifest;
  items: Array<ExternalSourceStagingManifestItem & { normalizedBytes: Uint8Array }>;
}

interface ExternalSourcePlanStagingStoreDependencies {
  filesystem?: ExternalSourceArtifactFilesystem;
  windowsSecurity?: ExternalSourceWindowsSecurityPort;
  randomToken?: () => string;
  nowMs?: () => number;
  artifactStoreFactory?: (rootDir: string) => ExternalSourceArtifactStore;
}

interface ExternalSourceStagingDirectoryBinding {
  absolutePath: string;
  stat: ExternalSourceFilesystemStat;
}

export class ExternalSourcePlanStagingStore {
  private readonly rootDir: string;
  private readonly leasesDir: string;
  private readonly filesystem: ExternalSourceArtifactFilesystem;
  private readonly randomToken: () => string;
  private readonly nowMs: () => number;
  private readonly artifactStoreFactory: (rootDir: string) => ExternalSourceArtifactStore;

  public constructor(rootDir: string, dependencies: ExternalSourcePlanStagingStoreDependencies = {}) {
    if (typeof rootDir !== "string" || !rootDir.trim()) {
      throw new TypeError("External source staging root is required.");
    }
    this.rootDir = path.resolve(rootDir);
    if (this.rootDir === path.parse(this.rootDir).root) {
      throw new TypeError("External source staging cannot use a filesystem root.");
    }
    this.leasesDir = path.join(this.rootDir, "leases");
    this.filesystem =
      dependencies.filesystem ??
      new NodeExternalSourceArtifactFilesystem({ windowsSecurity: dependencies.windowsSecurity });
    this.randomToken = dependencies.randomToken ?? randomUUID;
    this.nowMs = dependencies.nowMs ?? (() => Date.now());
    this.artifactStoreFactory =
      dependencies.artifactStoreFactory ??
      ((leaseRoot) =>
        new ExternalSourceArtifactStore(leaseRoot, {
          filesystem: this.filesystem,
          randomToken: this.randomToken,
        }));
  }

  public async stage(input: {
    plan: ExternalSourceImportPlan;
    items: readonly ExternalSourceStagedItemInput[];
    signal: AbortSignal;
  }): Promise<ExternalSourceStagingManifest> {
    assertAbortSignal(input.signal);
    assertExternalSourceImportPlan(input.plan);
    const items = validateStagedItems(input.plan, input.items);
    throwIfAborted(input.signal);
    const leaseRoot = this.resolveLeaseRoot(input.plan.stagingLeaseId);
    const store = this.artifactStoreFactory(leaseRoot);
    const manifestItems: ExternalSourceStagingManifestItem[] = [];
    for (const item of items) {
      throwIfAborted(input.signal);
      let published;
      try {
        published = await store.publish({
          bytes: item.normalizedBytes,
          expectedSha256: item.normalizedArtifactSha256,
          signal: input.signal,
        });
      } catch (error) {
        throw mapStagingError(error);
      }
      if (
        published.artifactSha256 !== item.normalizedArtifactSha256 ||
        published.byteCount !== item.normalizedByteCount
      ) {
        throw new ExternalSourcePlanStagingStoreError("tampered");
      }
      const { normalizedBytes: _normalizedBytes, ...metadata } = item;
      manifestItems.push({ ...metadata, artifactRelPath: published.artifactRelPath });
    }
    const directoryBinding = await this.captureDirectoryBinding(leaseRoot, input.signal);
    await this.hardenManagedDirectories(directoryBinding, input.signal);
    await this.assertDirectoryBinding(directoryBinding, input.signal);
    const manifest: ExternalSourceStagingManifest = {
      schemaVersion: STAGING_SCHEMA_VERSION,
      leaseId: input.plan.stagingLeaseId,
      workspaceId: input.plan.workspaceId,
      sourceId: input.plan.sourceId,
      scanId: input.plan.scanId,
      planId: input.plan.planId,
      planSha256: input.plan.planSha256,
      selectedItemSetSha256: input.plan.selectedItemSetSha256,
      rawSetSha256: input.plan.rawSetSha256,
      normalizedSetSha256: input.plan.normalizedSetSha256,
      expiresAt: input.plan.stagingExpiresAt,
      items: manifestItems,
    };
    validateManifest(manifest);
    return this.writeManifest(leaseRoot, manifest, directoryBinding, input.signal);
  }

  public async read(input: {
    plan: ExternalSourceImportPlan;
    signal: AbortSignal;
  }): Promise<ExternalSourceStagedLease> {
    assertAbortSignal(input.signal);
    assertExternalSourceImportPlan(input.plan);
    if (this.nowMs() > Date.parse(input.plan.stagingExpiresAt)) {
      throw new ExternalSourcePlanStagingStoreError("expired");
    }
    const leaseRoot = this.resolveLeaseRoot(input.plan.stagingLeaseId);
    const directoryBinding = await this.captureDirectoryBinding(leaseRoot, input.signal);
    await this.hardenManagedDirectories(directoryBinding, input.signal);
    const manifest = await this.readManifest(leaseRoot, directoryBinding, input.signal);
    assertManifestBindsPlan(manifest, input.plan);
    if (this.nowMs() > Date.parse(manifest.expiresAt)) {
      throw new ExternalSourcePlanStagingStoreError("expired");
    }
    const store = this.artifactStoreFactory(leaseRoot);
    const items = [] as ExternalSourceStagedLease["items"];
    for (const item of manifest.items) {
      const read = await store.read({
        artifactRelPath: item.artifactRelPath,
        expectedSha256: item.normalizedArtifactSha256,
        signal: input.signal,
      });
      await this.assertDirectoryBinding(directoryBinding, input.signal);
      if (read.byteCount !== item.normalizedByteCount) {
        throw new ExternalSourcePlanStagingStoreError("tampered");
      }
      items.push({ ...item, normalizedBytes: read.bytes });
    }
    return { manifest, items };
  }

  public async discard(leaseId: string): Promise<void> {
    const leaseRoot = this.resolveLeaseRoot(leaseId);
    const signal = new AbortController().signal;
    try {
      const directoryBinding = await this.captureDirectoryBinding(leaseRoot, signal);
      await this.hardenManagedDirectories(directoryBinding, signal);
      await this.assertDirectoryBinding(directoryBinding, signal);
      await this.removeOwnedTree(leaseRoot, directoryBinding, signal);
    } catch (error) {
      const mapped = mapStagingError(error);
      if (mapped.code !== "missing") throw mapped;
    }
  }

  public async cleanupExpired(input: { nowMs?: number; orphanGraceMs?: number } = {}): Promise<number> {
    const nowMs = input.nowMs ?? this.nowMs();
    const orphanGraceMs = input.orphanGraceMs ?? 60 * 60 * 1000;
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(orphanGraceMs) || orphanGraceMs < 0) {
      throw new TypeError("External source staging cleanup bounds are invalid.");
    }
    const signal = new AbortController().signal;
    let entries: string[];
    let leasesBinding: readonly ExternalSourceStagingDirectoryBinding[];
    try {
      leasesBinding = await this.captureDirectoryBinding(this.leasesDir, signal);
      await this.hardenManagedDirectories(leasesBinding, signal);
      entries = await fs.readdir(this.leasesDir);
      await this.assertDirectoryBinding(leasesBinding, signal);
    } catch (error) {
      const mapped = mapStagingError(error);
      if (mapped.code === "missing") return 0;
      throw mapped;
    }
    let removed = 0;
    for (const leaseId of entries.sort()) {
      if (!LEASE_ID.test(leaseId)) continue;
      await this.assertDirectoryBinding(leasesBinding, signal);
      const leaseRoot = this.resolveLeaseRoot(leaseId);
      let leaseBinding: readonly ExternalSourceStagingDirectoryBinding[];
      try {
        leaseBinding = await this.captureDirectoryBinding(leaseRoot, signal);
        await this.hardenManagedDirectories(leaseBinding, signal);
        await this.assertDirectoryBinding(leaseBinding, signal);
      } catch (error) {
        const mapped = mapStagingError(error);
        if (mapped.code === "missing") continue;
        throw mapped;
      }
      let remove: boolean;
      try {
        const manifest = await this.readManifest(leaseRoot, leaseBinding, signal);
        remove = Date.parse(manifest.expiresAt) <= nowMs;
      } catch (error) {
        if (!(error instanceof ExternalSourcePlanStagingStoreError) || error.code === "cancelled") throw error;
        await this.assertDirectoryBinding(leasesBinding, signal);
        await this.assertDirectoryBinding(leaseBinding, signal);
        const leaseStat = leaseBinding.at(-1)?.stat;
        if (!leaseStat) throw new ExternalSourcePlanStagingStoreError("tampered");
        remove = nowMs - Number(leaseStat.mtimeNs / 1_000_000n) >= orphanGraceMs;
      }
      if (remove) {
        await this.assertDirectoryBinding(leasesBinding, signal);
        await this.removeOwnedTree(leaseRoot, leaseBinding, signal);
        await this.assertDirectoryBinding(leasesBinding, signal);
        removed += 1;
      }
    }
    return removed;
  }

  private resolveLeaseRoot(leaseId: string): string {
    if (typeof leaseId !== "string" || !LEASE_ID.test(leaseId)) {
      throw new ExternalSourcePlanStagingStoreError("invalid_lease");
    }
    const resolved = path.resolve(this.leasesDir, leaseId);
    if (path.dirname(resolved) !== this.leasesDir) {
      throw new ExternalSourcePlanStagingStoreError("invalid_lease");
    }
    return resolved;
  }

  private async writeManifest(
    leaseRoot: string,
    manifest: ExternalSourceStagingManifest,
    directoryBinding: readonly ExternalSourceStagingDirectoryBinding[],
    signal: AbortSignal,
  ): Promise<ExternalSourceStagingManifest> {
    const bytes = Buffer.from(canonicalJsonString(manifest), "utf8");
    if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new ExternalSourcePlanStagingStoreError("tampered");
    await this.assertDirectoryBinding(directoryBinding, signal);
    await this.filesystem.chmod(leaseRoot, 0o700, signal);
    await this.assertDirectoryBinding(directoryBinding, signal);
    const finalPath = path.join(leaseRoot, MANIFEST_NAME);
    const token = this.randomToken();
    if (!LEASE_ID.test(token)) throw new ExternalSourcePlanStagingStoreError("filesystem_error");
    const temporaryPath = path.join(leaseRoot, `.manifest.tmp-${token}`);
    let temporaryExists = false;
    let temporaryStat: ExternalSourceFilesystemStat | undefined;
    try {
      await this.assertDirectoryBinding(directoryBinding, signal);
      const handle = await this.filesystem.openExclusive(temporaryPath, 0o600, signal);
      temporaryExists = true;
      try {
        temporaryStat = await handle.stat(signal);
        assertSafeFile(temporaryStat);
        await this.filesystem.chmod(temporaryPath, 0o600, signal);
        await this.assertDirectoryBinding(directoryBinding, signal);
        let offset = 0;
        while (offset < bytes.byteLength) {
          throwIfAborted(signal);
          const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset, signal);
          if (!Number.isSafeInteger(written) || written < 1) {
            throw new ExternalSourcePlanStagingStoreError("filesystem_error");
          }
          offset += written;
        }
        await handle.sync(signal);
        const writtenStat = await handle.stat(signal);
        if (!sameFilesystemIdentity(temporaryStat, writtenStat) || writtenStat.size !== BigInt(bytes.byteLength)) {
          throw new ExternalSourcePlanStagingStoreError("tampered");
        }
        temporaryStat = writtenStat;
      } finally {
        await handle.close().catch(() => undefined);
      }
      await this.assertDirectoryBinding(directoryBinding, signal);
      const closedTemporaryStat = await this.safeLstat(temporaryPath, signal);
      if (!temporaryStat || !sameIdentityAndVersion(temporaryStat, closedTemporaryStat)) {
        throw new ExternalSourcePlanStagingStoreError("tampered");
      }
      try {
        await this.assertDirectoryBinding(directoryBinding, signal);
        await this.filesystem.atomicRenameNoReplace(temporaryPath, finalPath, signal);
        temporaryExists = false;
        await this.assertDirectoryBinding(directoryBinding, signal);
      } catch {
        await this.assertDirectoryBinding(directoryBinding, signal);
        const existing = await this.readManifest(leaseRoot, directoryBinding, signal);
        if (canonicalJsonString(existing) !== canonicalJsonString(manifest)) {
          throw new ExternalSourcePlanStagingStoreError("conflict");
        }
        return existing;
      }
      await this.assertDirectoryBinding(directoryBinding, signal);
      await this.filesystem.syncDirectory(leaseRoot, signal);
      await this.assertDirectoryBinding(directoryBinding, signal);
      await this.filesystem.chmod(finalPath, 0o600, signal);
      await this.assertDirectoryBinding(directoryBinding, signal);
      return await this.readManifest(leaseRoot, directoryBinding, signal);
    } catch (error) {
      throw mapStagingError(error);
    } finally {
      if (temporaryExists && temporaryStat) {
        await this.removeTemporaryIfBound(temporaryPath, temporaryStat, directoryBinding);
      }
    }
  }

  private async readManifest(
    leaseRoot: string,
    directoryBinding: readonly ExternalSourceStagingDirectoryBinding[],
    signal: AbortSignal,
  ): Promise<ExternalSourceStagingManifest> {
    throwIfAborted(signal);
    const manifestPath = path.join(leaseRoot, MANIFEST_NAME);
    try {
      await this.assertDirectoryBinding(directoryBinding, signal);
      await this.filesystem.chmod(leaseRoot, 0o700, signal);
      await this.assertDirectoryBinding(directoryBinding, signal);
      await this.filesystem.chmod(manifestPath, 0o600, signal);
      await this.assertDirectoryBinding(directoryBinding, signal);
      const stat = await this.safeLstat(manifestPath, signal);
      await this.assertSafeNode(manifestPath, stat, "file", signal);
      if (stat.size > BigInt(MAX_MANIFEST_BYTES)) {
        throw new ExternalSourcePlanStagingStoreError("tampered");
      }
      const handle = await this.filesystem.openReadOnly(manifestPath, signal);
      let bytes: Uint8Array;
      try {
        const opened = await handle.stat(signal);
        if (!sameIdentityAndVersion(stat, opened)) {
          throw new ExternalSourcePlanStagingStoreError("tampered");
        }
        bytes = new Uint8Array(Number(stat.size));
        let offset = 0;
        while (offset < bytes.byteLength) {
          const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset, signal);
          if (!Number.isSafeInteger(read) || read < 1) throw new ExternalSourcePlanStagingStoreError("tampered");
          offset += read;
        }
        const afterHandle = await handle.stat(signal);
        if (!sameIdentityAndVersion(stat, afterHandle)) {
          throw new ExternalSourcePlanStagingStoreError("tampered");
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      await this.assertDirectoryBinding(directoryBinding, signal);
      const afterPath = await this.safeLstat(manifestPath, signal);
      if (!sameIdentityAndVersion(stat, afterPath)) throw new ExternalSourcePlanStagingStoreError("tampered");
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
      validateManifest(parsed);
      if (canonicalJsonString(parsed) !== Buffer.from(bytes).toString("utf8")) {
        throw new ExternalSourcePlanStagingStoreError("tampered");
      }
      await this.assertDirectoryBinding(directoryBinding, signal);
      return parsed;
    } catch (error) {
      throw mapStagingError(error);
    }
  }

  private async removeOwnedTree(
    leaseRoot: string,
    directoryBinding: readonly ExternalSourceStagingDirectoryBinding[],
    signal: AbortSignal,
  ): Promise<void> {
    if (!isContained(this.leasesDir, leaseRoot)) throw new ExternalSourcePlanStagingStoreError("invalid_lease");
    await this.assertDirectoryBinding(directoryBinding, signal);
    await this.removeOwnedEntry(leaseRoot, directoryBinding, signal, true);
  }

  private async removeOwnedEntry(
    absolutePath: string,
    leaseBinding: readonly ExternalSourceStagingDirectoryBinding[],
    signal: AbortSignal,
    isLeaseRoot = false,
  ): Promise<void> {
    if (!isContained(this.leasesDir, absolutePath)) throw new ExternalSourcePlanStagingStoreError("invalid_lease");
    await this.assertDirectoryBinding(leaseBinding, signal);
    const stat = await this.safeLstat(absolutePath, signal);
    await this.assertSafeNode(absolutePath, stat, stat.kind === "directory" ? "directory" : "file", signal);
    if (stat.kind === "directory") {
      const entries = await fs.readdir(absolutePath);
      await this.assertDirectoryBinding(leaseBinding, signal);
      await this.assertNodeIdentity(absolutePath, stat, "directory", signal);
      for (const entry of entries.sort()) {
        assertSafeTreeEntry(entry);
        await this.removeOwnedEntry(path.join(absolutePath, entry), leaseBinding, signal);
      }
      await this.assertDirectoryBinding(leaseBinding, signal);
      await this.assertNodeIdentity(absolutePath, stat, "directory", signal);
      await fs.rmdir(absolutePath);
      const retainedBinding = isLeaseRoot ? leaseBinding.slice(0, -1) : leaseBinding;
      await this.assertDirectoryBinding(retainedBinding, signal);
      return;
    }
    if (stat.kind !== "file") throw new ExternalSourcePlanStagingStoreError("tampered");
    await this.assertDirectoryBinding(leaseBinding, signal);
    await this.assertNodeIdentity(absolutePath, stat, "file", signal);
    await fs.unlink(absolutePath);
    await this.assertDirectoryBinding(leaseBinding, signal);
  }

  private async captureDirectoryBinding(
    absoluteDirectory: string,
    signal: AbortSignal,
  ): Promise<readonly ExternalSourceStagingDirectoryBinding[]> {
    if (!isContainedOrEqual(this.rootDir, absoluteDirectory)) {
      throw new ExternalSourcePlanStagingStoreError("invalid_lease");
    }
    const parsed = path.parse(absoluteDirectory);
    const components = path.relative(parsed.root, absoluteDirectory).split(path.sep).filter(Boolean);
    const binding: ExternalSourceStagingDirectoryBinding[] = [];
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
    binding: readonly ExternalSourceStagingDirectoryBinding[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const expected of binding) {
      const observed = await this.safeLstat(expected.absolutePath, signal);
      await this.assertSafeNode(expected.absolutePath, observed, "directory", signal);
      if (!sameFilesystemIdentity(expected.stat, observed)) {
        throw new ExternalSourcePlanStagingStoreError("tampered");
      }
    }
  }

  private async hardenManagedDirectories(
    binding: readonly ExternalSourceStagingDirectoryBinding[],
    signal: AbortSignal,
  ): Promise<void> {
    if (this.filesystem.ownerOnlyPermissions === "unsupported") {
      throw new ExternalSourcePlanStagingStoreError("filesystem_error");
    }
    for (const managedPath of [this.rootDir, this.leasesDir, binding.at(-1)?.absolutePath]) {
      if (!managedPath || !isContainedOrEqual(this.rootDir, managedPath)) continue;
      await this.assertDirectoryBinding(binding, signal);
      try {
        await this.filesystem.chmod(managedPath, 0o700, signal);
      } catch (error) {
        throw mapStagingError(error);
      }
      const hardened = await this.safeLstat(managedPath, signal);
      await this.assertSafeNode(managedPath, hardened, "directory", signal);
      if (this.filesystem.ownerOnlyPermissions === "posix_mode" && Number(hardened.mode & 0o777n) !== 0o700) {
        throw new ExternalSourcePlanStagingStoreError("filesystem_error");
      }
    }
    await this.assertDirectoryBinding(binding, signal);
  }

  private async assertSafeNode(
    absolutePath: string,
    stat: ExternalSourceFilesystemStat,
    kind: "directory" | "file",
    signal: AbortSignal,
  ): Promise<void> {
    assertValidStat(stat);
    if (stat.kind !== kind || stat.symbolicLink || stat.reparsePoint) {
      throw new ExternalSourcePlanStagingStoreError("tampered");
    }
    let canonical: string;
    try {
      canonical = await this.filesystem.realpath(absolutePath, signal);
    } catch (error) {
      throw mapStagingError(error);
    }
    if (!samePath(canonical, absolutePath)) throw new ExternalSourcePlanStagingStoreError("tampered");
  }

  private async assertNodeIdentity(
    absolutePath: string,
    expected: ExternalSourceFilesystemStat,
    kind: "directory" | "file",
    signal: AbortSignal,
  ): Promise<void> {
    const observed = await this.safeLstat(absolutePath, signal);
    await this.assertSafeNode(absolutePath, observed, kind, signal);
    const unchanged =
      kind === "directory" ? sameFilesystemIdentity(expected, observed) : sameIdentityAndVersion(expected, observed);
    if (!unchanged) throw new ExternalSourcePlanStagingStoreError("tampered");
  }

  private async safeLstat(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceFilesystemStat> {
    try {
      return await this.filesystem.lstat(absolutePath, signal);
    } catch (error) {
      throw mapStagingError(error);
    }
  }

  private async removeTemporaryIfBound(
    temporaryPath: string,
    expected: ExternalSourceFilesystemStat,
    directoryBinding: readonly ExternalSourceStagingDirectoryBinding[],
  ): Promise<void> {
    const cleanupSignal = new AbortController().signal;
    try {
      await this.assertDirectoryBinding(directoryBinding, cleanupSignal);
      await this.assertNodeIdentity(temporaryPath, expected, "file", cleanupSignal);
      await this.filesystem.unlink(temporaryPath, cleanupSignal);
      await this.assertDirectoryBinding(directoryBinding, cleanupSignal);
    } catch {
      // Fail closed: leave an untrusted or swapped temporary path for operator cleanup.
    }
  }
}

function validateStagedItems(
  plan: ExternalSourceImportPlan,
  input: readonly ExternalSourceStagedItemInput[],
): ExternalSourceStagedItemInput[] {
  if (!Array.isArray(input) || input.length !== plan.selectedItemIds.length) {
    throw new ExternalSourcePlanStagingStoreError("invalid_lease");
  }
  return input.map((item, ordinal) => {
    if (
      !item ||
      item.ordinal !== ordinal ||
      item.itemId !== plan.selectedItemIds[ordinal] ||
      !(item.normalizedBytes instanceof Uint8Array) ||
      item.normalizedBytes.byteLength !== item.normalizedByteCount ||
      !SHA256.test(item.rawSha256) ||
      !SHA256.test(item.normalizedArtifactSha256)
    ) {
      throw new ExternalSourcePlanStagingStoreError("invalid_lease");
    }
    return { ...item, normalizedBytes: new Uint8Array(item.normalizedBytes) };
  });
}

function validateManifest(value: unknown): asserts value is ExternalSourceStagingManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalSourcePlanStagingStoreError("tampered");
  }
  const manifest = value as ExternalSourceStagingManifest;
  const expectedKeys = [
    "schemaVersion",
    "leaseId",
    "workspaceId",
    "sourceId",
    "scanId",
    "planId",
    "planSha256",
    "selectedItemSetSha256",
    "rawSetSha256",
    "normalizedSetSha256",
    "expiresAt",
    "items",
  ];
  if (
    Object.keys(manifest).sort().join("\0") !== expectedKeys.sort().join("\0") ||
    manifest.schemaVersion !== STAGING_SCHEMA_VERSION ||
    !LEASE_ID.test(manifest.leaseId) ||
    !isIdentifier(manifest.workspaceId) ||
    !isIdentifier(manifest.sourceId) ||
    !isIdentifier(manifest.scanId) ||
    !isIdentifier(manifest.planId) ||
    !SHA256.test(manifest.planSha256) ||
    !SHA256.test(manifest.selectedItemSetSha256) ||
    !SHA256.test(manifest.rawSetSha256) ||
    !SHA256.test(manifest.normalizedSetSha256) ||
    !isIso(manifest.expiresAt) ||
    !Array.isArray(manifest.items) ||
    manifest.items.length < 1 ||
    manifest.items.length > EXTERNAL_SOURCE_LIMITS.selectedItemsPerImport
  ) {
    throw new ExternalSourcePlanStagingStoreError("tampered");
  }
  for (const [ordinal, item] of manifest.items.entries()) {
    const keys = [
      "itemId",
      "ordinal",
      "adapterId",
      "adapterVersion",
      "producerVersion",
      "rawSha256",
      "rawByteCount",
      "normalizedArtifactSha256",
      "normalizedByteCount",
      "artifactRelPath",
    ];
    const optional = new Set(["producerVersion"]);
    if (
      !item ||
      Object.keys(item).some((key) => !keys.includes(key)) ||
      keys.some((key) => !optional.has(key) && !Object.hasOwn(item, key)) ||
      item.ordinal !== ordinal ||
      !isIdentifier(item.itemId) ||
      !isIdentifier(item.adapterVersion) ||
      (item.producerVersion !== undefined && !isIdentifier(item.producerVersion)) ||
      !SHA256.test(item.rawSha256) ||
      !SHA256.test(item.normalizedArtifactSha256) ||
      !Number.isSafeInteger(item.rawByteCount) ||
      item.rawByteCount < 0 ||
      !Number.isSafeInteger(item.normalizedByteCount) ||
      item.normalizedByteCount < 0 ||
      item.normalizedByteCount > EXTERNAL_SOURCE_LIMITS.normalizedSessionArtifactBytes ||
      item.artifactRelPath !== `external-sources/sha256/${item.normalizedArtifactSha256}`
    ) {
      throw new ExternalSourcePlanStagingStoreError("tampered");
    }
  }
}

function assertManifestBindsPlan(manifest: ExternalSourceStagingManifest, plan: ExternalSourceImportPlan): void {
  if (
    manifest.leaseId !== plan.stagingLeaseId ||
    manifest.workspaceId !== plan.workspaceId ||
    manifest.sourceId !== plan.sourceId ||
    manifest.scanId !== plan.scanId ||
    manifest.planId !== plan.planId ||
    manifest.planSha256 !== plan.planSha256 ||
    manifest.selectedItemSetSha256 !== plan.selectedItemSetSha256 ||
    manifest.rawSetSha256 !== plan.rawSetSha256 ||
    manifest.normalizedSetSha256 !== plan.normalizedSetSha256 ||
    manifest.expiresAt !== plan.stagingExpiresAt ||
    canonicalJsonString(manifest.items.map((item) => item.itemId)) !== canonicalJsonString(plan.selectedItemIds)
  ) {
    throw new ExternalSourcePlanStagingStoreError("conflict");
  }
}

function mapStagingError(error: unknown): ExternalSourcePlanStagingStoreError {
  if (error instanceof ExternalSourcePlanStagingStoreError) return error;
  if (error instanceof ExternalSourceArtifactStoreError) {
    if (error.code === "cancelled") return new ExternalSourcePlanStagingStoreError("cancelled");
    if (error.code === "not_found") return new ExternalSourcePlanStagingStoreError("missing");
    if (error.code === "tampered" || error.code === "digest_mismatch" || error.code === "unsafe_path") {
      return new ExternalSourcePlanStagingStoreError("tampered");
    }
  }
  if (isErrno(error, "ENOENT")) return new ExternalSourcePlanStagingStoreError("missing");
  if (isErrno(error, "ELOOP")) return new ExternalSourcePlanStagingStoreError("tampered");
  if (isErrno(error, "ABORT_ERR")) return new ExternalSourcePlanStagingStoreError("cancelled");
  return new ExternalSourcePlanStagingStoreError("filesystem_error");
}

function assertSafeFile(stat: ExternalSourceFilesystemStat): void {
  assertValidStat(stat);
  if (stat.kind !== "file" || stat.symbolicLink || stat.reparsePoint) {
    throw new ExternalSourcePlanStagingStoreError("tampered");
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
    throw new ExternalSourcePlanStagingStoreError("filesystem_error");
  }
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

function sameIdentityAndVersion(left: ExternalSourceFilesystemStat, right: ExternalSourceFilesystemStat): boolean {
  return sameFilesystemIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function assertSafeTreeEntry(entry: string): void {
  if (!entry || entry === "." || entry === ".." || entry.includes("/") || entry.includes("\\")) {
    throw new ExternalSourcePlanStagingStoreError("tampered");
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    value === value.normalize("NFKC") &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function isContainedOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path
      .resolve(value)
      .replace(/[\\/]+$/u, "")
      .normalize("NFKC");
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

function assertAbortSignal(signal: AbortSignal): void {
  if (!signal || typeof signal.aborted !== "boolean") throw new TypeError("External source staging requires a signal.");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExternalSourcePlanStagingStoreError("cancelled");
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
