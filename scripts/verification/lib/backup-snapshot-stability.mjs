import fs from "node:fs/promises";
import path from "node:path";

function normalizeRelativePath(value) {
  return value.replaceAll("\\", "/");
}

async function listJsonFiles(rootDir) {
  try {
    return (await fs.readdir(rootDir, { recursive: true }))
      .filter((entry) => entry.toLowerCase().endsWith(".json"))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function captureConfigJsonSnapshots(configDir, runtimeRoot) {
  const fileNames = await listJsonFiles(configDir);
  return Promise.all(
    fileNames.map(async (fileName) => {
      const absolutePath = path.join(configDir, fileName);
      return {
        absolutePath,
        relativePath: normalizeRelativePath(path.relative(runtimeRoot, absolutePath)),
        raw: await fs.readFile(absolutePath, "utf8"),
      };
    }),
  );
}

export async function findBackupConfigSnapshotDrift(configSnapshots, backupPayloadRoot) {
  const expected = new Map(configSnapshots.map((snapshot) => [snapshot.relativePath, snapshot.raw]));
  const backupConfigDir = path.join(backupPayloadRoot, "config");
  const backupFileNames = await listJsonFiles(backupConfigDir);
  const actual = new Map(
    await Promise.all(
      backupFileNames.map(async (fileName) => {
        const relativePath = normalizeRelativePath(path.join("config", fileName));
        return [relativePath, await fs.readFile(path.join(backupConfigDir, fileName), "utf8")];
      }),
    ),
  );
  const drift = [];
  for (const [relativePath, raw] of expected) {
    if (!actual.has(relativePath)) {
      drift.push(`missing:${relativePath}`);
    } else if (actual.get(relativePath) !== raw) {
      drift.push(`changed:${relativePath}`);
    }
  }
  for (const relativePath of actual.keys()) {
    if (!expected.has(relativePath)) drift.push(`unexpected:${relativePath}`);
  }
  return drift.sort((left, right) => left.localeCompare(right));
}

export async function removeBackupMutationFileWithRetry(filePath, options = {}) {
  const attempts = options.attempts ?? 8;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const remove = options.remove ?? ((targetPath) => fs.rm(targetPath, { force: true }));
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("backup mutation removal attempts must be positive");
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("backup mutation removal retry delay must be a nonnegative integer");
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await remove(filePath);
      return attempt;
    } catch (error) {
      const transient = error?.code === "EBUSY" || error?.code === "EPERM" || error?.code === "EACCES";
      if (!transient || attempt === attempts) throw error;
      await wait(retryDelayMs);
    }
  }
  throw new Error("backup mutation removal exhausted without an outcome");
}
