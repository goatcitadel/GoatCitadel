import { createHash } from "node:crypto";
import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ConflictError, PLUGIN_LIMITS } from "@goatcitadel/contracts";
import { TEMP_REMOVAL_OPTIONS, createTreePathTracker, isPortableTreePath, treeEntryLimit } from "./hardened-git.js";

// Plugin snapshots: an immutable, content-addressed copy of a plugin folder.
//
// A snapshot is named by the SHA-256 of its files, written once (to a temp folder, then renamed into place) and only
// ever read. Nothing in one is executed, and the store itself creates only plain files and folders.

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
/** A snapshot younger than this is never swept: an inspection may have imported it and not saved yet. */
export const SNAPSHOT_SWEEP_GRACE_MS = 60 * 60 * 1000;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_TREE_ENTRIES = treeEntryLimit(PLUGIN_LIMITS.maxFiles);
const FOLDER_CHANGED_MESSAGE = "The folder changed while it was being copied.";

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

/**
 * 409: a snapshot's files no longer hash to its name, or it is gone. Something on this computer changed the copy that
 * was checked, so nothing is installed from it.
 */
export class PluginSnapshotChangedError extends ConflictError {
  public constructor() {
    super({
      message: "This plugin's files changed on this computer since it was checked. Check it again.",
      details: { reason: "PLUGIN_SNAPSHOT_CHANGED" },
    });
    this.name = "PluginSnapshotChangedError";
  }
}

export interface PluginTreeFile {
  /** Relative to the folder, with `/` separators. */
  relativePath: string;
  fullPath: string;
  bytes: number;
  /** The device and file id the listing saw (0 where the platform gives none), so a read can tell the file was swapped. */
  dev: bigint;
  ino: bigint;
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
    const names: string[] = [];
    // One entry at a time, counted as it is read: a huge folder is refused at the limit, never read in full.
    for await (const entry of await fs.opendir(next.dir)) {
      if (options.skipVcsMetadata && entry.name.toLowerCase() === ".git") continue;
      entries += 1;
      if (entries > MAX_TREE_ENTRIES) {
        throw new PluginTreeLimitError(`A plugin can hold at most ${MAX_TREE_ENTRIES} files and folders.`);
      }
      names.push(entry.name);
    }
    for (const name of names.sort()) {
      const relativePath = next.prefix ? `${next.prefix}/${name}` : name;
      if (!isPortableTreePath(relativePath)) {
        throw unsafe(`${relativePath} has a name that can't be used in a plugin.`);
      }
      const fullPath = path.join(next.dir, name);
      const info = await fs.lstat(fullPath, { bigint: true });
      if (info.isSymbolicLink()) {
        throw unsafe(`${relativePath} is a link. A plugin can hold only plain files and folders.`);
      }
      if (info.isDirectory()) {
        pending.push({ dir: fullPath, prefix: relativePath });
        continue;
      }
      if (!info.isFile()) throw unsafe(`${relativePath} isn't a plain file or folder.`);
      if (info.nlink > 1n)
        throw unsafe(`${relativePath} is linked to another file. A plugin can hold only plain files.`);
      if (files.length + 1 > PLUGIN_LIMITS.maxFiles) {
        throw new PluginTreeLimitError(`A plugin can hold at most ${PLUGIN_LIMITS.maxFiles} files.`);
      }
      const bytes = Number(info.size);
      if (bytes > PLUGIN_LIMITS.maxFileBytes) {
        throw new PluginTreeLimitError(
          `${relativePath} is over ${formatMebibytes(PLUGIN_LIMITS.maxFileBytes)}, which is the most one file can be.`,
        );
      }
      totalBytes += bytes;
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
      files.push({ relativePath, fullPath, bytes, dev: info.dev, ino: info.ino });
    }
  }
  return files.sort((a, b) => compareCodeUnits(a.relativePath, b.relativePath));
}

/**
 * Reads one file from a listed tree. The open file must be the one the listing saw: a plain file with one link, the
 * same size, and (where the platform reports them) the same device and file id. A file swapped, linked or resized since
 * is refused, and the read never goes past `PLUGIN_LIMITS.maxFileBytes`.
 */
