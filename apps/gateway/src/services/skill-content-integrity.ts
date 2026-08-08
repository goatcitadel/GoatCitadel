import { createHash } from "node:crypto";
import fsSync, { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { SkillContentIntegrityFile, SkillContentIntegrityManifest } from "@goatcitadel/contracts";

const MANIFEST_VERSION = "goatcitadel.skill-tree.v1" as const;
const HASH_RE = /^[a-f0-9]{64}$/;
const EXCLUDED_PATHS: SkillContentIntegrityManifest["excludedPaths"] = ["source.json", ".git/**"];
const HASH_BUFFER_BYTES = 64 * 1024;

export const SKILL_CONTENT_INTEGRITY_LIMITS = Object.freeze({
  maxFiles: 96,
  maxEntries: 384,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxSourceManifestBytes: 256 * 1024,
});

interface SkillContentFileMetadata {
  path: string;
  fullPath: string;
  bytes: number;
}

export class SkillContentIntegrityLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SkillContentIntegrityLimitError";
  }
}

export async function preflightSkillContentTree(skillDir: string): Promise<void> {
  await collectFileMetadata(skillDir);
}

export async function captureSkillContentIntegrity(skillDir: string): Promise<SkillContentIntegrityManifest> {
  const metadata = await collectFileMetadata(skillDir);
  const files: SkillContentIntegrityFile[] = [];
  for (const file of metadata) {
    files.push(await hashFile(file));
  }
  return buildManifest(files);
}

export function captureSkillContentIntegritySync(skillDir: string): SkillContentIntegrityManifest {
  const metadata = collectFileMetadataSync(skillDir);
  return buildManifest(metadata.map(hashFileSync));
}

export function skillContentIntegrityMatches(
  expected: SkillContentIntegrityManifest,
  actual: SkillContentIntegrityManifest,
): boolean {
  return expected.manifestVersion === actual.manifestVersion && expected.treeSha256 === actual.treeSha256;
}

export function verifySkillContentIntegritySync(skillDir: string, expected: SkillContentIntegrityManifest): boolean {
  try {
    return skillContentIntegrityMatches(expected, captureSkillContentIntegritySync(skillDir));
  } catch {
    return false;
  }
}

export function parseSkillContentIntegrityManifest(value: unknown): SkillContentIntegrityManifest | undefined {
  if (!isRecord(value) || value.manifestVersion !== MANIFEST_VERSION || value.algorithm !== "sha256") {
    return undefined;
  }
  if (
    typeof value.treeSha256 !== "string" ||
    !HASH_RE.test(value.treeSha256) ||
    typeof value.fileCount !== "number" ||
    !Number.isSafeInteger(value.fileCount) ||
    value.fileCount < 0 ||
    value.fileCount > SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles ||
    typeof value.totalBytes !== "number" ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 0 ||
    value.totalBytes > SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes ||
    !Array.isArray(value.excludedPaths) ||
    value.excludedPaths.length !== EXCLUDED_PATHS.length ||
    value.excludedPaths.some((entry, index) => entry !== EXCLUDED_PATHS[index]) ||
    !Array.isArray(value.files) ||
    value.files.length !== value.fileCount
  ) {
    return undefined;
  }

  const files: SkillContentIntegrityFile[] = [];
  let totalBytes = 0;
  let previousPath: string | undefined;
  for (const entry of value.files) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !entry.path ||
      entry.path.includes("\\") ||
      path.posix.normalize(entry.path) !== entry.path ||
      path.posix.isAbsolute(entry.path) ||
      entry.path === ".." ||
      entry.path.startsWith("../") ||
      !shouldIncludeSkillContentPath(entry.path) ||
      typeof entry.sha256 !== "string" ||
      !HASH_RE.test(entry.sha256) ||
      typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes ||
      (previousPath !== undefined && previousPath >= entry.path)
    ) {
      return undefined;
    }
    files.push({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes });
    totalBytes += entry.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes) {
      return undefined;
    }
    previousPath = entry.path;
  }
  if (totalBytes !== value.totalBytes) {
    return undefined;
  }

  const parsed = buildManifest(files);
  if (parsed.treeSha256 !== value.treeSha256) {
    return undefined;
  }
  return parsed;
}

export function readBoundedSkillSourceManifestSync(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readBoundedSkillSourceManifestTextSync(filePath));
  if (!isRecord(parsed)) {
    throw new Error("Skill source.json must contain a JSON object.");
  }
  return parsed;
}

export function readBoundedSkillSourceManifestTextSync(filePath: string): string {
  return readBoundedFileSync(
    filePath,
    SKILL_CONTENT_INTEGRITY_LIMITS.maxSourceManifestBytes,
    "Skill source.json",
  ).toString("utf8");
}

