import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const WINDOWS_CMD_PATH = "C:\\Windows\\System32\\cmd.exe";

export function removeDirectorySafely(targetPath, options) {
  const resolved = assertSafeRecursiveCleanup(targetPath, options);
  if (!fs.existsSync(resolved.targetPath)) {
    return;
  }
  try {
    fs.rmSync(resolved.targetPath, { recursive: true, force: true });
    return;
  } catch {
    if (process.platform !== "win32") {
      throw new Error(`Unable to remove existing directory: ${resolved.targetPath}`);
    }
    const result = spawnSync(WINDOWS_CMD_PATH, ["/d", "/s", "/c", "rmdir", "/s", "/q", resolved.targetPath], {
      cwd: resolved.repoRoot,
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Unable to remove existing directory: ${resolved.targetPath}`);
    }
  }
}

export function assertSafeRecursiveCleanup(targetPath, options) {
  if (!options?.repoRoot) {
    throw new Error("Safe cleanup requires repoRoot.");
  }
  if (!options?.allowedRoot) {
    throw new Error("Safe cleanup requires allowedRoot.");
  }
  const repoRoot = normalizePath(path.resolve(options.repoRoot));
  const allowedRoot = normalizePath(path.resolve(options.allowedRoot));
  const target = normalizePath(path.resolve(targetPath));
  const cwd = normalizePath(path.resolve(options.cwd ?? process.cwd()));
  const root = normalizePath(path.parse(target).root);

  if (target === root) {
    throw new Error(`Refusing recursive cleanup of filesystem root: ${target}`);
  }
  if (target === repoRoot) {
    throw new Error(`Refusing recursive cleanup of repo root: ${target}`);
  }
  if (target === cwd) {
    throw new Error(`Refusing recursive cleanup of current working directory: ${target}`);
  }
  if (isAncestorPath(target, cwd)) {
    throw new Error(`Refusing recursive cleanup of an ancestor of cwd: ${target}`);
  }
  if (!isSameOrChildPath(target, allowedRoot)) {
    throw new Error(`Refusing recursive cleanup outside allowed root ${allowedRoot}: ${target}`);
  }
  return {
    targetPath: target,
    allowedRoot,
    repoRoot,
    cwd,
  };
}

function normalizePath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameOrChildPath(candidate, parent) {
  if (candidate === parent) {
    return true;
  }
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isAncestorPath(candidate, child) {
  if (candidate === child) {
    return false;
  }
  const relative = path.relative(candidate, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
