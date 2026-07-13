import fs from "node:fs/promises";

export async function publishStagedGallery({ stagedOutputDir, outputDir, backupDir, expectedFiles }) {
  for (const fileName of expectedFiles) {
    const stagedPath = new URL(fileName, pathToDirectoryUrl(stagedOutputDir));
    const stat = await fs.stat(stagedPath);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(`Screenshot gallery staging artifact is empty or missing: ${fileName}`);
    }
  }

  await fs.rm(backupDir, { recursive: true, force: true });
  const outputExists = await pathExists(outputDir);
  try {
    if (outputExists) {
      await fs.rename(outputDir, backupDir);
    }
    await fs.rename(stagedOutputDir, outputDir);
    await fs.rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (!(await pathExists(outputDir)) && (await pathExists(backupDir))) {
      await fs.rename(backupDir, outputDir).catch(() => undefined);
    }
    throw error;
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function pathToDirectoryUrl(directoryPath) {
  const normalized = directoryPath.replaceAll("\\", "/").replace(/\/?$/u, "/");
  return new URL(`file:///${normalized}`);
}
