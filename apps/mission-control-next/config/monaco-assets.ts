import path from "node:path";

export function resolveMonacoAssetPath(sourceDir: string, requestPath: string): string | undefined {
  const sourceRoot = path.resolve(sourceDir);
  const segments: string[] = [];
  for (const rawSegment of requestPath.split("/")) {
    const trimmed = rawSegment.trim();
    if (!trimmed) {
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(trimmed);
    } catch {
      return undefined;
    }
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("%") ||
      decoded.includes("\0") ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      /^[a-zA-Z]:/.test(decoded) ||
      path.isAbsolute(decoded)
    ) {
      return undefined;
    }
    segments.push(decoded);
  }
  if (segments.length === 0) {
    return undefined;
  }
  const resolvedAssetPath = path.resolve(sourceRoot, ...segments);
  const relative = path.relative(sourceRoot, resolvedAssetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return resolvedAssetPath;
}
