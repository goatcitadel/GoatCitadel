import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  EXTERNAL_SOURCE_LIMITS,
  assertExternalSourceRecord,
  assertWorkspacePathBridgeSnapshot,
  canonicalJsonString,
  type ExternalSourceRecord,
  type WorkspacePathBridgeSnapshotRecord,
} from "@goatcitadel/contracts";
import { verifyExternalSourceRecord, verifyWorkspacePathBridgeSnapshot } from "@goatcitadel/storage";
import {
  NodeExternalSourceWindowsSecurity,
  type ExternalSourceWindowsSecurityPort,
} from "./external-source-windows-security.js";

export type ExternalSourceReaderErrorCode =
  | "cancelled"
  | "cycle_detected"
  | "filesystem_error"
  | "identity_drift"
  | "invalid_path"
  | "limit_exceeded"
  | "not_found"
  | "not_regular_file"
  | "outside_jail"
  | "source_changed"
  | "unsafe_path";

const ERROR_MESSAGES: Readonly<Record<ExternalSourceReaderErrorCode, string>> = Object.freeze({
  cancelled: "External source operation was cancelled.",
  cycle_detected: "External source traversal encountered a filesystem identity cycle.",
  filesystem_error: "External source filesystem operation failed.",
  identity_drift: "External source identity no longer matches its verified binding.",
  invalid_path: "External source relative path is invalid.",
  limit_exceeded: "External source operation exceeded a fixed limit.",
  not_found: "External source entry was not found.",
  not_regular_file: "External source entry is not a regular file.",
  outside_jail: "External source path is outside its verified root.",
  source_changed: "External source changed while it was being read.",
  unsafe_path: "External source path contains an unsafe filesystem component.",
});

export class ExternalSourceReaderError extends Error {
  public constructor(public readonly code: ExternalSourceReaderErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ExternalSourceReaderError";
  }
}