export async function readBoundedSkillTextFile(
  filePath: string,
  maxBytes = SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes,
  label = "Skill payload file",
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes) {
    throw new Error(`Invalid bounded skill read limit: ${maxBytes}.`);
  }
  const raw = await readBoundedFile(filePath, maxBytes, label);
  return decodeExactSkillUtf8(raw, label);
}

/** Decode without silently replacing malformed byte sequences. */
export function decodeExactSkillUtf8(raw: Uint8Array, label = "Skill payload file"): string {
  const bytes = Buffer.from(raw);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`${label} is not canonical UTF-8.`);
  }
  return text;
}

export function assertSkillSourceManifestSize(raw: string): void {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > SKILL_CONTENT_INTEGRITY_LIMITS.maxSourceManifestBytes) {
    throw new SkillContentIntegrityLimitError(
      `Generated skill source.json exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxSourceManifestBytes} bytes.`,
    );
  }
}

export function shouldIncludeSkillContentPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!normalized || normalized === ".") {
    return true;
  }
  return normalized !== "source.json" && normalized !== ".git" && !normalized.startsWith(".git/");
}

async function collectFileMetadata(skillDir: string): Promise<SkillContentFileMetadata[]> {
  const root = path.resolve(skillDir);
  const files: SkillContentFileMetadata[] = [];
  const queue = [root];
  let entryCount = 0;
  let totalBytes = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const entries = await readDirectoryEntries(current);
    for (const entry of entries) {
      entryCount += 1;
      assertEntryCount(entryCount);
      const fullPath = path.join(current, entry.name);
      const relativePath = toRelativePath(root, fullPath);
      if (!shouldIncludeSkillContentPath(relativePath)) {
        continue;
      }
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Skill import payload may not contain symbolic links: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Skill import payload contains an unsupported filesystem entry: ${relativePath}`);
      }
      assertFileSize(relativePath, stat.size);
      files.push({ path: relativePath, fullPath, bytes: stat.size });
      assertFileCount(files.length);
      totalBytes += stat.size;
      assertTotalBytes(totalBytes);
    }
  }
  files.sort((left, right) => compareText(left.path, right.path));
  return files;
}

function collectFileMetadataSync(skillDir: string): SkillContentFileMetadata[] {
  const root = path.resolve(skillDir);
  const files: SkillContentFileMetadata[] = [];
  const queue = [root];
  let entryCount = 0;
  let totalBytes = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const entries = readDirectoryEntriesSync(current);
    for (const entry of entries) {
      entryCount += 1;
      assertEntryCount(entryCount);
      const fullPath = path.join(current, entry.name);
      const relativePath = toRelativePath(root, fullPath);
      if (!shouldIncludeSkillContentPath(relativePath)) {
        continue;
      }
      const stat = fsSync.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Skill import payload may not contain symbolic links: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Skill import payload contains an unsupported filesystem entry: ${relativePath}`);
      }
      assertFileSize(relativePath, stat.size);
      files.push({ path: relativePath, fullPath, bytes: stat.size });
      assertFileCount(files.length);
      totalBytes += stat.size;
      assertTotalBytes(totalBytes);
    }
  }
  files.sort((left, right) => compareText(left.path, right.path));
  return files;
}

async function readDirectoryEntries(dirPath: string): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  const directory = await fs.opendir(dirPath);
  try {
    for await (const entry of directory) {
      entries.push(entry);
      if (entries.length > SKILL_CONTENT_INTEGRITY_LIMITS.maxEntries) {
        throw new SkillContentIntegrityLimitError(
          `Skill import directory contains more than ${SKILL_CONTENT_INTEGRITY_LIMITS.maxEntries} entries.`,
        );
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  entries.sort((left, right) => compareText(left.name, right.name));
  return entries;
}

function readDirectoryEntriesSync(dirPath: string): Dirent[] {
  const entries: Dirent[] = [];
  const directory = fsSync.opendirSync(dirPath);
  try {
    let entry = directory.readSync();
    while (entry) {
      entries.push(entry);
      if (entries.length > SKILL_CONTENT_INTEGRITY_LIMITS.maxEntries) {
        throw new SkillContentIntegrityLimitError(
          `Skill import directory contains more than ${SKILL_CONTENT_INTEGRITY_LIMITS.maxEntries} entries.`,
        );
      }
      entry = directory.readSync();
    }
  } finally {
    directory.closeSync();
  }
  entries.sort((left, right) => compareText(left.name, right.name));
  return entries;
}

async function hashFile(file: SkillContentFileMetadata): Promise<SkillContentIntegrityFile> {
  const handle = await fs.open(file.fullPath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let bytes = 0;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== file.bytes) {
      throw new Error(`Skill import payload changed before fingerprinting: ${file.path}`);
    }
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) {
        break;
      }
      bytes += read.bytesRead;
      assertFileSize(file.path, bytes);
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    if (bytes !== file.bytes || after.size !== file.bytes) {
      throw new Error(`Skill import payload changed while fingerprinting: ${file.path}`);
    }
  } finally {
    await handle.close();
  }
  return { path: file.path, sha256: hash.digest("hex"), bytes };
}

