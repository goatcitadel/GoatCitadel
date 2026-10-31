import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PLUGIN_LIMITS } from "@goatcitadel/contracts";
import { createTreePathTracker, isPortableTreePath } from "./hardened-git.js";

// Plugin snapshots: an immutable, content-addressed copy of a plugin folder.
//
// A snapshot is named by the SHA-256 of its files, written once (to a temp folder, then renamed into place) and only
// ever read. Nothing in one is executed, and the store itself creates only plain files and folders.

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const READ_CHUNK_BYTES = 64 * 1024;
/** Files and the folders around them: twice the file limit leaves room for the folders. */
const MAX_TREE_ENTRIES = PLUGIN_LIMITS.maxFiles * 2;
const DISCARD_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

export interface PluginSnapshot {
  treeSha256: string;
  /** `<root>/<treeSha256>` */
  dir: string;
}

/** A folder GoatCitadel won't take as a plugin: `UNSAFE_TREE` for what it holds, `TREE_OVER_LIMITS` for how much. */
export class PluginTreeRefusedError extends Error {
  public constructor(
    public readonly reason: "UNSAFE_TREE" | "TREE_OVER_LIMITS",
    message: string,
  ) {
    super(message);
    this.name = "PluginTreeRefusedError";
  }
}

class PluginTreeLimitError extends PluginTreeRefusedError {
  public constructor(message: string) {
    super("TREE_OVER_LIMITS", message);
    this.name = "PluginTreeLimitError";
  }
}

/** The path or the snapshot asked for isn't one this store can answer. */
export class PluginSnapshotPathError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PluginSnapshotPathError";
  }
}

export interface PluginTreeFile {
  /** Relative to the folder, with `/` separators. */
  relativePath: string;
  fullPath: string;
  bytes: number;
}

/**
 * The plugin folder's files, sorted by path, after every check a plugin tree has to pass.
 *
 * Each entry is read with `lstat`, so a link (a symbolic link, or a junction, which Windows reports as one) is refused
 * and never followed, as is a file with a second hard link, a device, a pipe or any entry that isn't a plain file or
 * folder. Paths must be portable (NFKC, no `..`, no `.git`, no Windows device names) and must not collide on a
 * case-insensitive disk. Files, bytes and entries are counted against `PLUGIN_LIMITS` as the walk goes, so a huge
 * folder is refused after a few hundred entries, not after reading it. Folders that hold no file are not part of a
 * plugin's files.
 *
 * With `skipVcsMetadata`, anything named `.git` (any case, file or folder, at any depth) is left out without being
 * opened, counted or followed, instead of being refused as a name that can't be used. Only a copy of a folder on this
 * computer asks for that; a fetched Git tree can't hold one, and the store never skips it.
 */
export async function listPluginTree(
  rootDir: string,
  options: { skipVcsMetadata?: boolean } = {},
): Promise<PluginTreeFile[]> {
  const root = path.resolve(rootDir);
  const rootInfo = await fs.lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw unsafe("The plugin folder must be a plain folder, not a link or a file.");
  }
  const admitPath = createTreePathTracker("The plugin folder", MAX_TREE_ENTRIES, PluginTreeLimitError);
  const files: PluginTreeFile[] = [];
  const pending: Array<{ dir: string; prefix: string }> = [{ dir: root, prefix: "" }];
  let entries = 0;
  let totalBytes = 0;

  for (let next = pending.pop(); next; next = pending.pop()) {
    for (const name of (await fs.readdir(next.dir)).sort()) {
      if (options.skipVcsMetadata && name.toLowerCase() === ".git") continue;
      entries += 1;
      if (entries > MAX_TREE_ENTRIES) {
        throw new PluginTreeLimitError(`A plugin can hold at most ${MAX_TREE_ENTRIES} files and folders.`);
      }
      const relativePath = next.prefix ? `${next.prefix}/${name}` : name;
      if (!isPortableTreePath(relativePath)) {
        throw unsafe(`${relativePath} has a name that can't be used in a plugin.`);
      }
      const fullPath = path.join(next.dir, name);
      const info = await fs.lstat(fullPath);
      if (info.isSymbolicLink()) {
        throw unsafe(`${relativePath} is a link. A plugin can hold only plain files and folders.`);
      }
      if (info.isDirectory()) {
        pending.push({ dir: fullPath, prefix: relativePath });
        continue;
      }
      if (!info.isFile()) throw unsafe(`${relativePath} isn't a plain file or folder.`);
      if (info.nlink > 1)
        throw unsafe(`${relativePath} is linked to another file. A plugin can hold only plain files.`);
      if (files.length + 1 > PLUGIN_LIMITS.maxFiles) {
        throw new PluginTreeLimitError(`A plugin can hold at most ${PLUGIN_LIMITS.maxFiles} files.`);
      }
      if (info.size > PLUGIN_LIMITS.maxFileBytes) {
        throw new PluginTreeLimitError(
          `${relativePath} is over ${formatMebibytes(PLUGIN_LIMITS.maxFileBytes)}, which is the most one file can be.`,
        );
      }
      totalBytes += info.size;
      if (totalBytes > PLUGIN_LIMITS.maxTotalBytes) {
        throw new PluginTreeLimitError(
          `A plugin can hold at most ${formatMebibytes(PLUGIN_LIMITS.maxTotalBytes)} in all.`,
        );
      }
      try {
        admitPath(relativePath);
      } catch (error) {
        throw error instanceof PluginTreeRefusedError ? error : unsafe((error as Error).message);
      }
      files.push({ relativePath, fullPath, bytes: info.size });
    }
  }
  return files.sort((a, b) => compareCodeUnits(a.relativePath, b.relativePath));
}

