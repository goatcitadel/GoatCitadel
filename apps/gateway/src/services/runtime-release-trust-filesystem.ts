import fsSync, { type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const MAX_RELEASE_CERTIFICATE_BYTES = 2 * 1024 * 1024;
export const MAX_SIGSTORE_BUNDLE_BYTES = 4 * 1024 * 1024;
export const MAX_RELEASE_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_RUNTIME_PAYLOAD_FILES = 100_000;
export const MAX_RUNTIME_PAYLOAD_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_RUNTIME_PAYLOAD_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_RUNTIME_PAYLOAD_PATH_LENGTH = 1_024;

const HASH_BUFFER_BYTES = 1024 * 1024;
const FIXED_METADATA_FILE = "app/release-manifest.json";
const FIXED_METADATA_TREE = "app/release-evidence";
const FIXED_METADATA_FILE_CASEFOLDED = FIXED_METADATA_FILE.toLowerCase();
const FIXED_METADATA_TREE_CASEFOLDED = FIXED_METADATA_TREE.toLowerCase();

export type ReleaseTrustFilesystemFailureCode = "missing" | "invalid" | "mismatch" | "oversize" | "race";

export class ReleaseTrustFilesystemError extends Error {
  public constructor(
    public readonly failureCode: ReleaseTrustFilesystemFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReleaseTrustFilesystemError";
  }
}

export interface StableReleaseTrustFile {
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
}

export interface RuntimePayloadFileSnapshot {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
  identity: string;
}

export interface RuntimePayloadTreeSnapshot {
  files: RuntimePayloadFileSnapshot[];
  fileCount: number;
  totalBytes: number;
  fingerprint: string;
}

export interface RuntimeReleaseBindingPaths {
  gatewayModulePath: string;
  entryPath: string;
  executablePath: string;
}

export function resolvePackagedRuntimeAppDir(
  candidates: Array<string | undefined>,
  runtimePaths: RuntimeReleaseBindingPaths,
): string | undefined {
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const resolved = path.resolve(candidate);
    try {
      // Startup discovery proves only a regular non-link manifest location. It
      // deliberately does not read or hash bytes on the constructor path.
      assertAnchoredPath(resolved, path.join(resolved, "release-manifest.json"), "file");
      resolveRuntimeReleaseBindingPaths(resolved, runtimePaths);
      return resolved;
    } catch {
      // Continue through server-selected candidates; none is trusted by presence alone.
    }
  }
  return undefined;
}

export function resolveRuntimeReleaseBindingPaths(
  packagedAppDir: string,
  runtimePaths: RuntimeReleaseBindingPaths,
): string[] {
  const appRoot = path.resolve(packagedAppDir);
  if (path.basename(appRoot).toLowerCase() !== "app") {
    throw new ReleaseTrustFilesystemError("invalid", "Packaged runtime app root does not use the fixed app layout.");
  }
  const bundleRoot = path.dirname(appRoot);
  const relativePaths: string[] = [];
  const caseFoldedPaths = new Set<string>();
  for (const selectedPath of [runtimePaths.gatewayModulePath, runtimePaths.entryPath, runtimePaths.executablePath]) {
    if (!selectedPath?.trim()) {
      throw new ReleaseTrustFilesystemError("invalid", "A server-selected runtime binding path is unavailable.");
    }
    const absolutePath = path.resolve(selectedPath);
    assertAnchoredPath(appRoot, absolutePath, "file");
    const canonicalPath = fsSync.realpathSync.native(absolutePath);
    const relativePath = path.relative(bundleRoot, canonicalPath).replaceAll("\\", "/");
    assertSafePayloadRelativePath(relativePath);
    if (isDetachedMetadataPath(relativePath)) {
      throw new ReleaseTrustFilesystemError("invalid", "A runtime binding path is detached release metadata.");
    }
    const folded = relativePath.toLowerCase();
    if (caseFoldedPaths.has(folded)) {
      throw new ReleaseTrustFilesystemError("invalid", "Server-selected runtime binding paths are not distinct.");
    }
    relativePaths.push(relativePath);
    caseFoldedPaths.add(folded);
  }
  return relativePaths;
}