export interface ExternalSourceFilesystemStat {
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

export interface ExternalSourceReadOnlyHandle {
  stat(signal: AbortSignal): Promise<ExternalSourceFilesystemStat>;
  read(buffer: Uint8Array, offset: number, length: number, position: number, signal: AbortSignal): Promise<number>;
  close(): Promise<void>;
}

export interface ExternalSourceReadOnlyFilesystem {
  lstat(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceFilesystemStat>;
  realpath(absolutePath: string, signal: AbortSignal): Promise<string>;
  readDirectory(absolutePath: string, signal: AbortSignal): Promise<readonly string[]>;
  openReadOnly(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceReadOnlyHandle>;
}

export interface ExternalSourceCurrentIdentity {
  source: ExternalSourceRecord;
  snapshot: WorkspacePathBridgeSnapshotRecord;
}

export interface ExternalSourceIdentityResolver {
  resolveCurrent(input: {
    workspaceId: string;
    sourceId: string;
    signal: AbortSignal;
  }): Promise<ExternalSourceCurrentIdentity | undefined>;
}

export interface ExternalSourceClock {
  nowMs(): number;
}

export interface ExternalSourceCancellationPort {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface ExternalSourceEnumeratedFile {
  relativePath: string;
  byteCount: number;
  observedMtimeNs: string;
  filesystemIdentitySha256: string;
  statFingerprintSha256: string;
}

export interface ExternalSourceEnumeration {
  files: readonly ExternalSourceEnumeratedFile[];
  examinedEntryCount: number;
}

export interface ExternalSourceReadResult extends ExternalSourceEnumeratedFile {
  bytes: Uint8Array;
  rawSha256: string;
}

export interface ExternalSourceReaderPort {
  enumerate(input: { source: ExternalSourceRecord; signal: AbortSignal }): Promise<ExternalSourceEnumeration>;
  readFile(input: {
    source: ExternalSourceRecord;
    relativePath: string;
    signal: AbortSignal;
  }): Promise<ExternalSourceReadResult>;
  readFiles(input: {
    source: ExternalSourceRecord;
    relativePaths: readonly string[];
    signal: AbortSignal;
  }): Promise<readonly ExternalSourceReadResult[]>;
}

interface ReaderOperationContext {
  binding: ExternalSourceCurrentIdentity;
  rootPath: string;
  rootStat: ExternalSourceFilesystemStat;
  signal: AbortSignal;
  startedAtMs: number;
}

interface ExternalSourceBoundFile {
  relativePath: string;
  segments: readonly string[];
  absolutePath: string;
  stat: ExternalSourceFilesystemStat;
  ancestors: ReadonlyArray<{ segments: readonly string[]; stat: ExternalSourceFilesystemStat }>;
}

interface ExternalSourceReaderDependencies {
  identityResolver: ExternalSourceIdentityResolver;
  filesystem?: ExternalSourceReadOnlyFilesystem;
  clock?: ExternalSourceClock;
  cancellation?: ExternalSourceCancellationPort;
}

const DEFAULT_CLOCK: ExternalSourceClock = { nowMs: () => Date.now() };
const DEFAULT_CANCELLATION: ExternalSourceCancellationPort = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ExternalSourceReader implements ExternalSourceReaderPort {
  private readonly filesystem: ExternalSourceReadOnlyFilesystem;
  private readonly clock: ExternalSourceClock;
  private readonly cancellation: ExternalSourceCancellationPort;

  public constructor(private readonly dependencies: ExternalSourceReaderDependencies) {
    if (!dependencies.identityResolver) {
      throw new TypeError("External source identity resolver is required.");
    }
    this.filesystem = dependencies.filesystem ?? new NodeExternalSourceReadOnlyFilesystem();
    this.clock = dependencies.clock ?? DEFAULT_CLOCK;
    this.cancellation = dependencies.cancellation ?? DEFAULT_CANCELLATION;
  }

  public async enumerate(input: {
    source: ExternalSourceRecord;
    signal: AbortSignal;
  }): Promise<ExternalSourceEnumeration> {
    return this.runOperation(input.source, input.signal, async (context) => {
      const files: ExternalSourceEnumeratedFile[] = [];
      const visited = new Set<string>();
      let examinedEntryCount = 0;

      const visit = async (
        absoluteDirectory: string,
        relativeSegments: readonly string[],
        expected: ExternalSourceFilesystemStat,
      ): Promise<void> => {
        this.assertRunning(context);
        if (relativeSegments.length > EXTERNAL_SOURCE_LIMITS.directoryDepth) {
          throw new ExternalSourceReaderError("limit_exceeded");
        }
        const before = await this.safeLstat(absoluteDirectory, context.signal);
        assertSafeDirectory(before);
        if (!sameIdentityAndVersion(before, expected)) {
          throw new ExternalSourceReaderError("source_changed");
        }
        const identity = computeExternalSourceFilesystemIdentity(before);
        if (visited.has(identity)) {
          throw new ExternalSourceReaderError("cycle_detected");
        }
        visited.add(identity);

        const names = [...(await this.safeReadDirectory(absoluteDirectory, context.signal))].sort((a, b) =>
          a.localeCompare(b, "en"),
        );
        for (const name of names) {
          this.assertRunning(context);
          assertSafeDirectoryName(name);
          examinedEntryCount += 1;
          if (examinedEntryCount > EXTERNAL_SOURCE_LIMITS.directoryEntriesPerScan) {
            throw new ExternalSourceReaderError("limit_exceeded");
          }
          const childSegments = [...relativeSegments, name];
          const childPath = resolveContainedPath(context.rootPath, childSegments);
          const childStat = await this.safeLstat(childPath, context.signal);
          assertNoLink(childStat);
          if (childStat.kind === "directory") {
            await visit(childPath, childSegments, childStat);
          } else if (childStat.kind === "file" && !isExcludedDatabasePath(name)) {
            if (files.length >= EXTERNAL_SOURCE_LIMITS.catalogItemsPerScan) {
              throw new ExternalSourceReaderError("limit_exceeded");
            }
            files.push(toEnumeratedFile(childSegments.join("/"), childStat));
          }
        }

        const after = await this.safeLstat(absoluteDirectory, context.signal);
        if (!sameIdentityAndVersion(before, after)) {
          throw new ExternalSourceReaderError("source_changed");
        }
      };

      await visit(context.rootPath, [], context.rootStat);
      await this.assertCurrentBinding(input.source, context.signal);
      return { files, examinedEntryCount };
    });
  }

  public async readFile(input: {
    source: ExternalSourceRecord;
    relativePath: string;
    signal: AbortSignal;
  }): Promise<ExternalSourceReadResult> {
    return this.runOperation(input.source, input.signal, async (context) => {
      const preflight = await this.preflightBoundFile(context, input.relativePath);
      const result = await this.readBoundFile(context, preflight);
      await this.assertCurrentBinding(input.source, context.signal);
      return result;
    });
  }

  public async readFiles(input: {
    source: ExternalSourceRecord;
    relativePaths: readonly string[];
    signal: AbortSignal;
  }): Promise<readonly ExternalSourceReadResult[]> {
    if (
      !Array.isArray(input.relativePaths) ||
      input.relativePaths.length === 0 ||
      input.relativePaths.length > EXTERNAL_SOURCE_LIMITS.selectedItemsPerImport ||
      new Set(input.relativePaths).size !== input.relativePaths.length
    ) {
      throw new ExternalSourceReaderError("limit_exceeded");
    }
    return this.runOperation(input.source, input.signal, async (context) => {
      const preflight: ExternalSourceBoundFile[] = [];
      let reservedBytes = 0;
      for (const relativePath of input.relativePaths) {
        const bound = await this.preflightBoundFile(context, relativePath);
        reservedBytes += Number(bound.stat.size);
        if (reservedBytes > EXTERNAL_SOURCE_LIMITS.rawBytesPerPlan) {
          throw new ExternalSourceReaderError("limit_exceeded");
        }
        preflight.push(bound);
      }

      const results = new Array<ExternalSourceReadResult>(input.relativePaths.length);
      let cursor = 0;
      let firstError: unknown;

      const worker = async (): Promise<void> => {
        while (firstError === undefined) {
          const index = cursor;
          cursor += 1;
          if (index >= input.relativePaths.length) return;
          try {
            const bound = preflight[index];
            if (bound === undefined) throw new ExternalSourceReaderError("invalid_path");
            const result = await this.readBoundFile(context, bound);
            results[index] = result;
          } catch (error) {
            firstError ??= error;
          }
        }
      };

      const workerCount = Math.min(EXTERNAL_SOURCE_LIMITS.concurrentFileReads, input.relativePaths.length);
      await Promise.all(Array.from({ length: workerCount }, worker));
      if (firstError !== undefined) throw firstError;
      await this.assertCurrentBinding(input.source, context.signal);
      return results;
    });
  }

  private async preflightBoundFile(
    context: ReaderOperationContext,
    relativePath: string,
  ): Promise<ExternalSourceBoundFile> {
    this.assertRunning(context);
    const segments = parseRelativePath(relativePath);
    if (isExcludedDatabasePath(segments.at(-1) ?? "")) {
      throw new ExternalSourceReaderError("unsafe_path");
    }

    const ancestors: Array<{ segments: readonly string[]; stat: ExternalSourceFilesystemStat }> = [
      { segments: [], stat: context.rootStat },
    ];
    for (let index = 0; index < segments.length - 1; index += 1) {
      const ancestorSegments = segments.slice(0, index + 1);
      const current = resolveContainedPath(context.rootPath, ancestorSegments);
      const stat = await this.safeLstat(current, context.signal);
      assertSafeDirectory(stat);
      ancestors.push({ segments: ancestorSegments, stat });
    }

    const absolutePath = resolveContainedPath(context.rootPath, segments);
    const before = await this.safeLstat(absolutePath, context.signal);
    assertNoLink(before);
    if (before.kind !== "file") throw new ExternalSourceReaderError("not_regular_file");
    assertBoundedFileSize(before.size, EXTERNAL_SOURCE_LIMITS.sourceFileBytes);
    return { relativePath: segments.join("/"), segments, absolutePath, stat: before, ancestors };
  }

  private async readBoundFile(
    context: ReaderOperationContext,
    preflight: ExternalSourceBoundFile,
  ): Promise<ExternalSourceReadResult> {
    this.assertRunning(context);
    await this.assertAncestorChain(context, preflight.ancestors);
    const before = await this.safeLstat(preflight.absolutePath, context.signal);
    if (!sameIdentityAndVersion(before, preflight.stat)) {
      throw new ExternalSourceReaderError("source_changed");
    }
    assertNoLink(before);
    if (before.kind !== "file") throw new ExternalSourceReaderError("not_regular_file");
    assertBoundedFileSize(before.size, EXTERNAL_SOURCE_LIMITS.sourceFileBytes);

    const handle = await this.safeOpenReadOnly(preflight.absolutePath, context.signal);
    let bytes: Uint8Array;
    try {
      const opened = await this.safeHandleStat(handle, context.signal);
      if (!sameIdentityAndVersion(before, opened) || opened.kind !== "file") {
        throw new ExternalSourceReaderError("source_changed");
      }
      const byteCount = Number(before.size);
      bytes = new Uint8Array(byteCount);
      let offset = 0;
      while (offset < byteCount) {
        this.assertRunning(context);
        const requested = Math.min(64 * 1024, byteCount - offset);
        const bytesRead = await this.safeHandleRead(handle, bytes, offset, requested, offset, context.signal);
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > requested) {
          throw new ExternalSourceReaderError("source_changed");
        }
        offset += bytesRead;
      }
      const afterHandle = await this.safeHandleStat(handle, context.signal);
      if (!sameIdentityAndVersion(before, afterHandle)) {
        throw new ExternalSourceReaderError("source_changed");
      }
    } finally {
      await handle.close().catch(() => undefined);
    }

    await this.assertAncestorChain(context, preflight.ancestors);
    const afterPath = await this.safeLstat(preflight.absolutePath, context.signal);
    if (!sameIdentityAndVersion(before, afterPath)) {
      throw new ExternalSourceReaderError("source_changed");
    }
    const metadata = toEnumeratedFile(preflight.relativePath, before);
    return {
      ...metadata,
      bytes,
      rawSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  private async assertAncestorChain(
    context: ReaderOperationContext,
    ancestors: ReadonlyArray<{ segments: readonly string[]; stat: ExternalSourceFilesystemStat }>,
  ): Promise<void> {
    for (const ancestor of ancestors) {
      const directoryPath =
        ancestor.segments.length === 0 ? context.rootPath : resolveContainedPath(context.rootPath, ancestor.segments);
      const observed = await this.safeLstat(directoryPath, context.signal);
      assertSafeDirectory(observed);
      if (!sameIdentityAndVersion(observed, ancestor.stat)) {
        throw new ExternalSourceReaderError("source_changed");
      }
    }
  }

  private async runOperation<T>(
    source: ExternalSourceRecord,
    parentSignal: AbortSignal,
    operation: (context: ReaderOperationContext) => Promise<T>,
  ): Promise<T> {
    assertAbortSignal(parentSignal);
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort();
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    const timer = this.cancellation.schedule(() => controller.abort(), EXTERNAL_SOURCE_LIMITS.scanWallTimeMs);
    const startedAtMs = this.clock.nowMs();
    try {
      if (parentSignal.aborted) throw new ExternalSourceReaderError("cancelled");
      const binding = await this.assertCurrentBinding(source, controller.signal);
      const rootPath = resolveRootPath(source.canonicalRootPath);
      const rootStat = await this.safeLstat(rootPath, controller.signal);
      assertSafeDirectory(rootStat);
      if (computeExternalSourceFilesystemIdentity(rootStat) !== source.rootIdentitySha256) {
        throw new ExternalSourceReaderError("identity_drift");
      }
      const result = await operation({ binding, rootPath, rootStat, signal: controller.signal, startedAtMs });
      if (controller.signal.aborted || this.clock.nowMs() - startedAtMs > EXTERNAL_SOURCE_LIMITS.scanWallTimeMs) {
        throw new ExternalSourceReaderError("cancelled");
      }
      return result;
    } catch (error) {
      throw normalizeReaderError(error, controller.signal);
    } finally {
      this.cancellation.cancel(timer);
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  }

  private assertRunning(context: ReaderOperationContext): void {
    if (context.signal.aborted || this.clock.nowMs() - context.startedAtMs > EXTERNAL_SOURCE_LIMITS.scanWallTimeMs) {
      throw new ExternalSourceReaderError("cancelled");
    }
  }

  private async assertCurrentBinding(
    expected: ExternalSourceRecord,
    signal: AbortSignal,
  ): Promise<ExternalSourceCurrentIdentity> {
    let resolved: ExternalSourceCurrentIdentity | undefined;
    try {
      resolved = await this.dependencies.identityResolver.resolveCurrent({
        workspaceId: expected.workspaceId,
        sourceId: expected.sourceId,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new ExternalSourceReaderError("cancelled");
      if (error instanceof ExternalSourceReaderError) throw error;
      throw new ExternalSourceReaderError("identity_drift");
    }
    if (!resolved) throw new ExternalSourceReaderError("identity_drift");
    assertExactCurrentBinding(expected, resolved);
    return resolved;
  }

  private async safeLstat(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceFilesystemStat> {
    try {
      const stat = await this.filesystem.lstat(absolutePath, signal);
      if (!stat.symbolicLink && !stat.reparsePoint) {
        const canonicalPath = await this.filesystem.realpath(absolutePath, signal);
        if (!sameCanonicalPath(canonicalPath, absolutePath)) {
          throw new ExternalSourceReaderError("unsafe_path");
        }
      }
      return stat;
    } catch (error) {
      throw mapFilesystemError(error, signal);
    }
  }

  private async safeReadDirectory(absolutePath: string, signal: AbortSignal): Promise<readonly string[]> {
    try {
      return await this.filesystem.readDirectory(absolutePath, signal);
    } catch (error) {
      throw mapFilesystemError(error, signal);
    }
  }

  private async safeOpenReadOnly(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceReadOnlyHandle> {
    try {
      return await this.filesystem.openReadOnly(absolutePath, signal);
    } catch (error) {
      throw mapFilesystemError(error, signal);
    }
  }

  private async safeHandleStat(
    handle: ExternalSourceReadOnlyHandle,
    signal: AbortSignal,
  ): Promise<ExternalSourceFilesystemStat> {
    try {
      return await handle.stat(signal);
    } catch (error) {
      throw mapFilesystemError(error, signal);
    }
  }

  private async safeHandleRead(
    handle: ExternalSourceReadOnlyHandle,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
    signal: AbortSignal,
  ): Promise<number> {
    try {
      return await handle.read(buffer, offset, length, position, signal);
    } catch (error) {
      throw mapFilesystemError(error, signal);
    }
  }
}

export interface NodeExternalSourceReadOnlyFilesystemDependencies {
  windowsSecurity?: ExternalSourceWindowsSecurityPort;
}

export class NodeExternalSourceReadOnlyFilesystem implements ExternalSourceReadOnlyFilesystem {
  private readonly windowsSecurity: ExternalSourceWindowsSecurityPort | undefined;

  public constructor(dependencies: NodeExternalSourceReadOnlyFilesystemDependencies = {}) {
    this.windowsSecurity =
      dependencies.windowsSecurity ??
      (process.platform === "win32" ? new NodeExternalSourceWindowsSecurity() : undefined);
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

  public async readDirectory(absolutePath: string, signal: AbortSignal): Promise<readonly string[]> {
    throwIfAborted(signal);
    const names = await fs.readdir(absolutePath, { encoding: "utf8" });
    throwIfAborted(signal);
    return names;
  }

  public async openReadOnly(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceReadOnlyHandle> {
    throwIfAborted(signal);
    const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | noFollow);
    if (signal.aborted) {
      await handle.close().catch(() => undefined);
      throw new ExternalSourceReaderError("cancelled");
    }
    return {
      stat: async (readSignal) => {
        throwIfAborted(readSignal);
        const stat = await handle.stat({ bigint: true });
        throwIfAborted(readSignal);
        return fromNodeStat(stat);
      },
      read: async (buffer, offset, length, position, readSignal) => {
        throwIfAborted(readSignal);
        const result = await handle.read(buffer, offset, length, position);
        throwIfAborted(readSignal);
        return result.bytesRead;
      },
      close: () => handle.close(),
    };
  }
}

export function computeExternalSourceFilesystemIdentity(stat: ExternalSourceFilesystemStat): string {
  assertValidStat(stat);
  return sha256({
    birthtimeNs: stat.birthtimeNs.toString(),
    device: stat.device.toString(),
    inode: stat.inode.toString(),
    kind: stat.kind,
  });
}

export function computeExternalSourceStatFingerprint(stat: ExternalSourceFilesystemStat): string {
  return sha256({
    filesystemIdentitySha256: computeExternalSourceFilesystemIdentity(stat),
    mtimeNs: stat.mtimeNs.toString(),
    size: stat.size.toString(),
  });
}

function assertExactCurrentBinding(expected: ExternalSourceRecord, current: ExternalSourceCurrentIdentity): void {
  try {
    assertExternalSourceRecord(expected);
    assertExternalSourceRecord(current.source);
    assertWorkspacePathBridgeSnapshot(current.snapshot);
    verifyExternalSourceRecord(expected);
    verifyExternalSourceRecord(current.source);
    verifyWorkspacePathBridgeSnapshot(current.snapshot);
  } catch {
    throw new ExternalSourceReaderError("identity_drift");
  }
  const snapshot = current.snapshot;
  const gitIdentity = snapshot.gitIdentity.status === "verified" ? snapshot.gitIdentity.identitySha256 : undefined;
  if (
    expected.status !== "active" ||
    current.source.status !== "active" ||
    canonicalJsonString(expected) !== canonicalJsonString(current.source) ||
    snapshot.workspaceId !== expected.workspaceId ||
    snapshot.snapshotId !== expected.pathBridgeSnapshotId ||
    snapshot.status !== "verified" ||
    snapshot.callable !== true ||
    snapshot.snapshotSha256 !== expected.pathBridgeSnapshotSha256 ||
    snapshot.allowedRootsHash !== expected.allowedRootsSha256 ||
    snapshot.canonicalHostPath !== expected.canonicalRootPath ||
    snapshot.inputFlavor !== expected.inputFlavor ||
    snapshot.targetFlavor !== expected.targetFlavor ||
    snapshot.distro !== expected.distro ||
    snapshot.gitIdentityRequired !== expected.requireGitIdentity ||
    gitIdentity !== expected.gitIdentitySha256
  ) {
    throw new ExternalSourceReaderError("identity_drift");
  }
}

function parseRelativePath(relativePath: string): string[] {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    Buffer.byteLength(relativePath, "utf8") > EXTERNAL_SOURCE_LIMITS.rootPathBytes ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    containsAsciiControlCharacter(relativePath)
  ) {
    throw new ExternalSourceReaderError("invalid_path");
  }
  const segments = relativePath.split("/");
  if (segments.length > EXTERNAL_SOURCE_LIMITS.directoryDepth + 1) {
    throw new ExternalSourceReaderError("limit_exceeded");
  }
  for (const segment of segments) assertSafeDirectoryName(segment);
  return segments;
}

function assertSafeDirectoryName(name: string): void {
  const windowsDeviceBase = name.split(".", 1)[0]?.toLocaleUpperCase("en-US");
  const reservedWindowsDevice =
    windowsDeviceBase !== undefined &&
    (/^(?:CON|PRN|AUX|NUL|CLOCK\$)$/u.test(windowsDeviceBase) || /^(?:COM|LPT)[1-9]$/u.test(windowsDeviceBase));
  if (
    typeof name !== "string" ||
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes(":") ||
    name.normalize("NFKC") !== name ||
    reservedWindowsDevice ||
    containsAsciiControlCharacter(name) ||
    /[. ]$/u.test(name)
  ) {
    throw new ExternalSourceReaderError("unsafe_path");
  }
}

function resolveRootPath(rootPath: string): string {
  if (typeof rootPath !== "string" || !rootPath || !path.isAbsolute(rootPath)) {
    throw new ExternalSourceReaderError("identity_drift");
  }
  const resolved = path.resolve(rootPath);
  if (resolved !== rootPath && resolved.toLocaleLowerCase("en-US") !== rootPath.toLocaleLowerCase("en-US")) {
    throw new ExternalSourceReaderError("identity_drift");
  }
  return resolved;
}

function resolveContainedPath(rootPath: string, segments: readonly string[]): string {
  const resolved = path.resolve(rootPath, ...segments);
  const relative = path.relative(rootPath, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ExternalSourceReaderError("outside_jail");
  }
  return resolved;
}

function toEnumeratedFile(relativePath: string, stat: ExternalSourceFilesystemStat): ExternalSourceEnumeratedFile {
  assertValidStat(stat);
  if (
    Buffer.byteLength(relativePath, "utf8") > EXTERNAL_SOURCE_LIMITS.rootPathBytes ||
    stat.size > BigInt(EXTERNAL_SOURCE_LIMITS.sourceFileBytes)
  ) {
    throw new ExternalSourceReaderError("limit_exceeded");
  }
  const mtimeNs = stat.mtimeNs.toString();
  if (mtimeNs.length > 20) throw new ExternalSourceReaderError("limit_exceeded");
  return {
    relativePath,
    byteCount: Number(stat.size),
    observedMtimeNs: mtimeNs.padStart(20, "0"),
    filesystemIdentitySha256: computeExternalSourceFilesystemIdentity(stat),
    statFingerprintSha256: computeExternalSourceStatFingerprint(stat),
  };
}

function assertSafeDirectory(stat: ExternalSourceFilesystemStat): void {
  assertNoLink(stat);
  if (stat.kind !== "directory") throw new ExternalSourceReaderError("unsafe_path");
}

function assertNoLink(stat: ExternalSourceFilesystemStat): void {
  assertValidStat(stat);
  if (stat.symbolicLink || stat.reparsePoint) throw new ExternalSourceReaderError("unsafe_path");
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
    throw new ExternalSourceReaderError("filesystem_error");
  }
}

function assertBoundedFileSize(size: bigint, maximum: number): void {
  if (size < 0n || size > BigInt(maximum)) throw new ExternalSourceReaderError("limit_exceeded");
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

function isExcludedDatabasePath(name: string): boolean {
  const lower = name.toLocaleLowerCase("en-US");
  return (
    lower.endsWith(".db") ||
    lower.endsWith(".sqlite") ||
    lower.endsWith(".sqlite3") ||
    lower.endsWith("-wal") ||
    lower.endsWith("-shm") ||
    lower.endsWith("-journal")
  );
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

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function mapFilesystemError(error: unknown, signal: AbortSignal): ExternalSourceReaderError {
  if (error instanceof ExternalSourceReaderError) return error;
  if (signal.aborted || isErrno(error, "ABORT_ERR")) return new ExternalSourceReaderError("cancelled");
  if (isErrno(error, "ENOENT")) return new ExternalSourceReaderError("not_found");
  if (isErrno(error, "ELOOP")) return new ExternalSourceReaderError("unsafe_path");
  return new ExternalSourceReaderError("filesystem_error");
}

function normalizeReaderError(error: unknown, signal: AbortSignal): ExternalSourceReaderError {
  if (error instanceof ExternalSourceReaderError) return error;
  return mapFilesystemError(error, signal);
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === code;
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function assertAbortSignal(signal: AbortSignal): void {
  if (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function") {
    throw new TypeError("External source AbortSignal is required.");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExternalSourceReaderError("cancelled");
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
