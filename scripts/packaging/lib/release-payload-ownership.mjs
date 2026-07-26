import fs from "node:fs";
import path from "node:path";

export function materializeHardLinkedFiles(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const rootStats = fs.lstatSync(resolvedRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Deployment root must be a regular non-link directory: ${rootDir}`);
  }

  const queue = [resolvedRoot];
  let materializedCount = 0;
  let temporaryFileSequence = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const currentDir = queue[cursor];
    for (const entryName of fs.readdirSync(currentDir).sort(compareStrings)) {
      const entryPath = path.join(currentDir, entryName);
      const stats = fs.lstatSync(entryPath);
      if (stats.isSymbolicLink()) {
        continue;
      }
      if (stats.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (!stats.isFile() || stats.nlink === 1) {
        continue;
      }

      temporaryFileSequence += 1;
      const temporaryPath = path.join(currentDir, `.gc-own-${process.pid}-${temporaryFileSequence}.tmp`);
      try {
        fs.copyFileSync(entryPath, temporaryPath, fs.constants.COPYFILE_EXCL);
        const copiedStats = fs.lstatSync(temporaryPath);
        if (!copiedStats.isFile() || copiedStats.isSymbolicLink() || copiedStats.nlink !== 1) {
          throw new Error(`Failed to create an independently owned payload file: ${entryPath}`);
        }
        if (copiedStats.size !== stats.size) {
          throw new Error(`Materialized payload file changed size: ${entryPath}`);
        }
        fs.renameSync(temporaryPath, entryPath);
        const replacedStats = fs.lstatSync(entryPath);
        if (!replacedStats.isFile() || replacedStats.isSymbolicLink() || replacedStats.nlink !== 1) {
          throw new Error(`Payload file remains hard-linked after materialization: ${entryPath}`);
        }
        if (replacedStats.size !== stats.size) {
          throw new Error(`Materialized payload replacement changed size: ${entryPath}`);
        }
        materializedCount += 1;
      } finally {
        fs.rmSync(temporaryPath, { force: true });
      }
    }
  }

  return materializedCount;
}

export function removeEmptyDirectories(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const rootStats = fs.lstatSync(resolvedRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Release payload root must be a regular non-link directory: ${rootDir}`);
  }

  let removedCount = 0;
  visitDirectory(resolvedRoot, true);
  return removedCount;

  function visitDirectory(currentDir, isRoot) {
    for (const entryName of fs.readdirSync(currentDir).sort(compareStrings)) {
      const entryPath = path.join(currentDir, entryName);
      const stats = fs.lstatSync(entryPath);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        visitDirectory(entryPath, false);
      }
    }
    if (!isRoot && fs.readdirSync(currentDir).length === 0) {
      fs.rmdirSync(currentDir);
      removedCount += 1;
    }
  }
}

function compareStrings(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}