export async function readStableReleaseTrustFile(input: {
  filePath: string;
  trustedRoot: string;
  maxBytes: number;
}): Promise<StableReleaseTrustFile> {
  const filePath = path.resolve(input.filePath);
  const trustedRoot = path.resolve(input.trustedRoot);
  await assertAnchoredPathAsync(trustedRoot, filePath, "file");
  let before: Stats;
  try {
    before = await fs.lstat(filePath);
  } catch (error) {
    throw new ReleaseTrustFilesystemError(isMissingError(error) ? "missing" : "invalid", "Trust input unavailable.", {
      cause: error,
    });
  }
  assertBoundedRegularFile(before, input.maxBytes, false);
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, fsSync.constants.O_RDONLY | readNoFollowFlag());
  } catch (error) {
    throw new ReleaseTrustFilesystemError(isMissingError(error) ? "missing" : "invalid", "Trust input open failed.", {
      cause: error,
    });
  }
  try {
    const opened = await handle.stat();
    const current = await fs.lstat(filePath);
    assertStableFileIdentity(before, opened, current);
    await assertAnchoredPathAsync(trustedRoot, filePath, "file");
    const bytes = await readExactBoundedFile(handle, before.size);
    const finalOpened = await handle.stat();
    const finalPath = await fs.lstat(filePath);
    assertStableFileIdentity(opened, finalOpened, finalPath);
    await assertAnchoredPathAsync(trustedRoot, filePath, "file");
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
    };
  } catch (error) {
    if (error instanceof ReleaseTrustFilesystemError) throw error;
    throw new ReleaseTrustFilesystemError(isMissingError(error) ? "missing" : "race", "Trust input changed.", {
      cause: error,
    });
  } finally {
    await handle.close();
  }
}

