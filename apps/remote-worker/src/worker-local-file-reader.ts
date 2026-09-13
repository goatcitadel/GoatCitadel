import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { workerMeshRejected } from "./worker-mesh-capability-data.js";

export const workerLocalPathEqual = (left: string, right: string): boolean =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

/** Literal components only: no alternate streams, device names, aliases or traversal. */
export function assertWorkerLocalPathPart(part: string): void {
  if (!part || part === "." || part === ".." || part.length > 255 ||
    /[<>:"/\\|?*]/u.test(part) || [...part].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || /[. ]$/u.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)) throw workerMeshRejected();
}

/** Refuse network/device paths and every symlink/junction in the named ancestry. */
export async function inspectWorkerLocalPath(file: string, signal: AbortSignal): Promise<BigIntStats> {
  signal.throwIfAborted();
  if (!path.isAbsolute(file) || !workerLocalPathEqual(path.resolve(file), file) ||
    (process.platform === "win32" && !/^[a-z]:\\/iu.test(file))) throw workerMeshRejected();
  const root = path.parse(file).root;
  const parts = file.slice(root.length).split(path.sep);
  if (parts.length > 32) throw workerMeshRejected();
  let current = root;
  let metadata = await lstat(root, { bigint: true });
  for (const [index, part] of parts.entries()) {
    assertWorkerLocalPathPart(part);
    current = path.join(current, part);
    metadata = await lstat(current, { bigint: true });
    signal.throwIfAborted();
    if (metadata.isSymbolicLink() || (index < parts.length - 1 && !metadata.isDirectory())) throw workerMeshRejected();
  }
  if (!workerLocalPathEqual(await realpath(file), file)) throw workerMeshRejected();
  signal.throwIfAborted();
  return metadata;
}

export function sameWorkerLocalFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

/** Check the opened file's identity before copying bytes, then check for content/path drift.
 * These are trusted file-tool checks, not an OS sandbox for executable code. */
export async function readWorkerLocalFile(
  file: string, maxBytes: number, signal: AbortSignal, checkScope: () => Promise<void> = async () => undefined,
): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024) throw workerMeshRejected();
    const named = await inspectWorkerLocalPath(file, signal);
    if (!named.isFile() || named.nlink !== 1n || named.size > BigInt(maxBytes)) throw workerMeshRejected();
    handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    const verify = async () => {
      signal.throwIfAborted();
      const current = await inspectWorkerLocalPath(file, signal);
      const held = await handle!.stat({ bigint: true });
      if (!held.isFile() || held.nlink !== 1n || !sameWorkerLocalFile(named, opened) ||
        !sameWorkerLocalFile(opened, held) || !sameWorkerLocalFile(held, current) ||
        held.size !== opened.size || held.mtimeNs !== opened.mtimeNs || held.ctimeNs !== opened.ctimeNs ||
        held.size > BigInt(maxBytes)) throw workerMeshRejected();
      await checkScope();
      signal.throwIfAborted();
    };
    await verify();
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > maxBytes || BigInt(length) !== opened.size) throw workerMeshRejected();
    await verify();
    return bytes.subarray(0, length);
  } catch {
    // File paths, operating-system errors and file content never enter the report.
    throw workerMeshRejected();
  } finally {
    await handle?.close();
  }
}
