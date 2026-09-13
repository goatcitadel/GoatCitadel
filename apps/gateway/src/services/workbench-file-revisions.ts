import fs, { type FileHandle } from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";

export const WORKBENCH_WRITE_LOCK = ".goatcitadel-workbench.lock";
const MAX_FILE_BYTES = 256 * 1024;

export interface WorkbenchFileScope {
  sessionId: string;
  projectId: string;
  projectRoot: string;
  relativePath: string;
  /** Rechecks the owner's jail and realpath rules before opening and writing. */
  assertAllowed(targetPath: string): void;
}

export interface WorkbenchFileSnapshot {
  revision: string;
  stat: BigIntStats;
  content: Buffer;
}

export function workbenchFileConflict(): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message: "This file changed since editing began. Review the latest file before saving your retained draft.",
    details: { reason: "WORKBENCH_FILE_REVISION_CONFLICT" },
  });
}

/** Coordinates Gateway processes sharing this physical project, without stealing locks. */
export async function withWorkbenchWriteLock<T>(projectRoot: string, action: () => Promise<T>): Promise<T> {
  const canonicalRoot = await fs.realpath(projectRoot);
  const lockPath = path.join(canonicalRoot, WORKBENCH_WRITE_LOCK);
  const deadline = Date.now() + 5_000;
  let lock: FileHandle;
  for (;;) {
    try {
      lock = await fs.open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Another Workbench operation holds this project's write lock. Retry after it finishes. If a Gateway stopped unexpectedly, inspect the retained lock before recovery.",
          details: { reason: "WORKBENCH_WRITE_LOCK_BUSY" },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  let ownedStat: BigIntStats | undefined;
  try {
    ownedStat = await lock.stat({ bigint: true });
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
    return await action();
  } finally {
    await lock.close();
    const current = await fs.lstat(lockPath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (ownedStat && current && sameFileIdentity(ownedStat, current)) await fs.unlink(lockPath);
  }
}

export async function readWorkbenchFileSnapshot(scope: WorkbenchFileScope): Promise<WorkbenchFileSnapshot> {
  const targetPath = path.resolve(scope.projectRoot, scope.relativePath);
  scope.assertAllowed(targetPath);
  let handle: FileHandle;
  try {
    handle = await fs.open(targetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NotFoundError({ entity: "Workbench file", id: scope.relativePath });
    }
    throw error;
  }
  try {
    return await snapshotFromHandle(scope, targetPath, handle);
  } finally {
    await handle.close();
  }
}

/** Caller must hold withWorkbenchWriteLock for this project. */
export async function writeWorkbenchFileSnapshot(
  scope: WorkbenchFileScope,
  input: { content: string; expectedRevision: string | null },
  onWriteStarted: () => void,
): Promise<WorkbenchFileSnapshot> {
  if (input.expectedRevision !== null && !/^[a-f0-9]{64}$/.test(input.expectedRevision ?? "")) {
    throw new ValidationError({ message: "An expected file revision is required. Read the file before saving." });
  }
  const content = Buffer.from(input.content, "utf8");
  if (content.length > MAX_FILE_BYTES) {
    throw new ValidationError({ message: `File exceeds ${MAX_FILE_BYTES} bytes and is too large for the workbench editor.` });
  }
  const targetPath = path.resolve(scope.projectRoot, scope.relativePath);
  const entry = await fs.lstat(targetPath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (entry?.isSymbolicLink()) {
    throw new ValidationError({ message: "Open the original file to save changes; symbolic-link writes are not supported." });
  }
  if (entry?.isDirectory()) throw new ValidationError({ message: `Path is a directory: ${scope.relativePath}` });
  if (entry && (!entry.isFile() || entry.nlink !== 1n)) {
    throw new ValidationError({ message: "Workbench saves require a regular file with one filesystem link." });
  }
  if (entry) scope.assertAllowed(targetPath);
  else {
    const parent = await fs.stat(path.dirname(targetPath)).catch(() => undefined);
    if (!parent?.isDirectory()) throw new ValidationError({ message: `Parent directory does not exist for ${scope.relativePath}.` });
    scope.assertAllowed(path.dirname(targetPath));
  }
  if ((input.expectedRevision === null) !== !entry) throw workbenchFileConflict();
  let handle: FileHandle;
  try {
    handle = await fs.open(targetPath, entry
      ? constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      : "wx+", 0o600);
  } catch (error) {
    if (["EEXIST", "ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw workbenchFileConflict();
    throw error;
  }
  // Creation has already crossed the filesystem mutation boundary.
  if (!entry) onWriteStarted();
  try {
    const before = await snapshotFromHandle(scope, targetPath, handle);
    if (entry && (before.revision !== input.expectedRevision || !sameFileIdentity(entry, before.stat))) {
      throw workbenchFileConflict();
    }
    if (before.content.subarray(0, 8192).includes(0)) {
      throw new ValidationError({ message: `File is not a text file and cannot be opened in the workbench editor: ${scope.relativePath}` });
    }
    // Recheck immediately before I/O; the descriptor preserves the opened identity.
    scope.assertAllowed(targetPath);
    const current = await snapshotFromHandle(scope, targetPath, handle);
    if (current.revision !== before.revision || current.stat.nlink !== 1n) throw workbenchFileConflict();
    onWriteStarted();
    let offset = 0;
    while (offset < content.length) {
      const result = await handle.write(content, offset, content.length - offset, offset);
      if (result.bytesWritten === 0) throw new Error("Workbench file write made no progress.");
      offset += result.bytesWritten;
    }
    await handle.truncate(content.length);
    await handle.sync();
    const saved = await snapshotFromHandle(scope, targetPath, handle);
    if (!saved.content.equals(content)) throw workbenchFileConflict();
    return saved;
  } finally {
    await handle.close();
  }
}

async function snapshotFromHandle(
  scope: WorkbenchFileScope,
  targetPath: string,
  handle: FileHandle,
): Promise<WorkbenchFileSnapshot> {
  const before = await handle.stat({ bigint: true });
  if (before.isDirectory()) throw new ValidationError({ message: `Path is a directory: ${scope.relativePath}` });
  if (!before.isFile()) throw new ValidationError({ message: "Workbench reads require a regular file." });
  if (before.size > BigInt(MAX_FILE_BYTES)) {
    throw new ValidationError({ message: `File exceeds ${MAX_FILE_BYTES} bytes and is too large for the workbench viewer.` });
  }
  const buffer = Buffer.alloc(Number(before.size) + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const stat = await handle.stat({ bigint: true });
  scope.assertAllowed(targetPath);
  const atPath = await fs.lstat(targetPath, { bigint: true });
  if (statFingerprint(before) !== statFingerprint(stat) || offset !== Number(stat.size)
    || !sameFileIdentity(stat, atPath) || atPath.isSymbolicLink()) throw workbenchFileConflict();
  const content = buffer.subarray(0, offset);
  const revision = createHash("sha256")
    .update(JSON.stringify(["workbench-file-v1", scope.sessionId, scope.projectId,
      await fs.realpath(scope.projectRoot), scope.relativePath, await fs.realpath(targetPath), statFingerprint(stat)]))
    .update(content)
    .digest("hex");
  return { revision, stat, content };
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function statFingerprint(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.mtimeNs, stat.size, stat.mode, stat.nlink].join(":");
}
