import fs from "node:fs/promises";
import path from "node:path";
import { ConflictError, NotFoundError, PayloadTooLargeError, ValidationError } from "@goatcitadel/contracts";
import { assertExistingPathRealpathAllowed, assertWritePathInJail } from "@goatcitadel/policy-engine";
import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const MAX_FILE_UPLOAD_BYTES = resolvePositiveIntEnv("GOATCITADEL_MAX_FILE_UPLOAD_BYTES", 50_000_000);
export const MAX_INLINE_FILE_DOWNLOAD_BYTES = resolvePositiveIntEnv(
  "GOATCITADEL_MAX_INLINE_FILE_DOWNLOAD_BYTES",
  25_000_000,
);
export const MAX_HTML_PREVIEW_BYTES = resolvePositiveIntEnv("GOATCITADEL_MAX_HTML_PREVIEW_BYTES", 1_000_000);
export const MAX_WORKSPACE_FILE_LIST_DEPTH = resolvePositiveIntEnv("GOATCITADEL_MAX_FILE_LIST_DEPTH", 8);
export const MAX_WORKSPACE_FILE_STAT_CALLS = resolvePositiveIntEnv("GOATCITADEL_MAX_FILE_LIST_STAT_CALLS", 10_000);
/** Most files a paged listing scans before it filters, sorts and slices; a capped scan reports `complete: false`. */
export const MAX_WORKSPACE_FILE_PAGE_SCAN = resolvePositiveIntEnv("GOATCITADEL_MAX_FILE_PAGE_SCAN", 5_000);
export const DEFAULT_WORKSPACE_FILE_LIST_IGNORES = new Set([
  ".git",
  ".next",
  ".playwright-cli",
  ".turbo",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

export interface FileUploadResult {
  relativePath: string;
  fullPath: string;
  bytes: number;
}

export interface FileDownloadResult {
  relativePath: string;
  fullPath: string;
  size: number;
  modifiedAt: string;
  contentType: string;
  isText: boolean;
  content: string | Buffer;
}

export interface FileDownloadOptions {
  maxBytes?: number;
}

export interface FileTemplateRecord {
  templateId: string;
  title: string;
  description: string;
  defaultPath: string;
  body: string;
}

export interface MemoryFileEntry {
  relativePath: string;
  size: number;
  modifiedAt: string;
}

/** Optional search and continuation for a paged listing. Both are additive; plain listings ignore them. */
export interface WorkspaceFilePageOptions {
  /** Case-insensitive substring matched against each path relative to the listed folder. */
  query?: string;
  /** Opaque continuation from a previous page with the same folder and query; it marks the last item returned. */
  cursor?: string;
}

/**
 * One page of a folder listing, newest first. Paths stay relative to the listed folder, as in a plain listing.
 * `folders` names the folder's direct, non-ignored subfolders. `complete` is false when the scan stopped at a
 * depth, stat or scan cap, so a search may have missed files.
 */
export interface WorkspaceFilePage {
  items: MemoryFileEntry[];
  folders: string[];
  nextCursor?: string;
  complete: boolean;
}

export const filesRouteMethods = [
  "createWorkspaceFileFromTemplate",
  "downloadWorkspaceFile",
  "listFileTemplates",
  "listWorkspaceFiles",
  "listWorkspacePathSuggestions",
  "pageWorkspaceFiles",
  "uploadWorkspaceFile",
] as const;

export type FilesRouteMethod = (typeof filesRouteMethods)[number];
export type FilesRoutePort = RoutePort<FilesRouteMethod>;
export type FilesRouteService = RouteService<FilesRouteMethod>;

export interface FilesRoutePortDependencies {
  rootDir: string;
  workspaceDir: string;
  writeJailRoots: string[];
  readOnlyRoots: string[];
  serializeRootPath: (fullPath: string) => string;
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => Promise<unknown>;
}

export function createFilesRoutePort(deps: FilesRoutePortDependencies): FilesRoutePort {
  const uploadWorkspaceFile = async (
    relativePath: string,
    content: string,
    options: { expectAbsent?: boolean } = {},
  ): Promise<FileUploadResult> => {
    const normalized = normalizeRelativePath(relativePath);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_UPLOAD_BYTES) {
      throw new PayloadTooLargeError("File upload exceeds the configured workspace upload limit", {
        limitBytes: MAX_FILE_UPLOAD_BYTES,
        receivedBytes: bytes,
        relativePath: normalized,
      });
    }

    const fullPath = path.resolve(deps.rootDir, deps.workspaceDir, normalized);
    assertWritePathInJail(fullPath, deps.writeJailRoots);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    try {
      // "wx" creates atomically, so a reviewed "new file" upload never replaces a file that appeared after the review.
      await fs.writeFile(fullPath, content, { encoding: "utf8", flag: options.expectAbsent ? "wx" : "w" });
    } catch (error) {
      if (options.expectAbsent && (error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ConflictError({
          code: "ALREADY_EXISTS",
          message:
            "A file already exists at this path, so nothing was written. Review the replacement before uploading.",
          details: { relativePath: normalized },
        });
      }
      throw error;
    }

    const result = {
      relativePath: normalized,
      fullPath: deps.serializeRootPath(fullPath),
      bytes,
    };

    await deps.publishRealtime("system", "files", {
      type: "file_uploaded",
      ...result,
    });

    return result;
  };

  const resolveListDir = (relativeDir: string): string => {
    const normalized = relativeDir === "." ? "." : normalizeRelativePath(relativeDir);
    const baseDir =
      normalized === "."
        ? path.resolve(deps.rootDir, deps.workspaceDir)
        : path.resolve(deps.rootDir, deps.workspaceDir, normalized);
    assertWritePathInJail(baseDir, deps.writeJailRoots);
    return baseDir;
  };

  const listWorkspaceFiles = async (relativeDir = ".", maxItems = 1000): Promise<MemoryFileEntry[]> => {
    const baseDir = resolveListDir(relativeDir);

    const out: MemoryFileEntry[] = [];
    await walkFiles(
      baseDir,
      baseDir,
      out,
      maxItems,
      {
        statCalls: 0,
      },
      0,
    );
    out.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
    return out;
  };

  const pageWorkspaceFiles = async (
    relativeDir = ".",
    limit = 100,
    options: WorkspaceFilePageOptions = {},
  ): Promise<WorkspaceFilePage> => {
    const after = parseFilePageCursor(options.cursor);
    const baseDir = resolveListDir(relativeDir);
    const needle = options.query?.trim().toLowerCase() ?? "";
    const scanned: MemoryFileEntry[] = [];
    const state: WorkspaceFileWalkState = { statCalls: 0, truncated: false };
    await walkFiles(baseDir, baseDir, scanned, MAX_WORKSPACE_FILE_PAGE_SCAN, state, 0);
    // Keyset paging: a page resumes after the last item it returned, so files written,
    // touched or deleted between pages cannot shift later pages into repeats or gaps.
    const matches = scanned
      .map((item) => ({ item, position: { modifiedMs: Date.parse(item.modifiedAt), relativePath: item.relativePath } }))
      .filter(
        ({ item, position }) =>
          (!needle || item.relativePath.toLowerCase().includes(needle)) &&
          (!after || compareFilePagePositions(position, after) > 0),
      )
      .sort((left, right) => compareFilePagePositions(left.position, right.position));
    const page = matches.slice(0, limit);
    const last = page.at(-1);
    const folders = await fs
      .readdir(baseDir, { withFileTypes: true, encoding: "utf8" })
      .then((entries) =>
        entries
          .filter((entry) => entry.isDirectory() && !DEFAULT_WORKSPACE_FILE_LIST_IGNORES.has(entry.name.toLowerCase()))
          .map((entry) => entry.name)
          .sort((left, right) => left.localeCompare(right)),
      )
      .catch((): string[] => []);
    return {
      items: page.map(({ item }) => item),
      folders,
      ...(last && matches.length > limit ? { nextCursor: writeFilePageCursor(last.position) } : {}),
      complete: !state.truncated,
    };
  };

  return {
    createWorkspaceFileFromTemplate: async (templateId: string, targetPath?: string): Promise<FileUploadResult> => {
      const template = FILE_TEMPLATES.find((item) => item.templateId === templateId);
      if (!template) {
        throw new Error(`Unknown file template: ${templateId}`);
      }
      const today = new Date().toISOString().slice(0, 10);
      const resolvedPath = (targetPath && targetPath.trim()) || template.defaultPath.replaceAll("{date}", today);
      const content = template.body.replaceAll("{date}", today);
      return uploadWorkspaceFile(resolvedPath, content);
    },
    downloadWorkspaceFile: async (relativePath: string, options?: FileDownloadOptions): Promise<FileDownloadResult> => {
      const normalized = normalizeRelativePath(relativePath);
      const fullPath = path.resolve(deps.rootDir, deps.workspaceDir, normalized);
      try {
        assertExistingPathRealpathAllowed(fullPath, deps.writeJailRoots, deps.readOnlyRoots);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new NotFoundError({ entity: "File", id: normalized });
        }
        throw error;
      }

      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        throw new ValidationError({ message: `Path is a directory: ${normalized}` });
      }
      const maxBytes = options?.maxBytes ?? MAX_INLINE_FILE_DOWNLOAD_BYTES;
      if (stat.size > maxBytes) {
        throw new PayloadTooLargeError("File is too large to read inline", {
          limitBytes: maxBytes,
          receivedBytes: stat.size,
          relativePath: normalized,
        });
      }

      const contentType = detectMimeType(fullPath);
      const isText = isTextContentType(contentType);
      const content = isText ? await fs.readFile(fullPath, "utf8") : await fs.readFile(fullPath);

      return {
        relativePath: normalized,
        fullPath: deps.serializeRootPath(fullPath),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        contentType,
        isText,
        content,
      };
    },
    listFileTemplates: (): FileTemplateRecord[] => {
      const today = new Date().toISOString().slice(0, 10);
      return FILE_TEMPLATES.map((template) => ({
        ...template,
        defaultPath: template.defaultPath.replaceAll("{date}", today),
      }));
    },
    listWorkspaceFiles,
    pageWorkspaceFiles,
    listWorkspacePathSuggestions: async (root = ".", limit = 150): Promise<string[]> => {
      const maxItems = Math.max(limit * 3, 200);
      const files = await listWorkspaceFiles(root, maxItems);
      const suggestions = new Set<string>();

      const normalizedRoot = root === "." ? "" : normalizeRelativePath(root);
      if (normalizedRoot) {
        suggestions.add(normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`);
      } else {
        suggestions.add("memory/");
        suggestions.add("notes/");
        suggestions.add("artifacts/");
        suggestions.add("docs/");
        suggestions.add("workspace/");
      }

      for (const file of files) {
        suggestions.add(file.relativePath);
        const dir = path.posix.dirname(file.relativePath);
        if (dir && dir !== ".") {
          suggestions.add(dir.endsWith("/") ? dir : `${dir}/`);
        }
        if (suggestions.size >= limit * 4) {
          break;
        }
      }

      return [...suggestions].slice(0, limit);
    },
    uploadWorkspaceFile,
  };
}

export function createFilesRouteService(port: FilesRoutePort): FilesRouteService {
  return createRouteService(port, filesRouteMethods);
}

function normalizeRelativePath(inputPath: string): string {
  const normalized = path.normalize(inputPath).replaceAll("\\", "/");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.endsWith("/..") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Invalid relative path: ${inputPath}`);
  }
  if (path.isAbsolute(normalized)) {
    throw new Error(`Absolute paths are not allowed: ${inputPath}`);
  }
  return normalized;
}

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    return "text/html";
  }
  if (ext === ".css") {
    return "text/css";
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts" || ext === ".tsx") {
    return "application/javascript";
  }
  if (ext === ".json") {
    return "application/json";
  }
  if (ext === ".md") {
    return "text/markdown";
  }
  if (ext === ".txt" || ext === ".log") {
    return "text/plain";
  }
  if (ext === ".svg") {
    return "image/svg+xml";
  }
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  if (ext === ".pdf") {
    return "application/pdf";
  }
  return "application/octet-stream";
}

function isTextContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/javascript" ||
    contentType === "text/markdown"
  );
}

const FILE_TEMPLATES: FileTemplateRecord[] = [
  {
    templateId: "artifact-report",
    title: "Artifact Report",
    description: "Structured report artifact with purpose, evidence, and next actions.",
    defaultPath: "artifacts/artifact-report-{date}.md",
    body: [
      "# Artifact Report ({date})",
      "",
      "## What this is",
      "- Brief description of the artifact and why it exists.",
      "",
      "## Inputs",
      "- Source files:",
      "- Data references:",
      "",
      "## Output",
      "- Result summary:",
      "",
      "## Verification",
      "- Checks performed:",
      "- Remaining risk:",
      "",
      "## Next actions",
      "- [ ] Follow-up item 1",
      "- [ ] Follow-up item 2",
      "",
    ].join("\n"),
  },
  {
    templateId: "research-brief",
    title: "Research Brief",
    description: "Quick research summary with findings and citations.",
    defaultPath: "docs/research-brief-{date}.md",
    body: [
      "# Research Brief ({date})",
      "",
      "## Question",
      "- What are we trying to answer?",
      "",
      "## Findings",
      "1. Finding one",
      "2. Finding two",
      "",
      "## Sources",
      "- Source 1:",
      "- Source 2:",
      "",
      "## Recommendation",
      "- Proposed decision and tradeoff.",
      "",
    ].join("\n"),
  },
  {
    templateId: "release-note",
    title: "Release Note",
    description: "Release note draft with highlights, fixes, and known issues.",
    defaultPath: "docs/release-notes-{date}.md",
    body: [
      "# Release Notes ({date})",
      "",
      "## Highlights",
      "- Feature 1",
      "- Feature 2",
      "",
      "## Fixes",
      "- Fix 1",
      "- Fix 2",
      "",
      "## Known Issues",
      "- Issue 1",
      "",
      "## Upgrade Notes",
      "- Migration/compatibility guidance.",
      "",
    ].join("\n"),
  },
  {
    templateId: "bug-report",
    title: "Bug Report",
    description: "Bug template for reproducible issue reports.",
    defaultPath: "artifacts/bug-report-{date}.md",
    body: [
      "# Bug Report ({date})",
      "",
      "## Summary",
      "- One-line description.",
      "",
      "## Repro Steps",
      "1. Step one",
      "2. Step two",
      "",
      "## Expected",
      "- What should happen.",
      "",
      "## Actual",
      "- What happened instead.",
      "",
      "## Environment",
      "- OS:",
      "- Branch/commit:",
      "- Config context:",
      "",
    ].join("\n"),
  },
];

