import fs from "node:fs/promises";
import path from "node:path";

// Moved out of backup-retention-service.ts unchanged, to keep that file under the line cap.

export function ensurePathWithinRoot(targetPath: string, rootDir: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error("Path escapes allowed root");
}

interface PublishedBackupIdentity {
  size: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

export async function assertStablePublishedBackupDirectory(
  backupPath: string,
  backupRoot: string,
  expected: PublishedBackupIdentity,
): Promise<PublishedBackupIdentity> {
  const before = await readPublishedBackupIdentity(backupPath);
  if (!samePublishedBackupIdentity(before, expected)) {
    throw new Error("Published backup changed before trust inspection could bind its bytes.");
  }
  const [realRoot, realBackup] = await Promise.all([fs.realpath(backupRoot), fs.realpath(backupPath)]);
  ensurePathWithinRoot(realBackup, realRoot);
  const after = await readPublishedBackupIdentity(backupPath);
  if (!samePublishedBackupIdentity(before, after)) {
    throw new Error("Published backup changed while trust inspection resolved its path.");
  }
  return after;
}

async function readPublishedBackupIdentity(backupPath: string): Promise<PublishedBackupIdentity> {
  const stats = await fs.lstat(backupPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Published backup must be a stable directory, not a link.");
  }
  return {
    size: stats.size,
    dev: stats.dev,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
  };
}

function samePublishedBackupIdentity(left: PublishedBackupIdentity, right: PublishedBackupIdentity): boolean {
  return (
    left.size === right.size &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs
  );
}
