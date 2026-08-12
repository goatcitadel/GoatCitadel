import path from "node:path";

export const READ_ONLY_EXPLORER_PERMISSION_PROFILE_ID = "system-read-only-workspace-explorer";

const FILE_URL_PATTERN = /file:(?:\/\/)?[^\s<>"'`]+/giu;
const WINDOWS_DRIVE_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s<>"'`|?*]+/gu;
const WINDOWS_UNC_PATH_PATTERN = /\\\\[^\\/\s<>"'`|?*]+[\\/][^\s<>"'`|?*]+(?:[\\/][^\s<>"'`|?*]+)*/gu;
const POSIX_PATH_PATTERN = /(^|[^A-Za-z0-9/])\/(?!\/)[^\s<>"'`),;|}\]]+/gu;

/**
 * Explorer-only privacy projection. The server-owned delegated root is the
 * sole authority for converting absolute paths to workspace-relative paths.
 * Absolute paths outside that root are represented by a content-free marker.
 */
export function projectWorkspaceExplorerPathValue<T>(value: T, rootPaths: readonly string[]): T {
  if (typeof value === "string") {
    return projectWorkspaceExplorerText(value, rootPaths) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => projectWorkspaceExplorerPathValue(item, rootPaths)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const projectedEntries: Array<[string, unknown]> = [];
  const projectedKeys = new Set<string>();
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const projectedKeyStem = projectWorkspaceExplorerText(key, rootPaths);
    let projectedKey = projectedKeyStem;
    for (let suffix = 2; projectedKeys.has(projectedKey); suffix += 1) {
      projectedKey = `${projectedKeyStem}#${suffix}`;
    }
    projectedKeys.add(projectedKey);
    projectedEntries.push([projectedKey, projectWorkspaceExplorerPathValue(child, rootPaths)]);
  }
  return Object.fromEntries(projectedEntries) as T;
}

export function projectWorkspaceExplorerText(value: string, rootPaths: readonly string[]): string {
  if (looksLikeFileUrl(value)) return projectFileUrl(value, rootPaths);
  if (isAbsolutePathForAnyHost(value)) return projectAbsolutePath(value, rootPaths);
  let projected = value;
  projected = projected.replace(FILE_URL_PATTERN, (candidate) => projectFileUrl(candidate, rootPaths));
  // Replace the exact frozen root before token-oriented matching. This keeps
  // in-scope paths usable even when a workspace directory itself has spaces.
  for (const rootPath of rootPaths) {
    projected = replaceExactRootPrefixes(projected, rootPath);
  }
  projected = projected.replace(WINDOWS_UNC_PATH_PATTERN, (candidate) => projectAbsolutePath(candidate, rootPaths));
  projected = projected.replace(WINDOWS_DRIVE_PATH_PATTERN, (candidate) => projectAbsolutePath(candidate, rootPaths));
  projected = projected.replace(POSIX_PATH_PATTERN, (candidate, prefix: string) => {
    const absolutePath = candidate.slice(prefix.length);
    return `${prefix}${projectAbsolutePath(absolutePath, rootPaths)}`;
  });
  return projected;
}

export function collectWorkspaceExplorerScopeRoots(value: unknown): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    if (typeof record.rootPath === "string" && Array.isArray(record.approvedPaths)) {
      const rootPath = record.rootPath.trim();
      if (rootPath && !seen.has(rootPath)) {
        seen.add(rootPath);
        roots.push(rootPath);
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return roots;
}

function projectFileUrl(candidate: string, rootPaths: readonly string[]): string {
  try {
    const rawLocation = candidate.slice("file:".length);
    let filePath: string;
    if (rawLocation.startsWith("//")) {
      const parsed = new URL(candidate);
      filePath = decodeURIComponent(parsed.pathname);
      if (parsed.hostname && parsed.hostname !== "localhost") {
        filePath = `\\\\${parsed.hostname}${filePath.replaceAll("/", "\\")}`;
      } else if (/^\/[A-Za-z]:\//u.test(filePath)) {
        filePath = filePath.slice(1);
      }
    } else {
      filePath = decodeURIComponent(rawLocation);
      if (/^\/[A-Za-z]:\//u.test(filePath)) filePath = filePath.slice(1);
    }
    return projectAbsolutePath(filePath, rootPaths);
  } catch {
    return "[outside-workspace-path]";
  }
}

function replaceExactRootPrefixes(value: string, rootPath: string): string {
  const variants = new Set([rootPath, rootPath.replaceAll("\\", "/"), rootPath.replaceAll("/", "\\")]);
  let projected = value;
  for (const variant of variants) {
    const escaped = escapeRegExp(variant.replace(/[\\/]+$/u, ""));
    if (!escaped) continue;
    projected = projected.replace(
      new RegExp(`${escaped}(?:[\\\\/]|$)`, path.win32.isAbsolute(rootPath) ? "giu" : "gu"),
      (matched) => (/[\\/]$/u.test(matched) ? "" : "."),
    );
  }
  return projected;
}

function looksLikeFileUrl(value: string): boolean {
  return /^file:/iu.test(value.trim());
}

function isAbsolutePathForAnyHost(value: string): boolean {
  const trimmed = value.trim();
  return path.win32.isAbsolute(trimmed) || path.posix.isAbsolute(trimmed);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function projectAbsolutePath(candidate: string, rootPaths: readonly string[]): string {
  for (const rootPath of rootPaths) {
    const relative = relativePathWithinRoot(candidate, rootPath);
    if (relative !== undefined) return relative;
  }
  return "[outside-workspace-path]";
}

function relativePathWithinRoot(candidate: string, rootPath: string): string | undefined {
  const pathApi = selectPathApi(candidate, rootPath);
  if (!pathApi) return undefined;
  const root = pathApi.resolve(rootPath);
  const target = pathApi.resolve(candidate);
  const relative = pathApi.relative(root, target);
  if (relative && (pathApi.isAbsolute(relative) || relative.split(/[\\/]+/u).includes(".."))) {
    return undefined;
  }
  return (relative || ".").replaceAll("\\", "/");
}

function selectPathApi(candidate: string, rootPath: string): typeof path.win32 | typeof path.posix | undefined {
  if (path.win32.isAbsolute(candidate) && path.win32.isAbsolute(rootPath)) return path.win32;
  if (path.posix.isAbsolute(candidate) && path.posix.isAbsolute(rootPath)) return path.posix;
  return undefined;
}