interface WorkspaceFileWalkState {
  statCalls: number;
  /** Set when the walk stopped early at a depth, stat or item cap. */
  truncated?: boolean;
}

/** Where a paged listing stopped, in its newest-first, then path, order. */
interface FilePagePosition {
  modifiedMs: number;
  relativePath: string;
}

export const MAX_FILE_PAGE_CURSOR_LENGTH = 4_096;

function compareFilePagePositions(left: FilePagePosition, right: FilePagePosition): number {
  // The exact comparison breaks locale ties (e.g. composed vs decomposed accents), so
  // distinct paths always get distinct positions and a cursor never skips one.
  return (
    right.modifiedMs - left.modifiedMs ||
    left.relativePath.localeCompare(right.relativePath) ||
    (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
  );
}

function writeFilePageCursor(position: FilePagePosition): string {
  return Buffer.from(JSON.stringify({ m: position.modifiedMs, p: position.relativePath })).toString("base64url");
}

function parseFilePageCursor(cursor: string | undefined): FilePagePosition | undefined {
  if (cursor === undefined) return undefined;
  const invalid = () => new ValidationError({ message: "File list cursor is not valid. Start the listing again." });
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor) || cursor.length > MAX_FILE_PAGE_CURSOR_LENGTH) throw invalid();
  let value: { m?: unknown; p?: unknown } | null;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { m?: unknown; p?: unknown } | null;
  } catch {
    throw invalid();
  }
  if (!value || !Number.isSafeInteger(value.m) || typeof value.p !== "string" || !value.p) throw invalid();
  return { modifiedMs: value.m as number, relativePath: value.p };
}

async function walkFiles(
  rootDir: string,
  currentDir: string,
  out: MemoryFileEntry[],
  maxItems: number,
  state: WorkspaceFileWalkState,
  depth: number,
): Promise<void> {
  if (out.length >= maxItems) {
    return;
  }
  if (depth > MAX_WORKSPACE_FILE_LIST_DEPTH) {
    state.truncated = true;
    return;
  }

  let entries: Array<{ isDirectory: () => boolean; isFile: () => boolean; name: string }>;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= maxItems) {
      state.truncated = true;
      return;
    }

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (DEFAULT_WORKSPACE_FILE_LIST_IGNORES.has(entry.name.toLowerCase())) {
        continue;
      }
      await walkFiles(rootDir, fullPath, out, maxItems, state, depth + 1);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    if (state.statCalls >= MAX_WORKSPACE_FILE_STAT_CALLS) {
      state.truncated = true;
      return;
    }
    state.statCalls += 1;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    out.push({
      relativePath: path.relative(rootDir, fullPath).replaceAll("\\", "/"),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
}

function resolvePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
