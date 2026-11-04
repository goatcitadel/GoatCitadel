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
  return projectWorkspaceExplorerInlineText(value, rootPaths);
}

/**
 * Upper bound on the raw text a stream projector holds back while it waits to
 * see whether a trailing token grows into an absolute path.
 */
export const WORKSPACE_EXPLORER_STREAM_HOLD_BACK_LIMIT = 512;

export interface WorkspaceExplorerTextStreamProjector {
  /** Adds a raw fragment and returns the projected text that is now safe to emit (possibly ""). */
  push(fragment: string): string;
  /** Projects and returns whatever is still held back; call once at the end of the stream. */
  flush(): string;
}

const STREAM_PATH_KINDS = [
  { pattern: FILE_URL_PATTERN, delimiter: /[\s<>"'`]/u, fileUrl: true },
  { pattern: WINDOWS_UNC_PATH_PATTERN, delimiter: /[\s<>"'`|?*]/u, fileUrl: false },
  { pattern: WINDOWS_DRIVE_PATH_PATTERN, delimiter: /[\s<>"'`|?*]/u, fileUrl: false },
  { pattern: POSIX_PATH_PATTERN, delimiter: /[\s<>"'`),;|}\]]/u, fileUrl: false },
] as const;

type SpacedStreamRoot = { variant: string; caseInsensitive: boolean };
type HeldStreamTail = { start: number; root?: SpacedStreamRoot };
type SuppressedStreamPath = { delimiter: RegExp; root?: SpacedStreamRoot; rootOffset: number };

/** Keeps a bounded undecided tail and suppresses the continuation of any oversized path. */
export function createWorkspaceExplorerTextStreamProjector(
  rootPaths: readonly string[],
): WorkspaceExplorerTextStreamProjector {
  const spacedRootVariants = rootPaths.flatMap((rootPath) =>
    [...rootPathVariants(rootPath)]
      .map((variant) => variant.replace(/[\\/]+$/u, ""))
      .filter((variant) => /\s/u.test(variant))
      .map((variant) => ({ variant, caseInsensitive: path.win32.isAbsolute(rootPath) })),
  );
  const project = (text: string) => (text ? projectWorkspaceExplorerInlineText(text, rootPaths) : "");
  let held = "";
  let suppressed: SuppressedStreamPath | undefined;
  return {
    push(fragment: string): string {
      if (suppressed) {
        // A recognized root can itself contain spaces. Consume a known root
        // prefix by index instead of retaining the provider's raw text.
        const rootChars = countSuppressedRootPrefix(suppressed, fragment);
        const delimiterIndex = fragment.slice(rootChars).search(suppressed.delimiter);
        if (delimiterIndex < 0) return "";
        fragment = fragment.slice(rootChars + delimiterIndex);
        suppressed = undefined;
      }
      held += fragment;
      const tail = findHeldStreamTail(held, spacedRootVariants);
      let releaseUpTo = tail.start;
      if (held.length - releaseUpTo > WORKSPACE_EXPLORER_STREAM_HOLD_BACK_LIMIT) {
        const pending = held.slice(releaseUpTo);
        const candidate = tail.root ? undefined : findTrailingStreamPath(pending);
        if (!tail.root && !candidate) {
          releaseUpTo = held.length;
        } else {
          releaseUpTo += candidate?.start ?? 0;
          if (held.length - releaseUpTo > WORKSPACE_EXPLORER_STREAM_HOLD_BACK_LIMIT) {
            const rawPath = held.slice(releaseUpTo);
            const pathKind =
              candidate?.kind ??
              (rawPath.startsWith("/") && !rawPath.startsWith("//") ? STREAM_PATH_KINDS[3] : STREAM_PATH_KINDS[1]);
            const marker =
              !tail.root &&
              (pathKind.fileUrl ? projectFileUrl(rawPath, rootPaths) : projectAbsolutePath(rawPath, rootPaths)) ===
                "[outside-workspace-path]"
                ? "[outside-workspace-path]"
                : "[workspace-path-too-long]";
            const ready = project(held.slice(0, releaseUpTo));
            suppressed = { delimiter: pathKind.delimiter, root: tail.root, rootOffset: rawPath.length };
            held = "";
            return ready + marker;
          }
        }
      }
      const ready = held.slice(0, releaseUpTo);
      held = held.slice(releaseUpTo);
      return project(ready);
    },
    flush(): string {
      const rest = held;
      held = "";
      suppressed = undefined;
      return project(rest);
    },
  };
}

function findHeldStreamTail(value: string, spacedRootVariants: readonly SpacedStreamRoot[]): HeldStreamTail {
  let start = value.length;
  while (start > 0 && !/\s/u.test(value[start - 1]!)) start -= 1;
  let selected: SpacedStreamRoot | undefined;
  for (const rootVariant of spacedRootVariants) {
    const { variant, caseInsensitive } = rootVariant;
    const root = caseInsensitive ? variant.toLowerCase() : variant;
    for (let index = Math.max(0, start - root.length); index < start; index += 1) {
      const window = value.slice(index, index + root.length);
      const candidate = caseInsensitive ? window.toLowerCase() : window;
      const unfinishedRoot = candidate.length < root.length && root.startsWith(candidate);
      const growingRootPath = candidate === root && !/\s/u.test(value.slice(index + root.length));
      if (unfinishedRoot || growingRootPath) {
        start = index;
        selected = rootVariant;
        break;
      }
    }
  }
  return { start, root: selected };
}

function findTrailingStreamPath(value: string):
  | { start: number; kind: (typeof STREAM_PATH_KINDS)[number] }
  | undefined {
  let candidate: { start: number; kind: (typeof STREAM_PATH_KINDS)[number] } | undefined;
  for (const kind of STREAM_PATH_KINDS) {
    for (const match of value.matchAll(kind.pattern)) {
      if (match.index + match[0].length !== value.length) continue;
      // The POSIX pattern also matches the preceding separator, when present.
      const start = match.index + (match[1]?.length ?? 0);
      if (!candidate || start < candidate.start) candidate = { start, kind };
    }
  }
  return candidate;
}

function countSuppressedRootPrefix(suppressed: SuppressedStreamPath, fragment: string): number {
  const { root, rootOffset } = suppressed;
  if (!root || rootOffset >= root.variant.length) return 0;
  const remaining = root.variant.slice(rootOffset);
  let matched = 0;
  while (matched < remaining.length && matched < fragment.length) {
    const expected = remaining.charAt(matched);
    const actual = fragment.charAt(matched);
    if (expected !== actual && (!root.caseInsensitive || expected.toLowerCase() !== actual.toLowerCase())) break;
    matched += 1;
  }
  suppressed.rootOffset += matched;
  if (matched < fragment.length || suppressed.rootOffset >= root.variant.length) suppressed.root = undefined;
  return matched;
}

/**
 * Token-oriented projection without the whole-value shortcut, so running text
 * that merely starts with a path keeps the words after it.
 */
function projectWorkspaceExplorerInlineText(value: string, rootPaths: readonly string[]): string {
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

function rootPathVariants(rootPath: string): Set<string> {
  return new Set([rootPath, rootPath.replaceAll("\\", "/"), rootPath.replaceAll("/", "\\")]);
}

function replaceExactRootPrefixes(value: string, rootPath: string): string {
  let projected = value;
  for (const variant of rootPathVariants(rootPath)) {
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
