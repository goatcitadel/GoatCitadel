import fs from "node:fs/promises";
import path from "node:path";

export async function collectVisualBaselineCoverage(baselineDirectory, expectedFiles) {
  const normalizedExpected = [...new Set(expectedFiles)].sort();
  const actualFiles = await listPngFiles(baselineDirectory);
  const expectedSet = new Set(normalizedExpected);
  const actualSet = new Set(actualFiles);
  return {
    baselineDirectory,
    expectedFiles: normalizedExpected,
    actualFiles,
    missingFiles: normalizedExpected.filter((fileName) => !actualSet.has(fileName)),
    unexpectedFiles: actualFiles.filter((fileName) => !expectedSet.has(fileName)),
  };
}

async function listPngFiles(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".png")
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
