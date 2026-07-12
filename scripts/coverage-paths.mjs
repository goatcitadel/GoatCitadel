import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Produces the canonical key used to match source files with Istanbul entries.
 * Windows paths are case-insensitive; Linux/macOS paths are not.
 */
export function normalizeCoveragePathForLookup(inputPath, { platform = process.platform, cwd = process.cwd() } = {}) {
  const rawPath = String(inputPath);
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const decodedPath = /^file:/i.test(rawPath)
    ? fileURLToPath(rawPath, { windows: platform === "win32" })
    : rawPath;
  const normalized = platformPath.resolve(cwd, decodedPath).replaceAll("\\", "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