/**
 * Reads one file from a listed tree. `bytes` is the size `listPluginTree` saw; a file that has since grown or shrunk is
 * refused, and the read never goes past `PLUGIN_LIMITS.maxFileBytes`.
 */
export async function readPluginFileBounded(file: PluginTreeFile): Promise<Buffer> {
  // O_NOFOLLOW (where the platform has it) keeps a file swapped for a link after the listing from being followed.
  const handle = await fs.open(file.fullPath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, PLUGIN_LIMITS.maxFileBytes + 1 - total));
      if (chunk.byteLength === 0) break;
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total !== file.bytes) throw unsafe(`${file.relativePath} changed while it was being read.`);
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export class PluginSnapshotStore {
  private readonly root: string;

  /** `<rootDir>/<assistant.dataDir>/plugins/snapshots` */
  public constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * Hashes a folder and moves it into place as a snapshot. The folder is consumed: it is renamed into the store, or
   * deleted when that content is already there, so it must be a temp copy the caller made and no longer needs. It
   * should sit on the same volume as the store, since a rename can't cross one.
   *
   * Two writers that race on the same content both succeed: the one whose rename finds the snapshot already there
   * deletes its copy and answers the snapshot that won.
   */
  public async importDirectory(sourceDir: string): Promise<PluginSnapshot> {
    const files = await listPluginTree(sourceDir);
    const lines: string[] = [];
    for (const file of files) {
      const content = await readPluginFileBounded(file);
      lines.push(`${file.relativePath}\u0000${sha256Hex(content)}\n`);
    }
    const treeSha256 = sha256Hex(lines.join(""));
    const snapshot: PluginSnapshot = { treeSha256, dir: path.join(this.root, treeSha256) };

    await fs.mkdir(this.root, { recursive: true });
    if (isPlainDirectory(snapshot.dir)) {
      await fs.rm(sourceDir, DISCARD_OPTIONS);
      return snapshot;
    }
    try {
      await fs.rename(sourceDir, snapshot.dir);
    } catch (error) {
      // A rename onto a folder that is already there fails (EPERM on Windows, ENOTEMPTY or EEXIST elsewhere): another
      // writer got there first, and that is the answer.
      if (!isPlainDirectory(snapshot.dir)) throw error;
      await fs.rm(sourceDir, DISCARD_OPTIONS);
    }
    return snapshot;
  }

  /**
   * The folder of a snapshot, or of a path inside it. The answer is built only from the hash and a checked relative
   * path, and the path need not exist. Throws when the hash isn't a SHA-256, no such snapshot is stored, or the path
   * is absolute, climbs out, or isn't a portable path.
   */
  public resolve(treeSha256: string, relativePath?: string): string {
    if (!SHA256_PATTERN.test(treeSha256))
      throw new PluginSnapshotPathError("That isn't the id of a stored plugin copy.");
    const snapshotDir = path.join(this.root, treeSha256);
    if (!isPlainDirectory(snapshotDir)) throw new PluginSnapshotPathError("That plugin copy isn't on this computer.");
    if (relativePath === undefined || relativePath === "") return snapshotDir;
    if (!isPortableTreePath(relativePath))
      throw new PluginSnapshotPathError("That path is outside the plugin's files.");
    const resolved = path.resolve(snapshotDir, ...relativePath.split("/"));
    const relation = path.relative(snapshotDir, resolved);
    if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
      throw new PluginSnapshotPathError("That path is outside the plugin's files.");
    }
    return resolved;
  }
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainDirectory(target: string): boolean {
  try {
    const info = fsSync.lstatSync(target);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function unsafe(message: string): PluginTreeRefusedError {
  return new PluginTreeRefusedError("UNSAFE_TREE", message);
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function formatMebibytes(bytes: number): string {
  return `${Number((bytes / (1024 * 1024)).toFixed(2))} MiB`;
}