export async function snapshotRuntimePayloadTree(
  bundleRoot: string,
  signal?: AbortSignal,
): Promise<RuntimePayloadTreeSnapshot> {
  throwIfAborted(signal);
  const resolvedRoot = path.resolve(bundleRoot);
  await assertAnchoredPathAsync(resolvedRoot, resolvedRoot, "directory");
  const canonicalRoot = await fs.realpath(resolvedRoot);
  const files: RuntimePayloadFileSnapshot[] = [];
  const directoryIdentities: string[] = [];
  const caseFoldedPaths = new Set<string>();
  const queue = ["app", "bin"];
  let queueIndex = 0;
  let totalBytes = 0;

  while (queueIndex < queue.length) {
    throwIfAborted(signal);
    const relativeDirectory = queue[queueIndex++]!;
    const absoluteDirectory = resolvePayloadPath(resolvedRoot, relativeDirectory);
    const directoryStats = await safeLstat(absoluteDirectory);
    if (!directoryStats?.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new ReleaseTrustFilesystemError(
        directoryStats ? "invalid" : "missing",
        "Immutable runtime payload root is unavailable or unsafe.",
      );
    }
    const canonicalDirectory = await fs.realpath(absoluteDirectory);
    if (!isWithinRoot(canonicalRoot, canonicalDirectory)) {
      throw new ReleaseTrustFilesystemError("invalid", "Immutable runtime payload directory escapes its root.");
    }
    directoryIdentities.push(`${relativeDirectory}:${statsIdentity(directoryStats)}`);
    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      throwIfAborted(signal);
      const relativePath = `${relativeDirectory}/${entry.name}`;
      assertSafePayloadRelativePath(relativePath);
      const folded = relativePath.toLowerCase();
      if (caseFoldedPaths.has(folded)) {
        throw new ReleaseTrustFilesystemError("invalid", "Immutable payload contains a case-colliding path.");
      }
      caseFoldedPaths.add(folded);
      const absolutePath = resolvePayloadPath(resolvedRoot, relativePath);
      const stats = await safeLstat(absolutePath);
      if (!stats) {
        throw new ReleaseTrustFilesystemError("race", "Immutable payload changed during enumeration.");
      }
      if (relativePath === FIXED_METADATA_TREE) {
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw new ReleaseTrustFilesystemError("invalid", "Detached release evidence path is unsafe.");
        }
        continue;
      }
      if (relativePath === FIXED_METADATA_FILE) {
        if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
          throw new ReleaseTrustFilesystemError("invalid", "Detached release manifest path is unsafe.");
        }
        continue;
      }
      if (stats.isSymbolicLink()) {
        throw new ReleaseTrustFilesystemError("invalid", "Immutable payload contains a symbolic link or junction.");
      }
      if (stats.isDirectory()) {
        queue.push(relativePath);
        continue;
      }
      if (!stats.isFile() || stats.nlink !== 1) {
        throw new ReleaseTrustFilesystemError("invalid", "Immutable payload contains a special or hard-linked file.");
      }
      if (stats.size > MAX_RUNTIME_PAYLOAD_FILE_BYTES) {
        throw new ReleaseTrustFilesystemError("oversize", "Immutable payload file exceeds its size bound.");
      }
      totalBytes += stats.size;
      if (totalBytes > MAX_RUNTIME_PAYLOAD_BYTES) {
        throw new ReleaseTrustFilesystemError("oversize", "Immutable payload exceeds its total size bound.");
      }
      files.push({
        absolutePath,
        relativePath,
        sizeBytes: stats.size,
        identity: statsIdentity(stats),
      });
      if (files.length > MAX_RUNTIME_PAYLOAD_FILES) {
        throw new ReleaseTrustFilesystemError("oversize", "Immutable payload exceeds its file-count bound.");
      }
    }
  }

  files.sort((left, right) => Buffer.from(left.relativePath).compare(Buffer.from(right.relativePath)));
  directoryIdentities.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  return {
    files,
    fileCount: files.length,
    totalBytes,
    fingerprint: createHash("sha256")
      .update(directoryIdentities.join("\n"))
      .update("\0")
      .update(files.map((file) => `${file.relativePath}:${file.identity}`).join("\n"))
      .digest("hex"),
  };
}