export async function readPluginFileBounded(file: PluginTreeFile): Promise<Buffer> {
  // O_NOFOLLOW (where the platform has it) keeps a file swapped for a link after the listing from being followed.
  const handle = await fs.open(file.fullPath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
  try {
    if (!matchesListing(await handle.stat({ bigint: true }), file)) throw unsafe(FOLDER_CHANGED_MESSAGE);
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
    if (total !== file.bytes) throw unsafe(FOLDER_CHANGED_MESSAGE);
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
   * When it throws (the folder is refused, can't be read, or can't be renamed) the folder is left where it is for the
   * caller to remove, and no partial snapshot is left in the store: only the rename adds one, so it is whole or absent.
   *
   * Two writers that race on the same content both succeed: the one whose rename finds the snapshot already there
   * deletes its copy and answers the snapshot that won.
   */
  public async importDirectory(sourceDir: string): Promise<PluginSnapshot> {
    const treeSha256 = await pluginTreeSha256(await listPluginTree(sourceDir));
    const snapshot: PluginSnapshot = { treeSha256, dir: path.join(this.root, treeSha256) };

    await fs.mkdir(this.root, { recursive: true });
    if (isPlainDirectory(snapshot.dir)) {
      await fs.rm(sourceDir, TEMP_REMOVAL_OPTIONS);
      return snapshot;
    }
    try {
      await fs.rename(sourceDir, snapshot.dir);
    } catch (renameError) {
      // A rename onto a folder that is already there fails (EPERM on Windows, ENOTEMPTY or EEXIST elsewhere): another
      // writer got there first, and that is the answer. Otherwise the rename's own error is the one thrown.
      if (!wonByAnotherWriter(snapshot.dir, renameError)) throw renameError;
      await fs.rm(sourceDir, TEMP_REMOVAL_OPTIONS);
    }
    return snapshot;
  }

  /**
   * Checks a snapshot's files on disk still hash to its name, by the same listing and formula an import uses. Throws
   * `PluginSnapshotChangedError` when they don't, when the folder now holds something a plugin can't (a link, a second
   * hard link, a name that can't be used), or when the snapshot is gone; any other I/O error is thrown as it is.
   */
  public async verify(treeSha256: string): Promise<void> {
    let actual: string;
    try {
      actual = await pluginTreeSha256(await listPluginTree(this.resolve(treeSha256)));
    } catch (error) {
      if (error instanceof PluginSnapshotPathError || error instanceof PluginTreeRefusedError) {
        throw new PluginSnapshotChangedError();
      }
      throw error;
    }
    if (actual !== treeSha256) throw new PluginSnapshotChangedError();
  }

  /**
   * Removes the stored snapshots nothing keeps. Only folders named by a SHA-256 are considered, so anything else in
   * the store is left alone, and one modified less than `olderThanMs` ago is kept even when it isn't in `keep`, since
   * an inspection may have imported it and not yet saved. A folder that can't be removed throws after the rest were tried.
   */
  public async sweep(
    keep: ReadonlySet<string>,
    options: { olderThanMs: number; now?: number },
  ): Promise<{ removed: string[] }> {
    const now = options.now ?? Date.now();
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: [] };
      throw error;
    }
    const removed: string[] = [];
    let failure: unknown;
    for (const name of names) {
      if (!SHA256_PATTERN.test(name) || keep.has(name)) continue;
      const dir = path.join(this.root, name);
      try {
        const info = await fs.lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink() || now - info.mtimeMs < options.olderThanMs) continue;
        await fs.rm(dir, TEMP_REMOVAL_OPTIONS);
        removed.push(name);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
    return { removed };
  }

  /**
   * The folder of a snapshot, or of a path inside it. The answer is built only from the hash and a checked relative
   * path, and the path need not exist. Throws a `PluginSnapshotPathError` when the hash isn't a SHA-256, no such snapshot
   * is stored, or the path is absolute, climbs out, or isn't a portable path, and the raw I/O error when the snapshot's
   * folder can't be looked at (a permission error, say).
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

/**
 * A listed tree's hash: the SHA-256 of one `<relative path>\0<SHA-256 of its bytes>\n` line per file, in the listing's
 * code-unit order. Every file is read through `readPluginFileBounded`, so one swapped or resized since is refused.
 */
async function pluginTreeSha256(files: readonly PluginTreeFile[]): Promise<string> {
  const lines: string[] = [];
  for (const file of files) {
    const content = await readPluginFileBounded(file);
    lines.push(`${file.relativePath}\u0000${sha256Hex(content)}\n`);
  }
  return sha256Hex(lines.join(""));
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Whether `target` is a real folder. Only "not there" (ENOENT, ENOTDIR) answers no; any other failure is thrown. */
function isPlainDirectory(target: string): boolean {
  try {
    const info = fsSync.lstatSync(target);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * After a failed rename, whether the snapshot is there as a real folder: another writer's rename won. When that can't be
 * looked at either, the answer is no, so the rename's own error is thrown, carrying the failed look as its `cause`
 * (unless it already has one): the look is context, never a replacement.
 */
function wonByAnotherWriter(snapshotDir: string, renameError: unknown): boolean {
  try {
    return isPlainDirectory(snapshotDir);
  } catch (lookError) {
    if (renameError instanceof Error && renameError.cause === undefined) {
      Object.defineProperty(renameError, "cause", { value: lookError, configurable: true, writable: true });
    }
    return false;
  }
}

/** Whether an open file is the one the listing saw. A device or file id of 0 means the platform gave none. */
function matchesListing(opened: BigIntStats, file: PluginTreeFile): boolean {
  if (!opened.isFile() || opened.nlink !== 1n || Number(opened.size) !== file.bytes) return false;
  if (file.dev !== 0n && opened.dev !== 0n && opened.dev !== file.dev) return false;
  if (file.ino !== 0n && opened.ino !== 0n && opened.ino !== file.ino) return false;
  return true;
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
