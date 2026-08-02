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