function hashFileSync(file: SkillContentFileMetadata): SkillContentIntegrityFile {
  const fd = fsSync.openSync(file.fullPath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let bytes = 0;
  try {
    const before = fsSync.fstatSync(fd);
    if (!before.isFile() || before.size !== file.bytes) {
      throw new Error(`Skill import payload changed before fingerprinting: ${file.path}`);
    }
    for (;;) {
      const bytesRead = fsSync.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      bytes += bytesRead;
      assertFileSize(file.path, bytes);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = fsSync.fstatSync(fd);
    if (bytes !== file.bytes || after.size !== file.bytes) {
      throw new Error(`Skill import payload changed while fingerprinting: ${file.path}`);
    }
  } finally {
    fsSync.closeSync(fd);
  }
  return { path: file.path, sha256: hash.digest("hex"), bytes };
}

function readBoundedFileSync(filePath: string, maxBytes: number, label: string): Buffer {
  const fd = fsSync.openSync(filePath, "r");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(HASH_BUFFER_BYTES, maxBytes + 1));
  let bytes = 0;
  try {
    const stat = fsSync.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`${label} is not a regular file.`);
    }
    if (stat.size > maxBytes) {
      throw new SkillContentIntegrityLimitError(`${label} exceeds ${maxBytes} bytes.`);
    }
    for (;;) {
      const bytesRead = fsSync.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      bytes += bytesRead;
      if (bytes > maxBytes) {
        throw new SkillContentIntegrityLimitError(`${label} exceeds ${maxBytes} bytes.`);
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    fsSync.closeSync(fd);
  }
  return Buffer.concat(chunks, bytes);
}

async function readBoundedFile(filePath: string, maxBytes: number, label: string): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(HASH_BUFFER_BYTES, maxBytes + 1));
  let bytes = 0;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`${label} is not a regular file.`);
    }
    if (stat.size > maxBytes) {
      throw new SkillContentIntegrityLimitError(`${label} exceeds ${maxBytes} bytes.`);
    }
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) {
        break;
      }
      bytes += read.bytesRead;
      if (bytes > maxBytes) {
        throw new SkillContentIntegrityLimitError(`${label} exceeds ${maxBytes} bytes.`);
      }
      chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
    }
  } finally {
    await handle.close();
  }
  return Buffer.concat(chunks, bytes);
}

function buildManifest(files: SkillContentIntegrityFile[]): SkillContentIntegrityManifest {
  assertFileCount(files.length);
  const hash = createHash("sha256");
  hash.update(`${MANIFEST_VERSION}\0`, "utf8");
  let totalBytes = 0;
  for (const file of files) {
    assertFileSize(file.path, file.bytes);
    const pathBytes = Buffer.byteLength(file.path, "utf8");
    hash.update(`${pathBytes}:${file.path}\0${file.bytes}:${file.sha256}\0`, "utf8");
    totalBytes += file.bytes;
    assertTotalBytes(totalBytes);
  }
  return {
    manifestVersion: MANIFEST_VERSION,
    algorithm: "sha256",
    treeSha256: hash.digest("hex"),
    fileCount: files.length,
    totalBytes,
    excludedPaths: [...EXCLUDED_PATHS],
    files: files.map((file) => ({ ...file })),
  };
}

function assertEntryCount(count: number): void {
  if (count > SKILL_CONTENT_INTEGRITY_LIMITS.maxEntries) {
    throw new SkillContentIntegrityLimitError(
      `Skill import payload exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxEntries} filesystem entries.`,
    );
  }
}

function assertFileCount(count: number): void {
  if (count > SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles) {
    throw new SkillContentIntegrityLimitError(
      `Skill import payload exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles} files.`,
    );
  }
}

function assertFileSize(relativePath: string, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes) {
    throw new SkillContentIntegrityLimitError(
      `Skill import payload file ${relativePath} exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes} bytes.`,
    );
  }
}

function assertTotalBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes > SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes) {
    throw new SkillContentIntegrityLimitError(
      `Skill import payload exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes} total bytes.`,
    );
  }
}

function toRelativePath(root: string, fullPath: string): string {
  const relativePath = path.relative(root, fullPath).replaceAll("\\", "/");
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../") || path.posix.isAbsolute(relativePath)) {
    throw new Error(`Skill import payload path escaped its root: ${fullPath}`);
  }
  return relativePath;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