export async function hashStableRuntimePayloadFile(input: {
  bundleRoot: string;
  file: RuntimePayloadFileSnapshot;
  expectedSizeBytes: number;
  signal?: AbortSignal;
}): Promise<string> {
  throwIfAborted(input.signal);
  const bundleRoot = path.resolve(input.bundleRoot);
  const filePath = resolvePayloadPath(bundleRoot, input.file.relativePath);
  await assertAnchoredPathAsync(bundleRoot, filePath, "file");
  const before = await safeLstat(filePath);
  if (!before) throw new ReleaseTrustFilesystemError("missing", "Immutable payload file is missing.");
  assertPayloadRegularFile(before, input.expectedSizeBytes);
  if (statsIdentity(before) !== input.file.identity) {
    throw new ReleaseTrustFilesystemError("race", "Immutable payload changed before hashing.");
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, fsSync.constants.O_RDONLY | readNoFollowFlag());
  } catch (error) {
    throw new ReleaseTrustFilesystemError(isMissingError(error) ? "missing" : "invalid", "Payload open failed.", {
      cause: error,
    });
  }
  try {
    const opened = await handle.stat();
    const current = await fs.lstat(filePath);
    assertStableFileIdentity(before, opened, current);
    assertPayloadRegularFile(opened, input.expectedSizeBytes);
    await assertAnchoredPathAsync(bundleRoot, filePath, "file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let position = 0;
    while (position < opened.size) {
      throwIfAborted(input.signal);
      const length = Math.min(buffer.byteLength, opened.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) {
        throw new ReleaseTrustFilesystemError("race", "Immutable payload became truncated during hashing.");
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const finalOpened = await handle.stat();
    const finalPath = await fs.lstat(filePath);
    assertStableFileIdentity(opened, finalOpened, finalPath);
    assertPayloadRegularFile(finalOpened, input.expectedSizeBytes);
    await assertAnchoredPathAsync(bundleRoot, filePath, "file");
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof ReleaseTrustFilesystemError) throw error;
    throw new ReleaseTrustFilesystemError(isMissingError(error) ? "missing" : "race", "Payload changed.", {
      cause: error,
    });
  } finally {
    await handle.close();
  }
}

export function assertSafePayloadRelativePath(relativePath: string): void {
  if (
    !relativePath ||
    relativePath.length > MAX_RUNTIME_PAYLOAD_PATH_LENGTH ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    hasLoneSurrogate(relativePath) ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    throw new ReleaseTrustFilesystemError("invalid", "Immutable payload contains an unsafe path.");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ReleaseTrustFilesystemError("invalid", "Immutable payload contains an unsafe path segment.");
  }
  if (segments[0] !== "app" && segments[0] !== "bin") {
    throw new ReleaseTrustFilesystemError("invalid", "Immutable payload path is outside its declared roots.");
  }
}

function resolvePayloadPath(rootDir: string, relativePath: string): string {
  assertSafePayloadRelativePath(relativePath);
  const candidate = path.resolve(rootDir, ...relativePath.split("/"));
  if (!isWithinRoot(rootDir, candidate)) {
    throw new ReleaseTrustFilesystemError("invalid", "Immutable payload path escapes its bundle root.");
  }
  return candidate;
}

function isDetachedMetadataPath(relativePath: string): boolean {
  const folded = relativePath.toLowerCase();
  return (
    folded === FIXED_METADATA_FILE_CASEFOLDED ||
    folded === FIXED_METADATA_TREE_CASEFOLDED ||
    folded.startsWith(`${FIXED_METADATA_TREE_CASEFOLDED}/`)
  );
}

function assertPayloadRegularFile(stats: Stats, expectedSizeBytes: number): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    stats.size !== expectedSizeBytes ||
    stats.size > MAX_RUNTIME_PAYLOAD_FILE_BYTES
  ) {
    throw new ReleaseTrustFilesystemError("mismatch", "Immutable payload file does not match its manifest metadata.");
  }
}

function assertBoundedRegularFile(stats: Stats, maxBytes: number, allowEmpty: boolean): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (!allowEmpty && stats.size === 0) ||
    stats.size > maxBytes
  ) {
    throw new ReleaseTrustFilesystemError(
      stats.size > maxBytes ? "oversize" : "invalid",
      "Release trust input is not a bounded regular file.",
    );
  }
}

function assertStableFileIdentity(before: Stats, opened: Stats, current: Stats): void {
  if (
    !opened.isFile() ||
    opened.isSymbolicLink() ||
    opened.nlink !== 1 ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 1 ||
    !sameFileIdentity(before, opened) ||
    !sameFileIdentity(opened, current)
  ) {
    throw new ReleaseTrustFilesystemError("race", "Release trust file identity changed during verification.");
  }
}

