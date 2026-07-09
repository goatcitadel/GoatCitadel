import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SOURCE_ROOTS = ["apps", "packages", "scripts"];
const ROOT_FILES = [
  "coverage-policy.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "vitest.shared.ts",
];
const INCLUDED_EXTENSIONS = new Set([
  ".cjs",
  ".cs",
  ".js",
  ".jsx",
  ".json",
  ".mjs",
  ".ps1",
  ".rs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  "artifacts",
  "bin",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "obj",
  "target",
  "test-results",
]);

export async function buildCoverageSourceFingerprint(repoRoot) {
  const files = [];
  for (const rootName of SOURCE_ROOTS) {
    await collectFiles(path.join(repoRoot, rootName), files);
  }
  for (const fileName of ROOT_FILES) {
    const filePath = path.join(repoRoot, fileName);
    if (await isFile(filePath)) {
      files.push(filePath);
    }
  }
  files.sort((left, right) => normalize(repoRoot, left).localeCompare(normalize(repoRoot, right)));

  const hash = crypto.createHash("sha256");
  for (const filePath of files) {
    hash.update(normalize(repoRoot, filePath));
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function collectFiles(directory, out) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!isExcludedDirectory(entry.name)) {
        await collectFiles(path.join(directory, entry.name), out);
      }
      continue;
    }
    if (entry.isFile() && INCLUDED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(path.join(directory, entry.name));
    }
  }
}

function isExcludedDirectory(name) {
  return EXCLUDED_DIRECTORIES.has(name) || name.startsWith("coverage-");
}

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function normalize(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}