function assertAnchoredPath(trustedRoot: string, candidate: string, expected: "file" | "directory"): void {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(candidate);
  if (!isWithinRoot(root, target)) {
    throw new ReleaseTrustFilesystemError("invalid", "Release trust path escapes its server-selected root.");
  }
  try {
    const rootStats = fsSync.lstatSync(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new ReleaseTrustFilesystemError("invalid", "Release trust root is unsafe.");
    }
    let cursor = root;
    const relative = path.relative(root, target);
    for (const segment of relative ? relative.split(path.sep) : []) {
      cursor = path.join(cursor, segment);
      const stats = fsSync.lstatSync(cursor);
      if (stats.isSymbolicLink() || (cursor !== target && !stats.isDirectory())) {
        throw new ReleaseTrustFilesystemError("invalid", "Release trust path traverses a link or non-directory.");
      }
    }
    const targetStats = fsSync.lstatSync(target);
    if (expected === "file" ? !targetStats.isFile() : !targetStats.isDirectory()) {
      throw new ReleaseTrustFilesystemError("invalid", "Release trust path has the wrong file type.");
    }
    const canonicalRoot = fsSync.realpathSync.native(root);
    const canonicalTarget = fsSync.realpathSync.native(target);
    if (!isWithinRoot(canonicalRoot, canonicalTarget)) {
      throw new ReleaseTrustFilesystemError("invalid", "Release trust path escapes its canonical root.");
    }
  } catch (error) {
    if (error instanceof ReleaseTrustFilesystemError) throw error;
    throw new ReleaseTrustFilesystemError(
      isMissingError(error) ? "missing" : "invalid",
      "Release trust path is unavailable.",
      {
        cause: error,
      },
    );
  }
}

async function assertAnchoredPathAsync(
  trustedRoot: string,
  candidate: string,
  expected: "file" | "directory",
): Promise<void> {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(candidate);
  if (!isWithinRoot(root, target)) {
    throw new ReleaseTrustFilesystemError("invalid", "Release trust path escapes its server-selected root.");
  }
  try {
    const rootStats = await fs.lstat(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new ReleaseTrustFilesystemError("invalid", "Release trust root is unsafe.");
    }
    let cursor = root;
    const relative = path.relative(root, target);
    for (const segment of relative ? relative.split(path.sep) : []) {
      cursor = path.join(cursor, segment);
      const stats = await fs.lstat(cursor);
      if (stats.isSymbolicLink() || (cursor !== target && !stats.isDirectory())) {
        throw new ReleaseTrustFilesystemError("invalid", "Release trust path traverses a link or non-directory.");
      }
    }
    const targetStats = await fs.lstat(target);
    if (expected === "file" ? !targetStats.isFile() : !targetStats.isDirectory()) {
      throw new ReleaseTrustFilesystemError("invalid", "Release trust path has the wrong file type.");
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    if (!isWithinRoot(canonicalRoot, canonicalTarget)) {
      throw new ReleaseTrustFilesystemError("invalid", "Release trust path escapes its canonical root.");
    }
  } catch (error) {
    if (error instanceof ReleaseTrustFilesystemError) throw error;
    throw new ReleaseTrustFilesystemError(
      isMissingError(error) ? "missing" : "invalid",
      "Release trust path is unavailable.",
      { cause: error },
    );
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function statsIdentity(stats: Stats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs, stats.mode, stats.nlink].join(":");
}

function isWithinRoot(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function readNoFollowFlag(): number {
  return (fsSync.constants as typeof fsSync.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}

function isMissingError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR"),
  );
}

async function safeLstat(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw new ReleaseTrustFilesystemError("invalid", "Release trust filesystem inspection failed.", { cause: error });
  }
}

async function readExactBoundedFile(handle: FileHandle, sizeBytes: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(sizeBytes);
  let position = 0;
  while (position < sizeBytes) {
    const { bytesRead } = await handle.read(bytes, position, sizeBytes - position, position);
    if (bytesRead <= 0) {
      throw new ReleaseTrustFilesystemError("race", "Release trust input became truncated during reading.");
    }
    position += bytesRead;
  }
  const overflowProbe = Buffer.allocUnsafe(1);
  const { bytesRead: overflowBytesRead } = await handle.read(overflowProbe, 0, 1, sizeBytes);
  if (overflowBytesRead > 0) {
    throw new ReleaseTrustFilesystemError("race", "Release trust input grew during bounded reading.");
  }
  return bytes;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Runtime release trust verification aborted.");
  }
}
