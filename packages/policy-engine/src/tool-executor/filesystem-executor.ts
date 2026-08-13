import fs from "node:fs/promises";
import path from "node:path";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { clampInt } from "@goatcitadel/contracts";
import { assertWritePathInJail } from "../sandbox/path-jail.js";

export const FILESYSTEM_TOOL_NAMES = new Set([
  "fs.read",
  "file.read_range",
  "file.find",
  "code.search",
  "code.search_files",
  "fs.write",
  "fs.list",
  "fs.stat",
  "fs.copy",
  "fs.move",
  "fs.delete",
]);

export interface FilesystemToolExecutorDeps {
  assertReadPathAllowedForRequest: (
    targetPath: string,
    request: ToolInvokeRequest,
    config: ToolPolicyConfig,
    storage: AsyncStorage,
  ) => Promise<void>;
}

export const FILESYSTEM_READ_MAX_BYTES = 64 * 1024;
export const FILE_READ_RANGE_MAX_BYTES = 4 * 1024 * 1024;
export const FILE_READ_RANGE_MAX_OUTPUT_BYTES = 64 * 1024;
const FILESYSTEM_READ_CHUNK_BYTES = 64 * 1024;

export function isFilesystemToolName(toolName: string): boolean {
  return FILESYSTEM_TOOL_NAMES.has(toolName);
}

export async function executeFilesystemTool(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: FilesystemToolExecutorDeps,
): Promise<Record<string, unknown>> {
  switch (request.toolName) {
    case "fs.read":
      return fsRead(request, config, storage, deps);
    case "file.read_range":
      return fileReadRange(request, config, storage, deps);
    case "file.find":
      return fileFind(request, config, storage, deps);
    case "code.search":
      return codeSearch(request, config, storage, deps);
    case "code.search_files":
      return codeSearchFiles(request, config, storage, deps);
    case "fs.write":
      return fsWrite(request.args, config);
    case "fs.list":
      return fsList(request, config, storage, deps);
    case "fs.stat":
      return fsStat(request, config, storage, deps);
    case "fs.copy":
      return fsCopy(request, config, storage, deps);
    case "fs.move":
      return fsMove(request.args, config);
    case "fs.delete":
      return fsDelete(request.args, config);
    default:
      throw new Error(`Unsupported filesystem tool executor: ${request.toolName}`);
  }
}

async function fsRead(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: FilesystemToolExecutorDeps,
) {
  const args = request.args;
  const p = required(args.path, "path");
  await deps.assertReadPathAllowedForRequest(p, request, config, storage);
  const full = path.resolve(p);
  const { content, bytes } = await readUtf8FileBounded(full, FILESYSTEM_READ_MAX_BYTES);
  return { path: full, bytes, content };
}

async function fileReadRange(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: FilesystemToolExecutorDeps,
) {
  const args = request.args;
  const p = required(args.path, "path");
  await deps.assertReadPathAllowedForRequest(p, request, config, storage);
  const full = path.resolve(p);
  const { content } = await readUtf8FileBounded(full, FILE_READ_RANGE_MAX_BYTES);
  const selected = selectLineRange(content, args.startLine, args.endLine);
  if (Buffer.byteLength(selected.content, "utf8") > FILE_READ_RANGE_MAX_OUTPUT_BYTES) {
    throw new Error(`Filesystem line range exceeds the ${FILE_READ_RANGE_MAX_OUTPUT_BYTES} byte output limit: ${full}`);
  }
  return {
    path: full,
    startLine: selected.startLine,
    endLine: selected.endLine,
    lineCount: selected.lineCount,
    content: selected.content,
  };
}

async function fileFind(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: FilesystemToolExecutorDeps,
) {
  const args = request.args;
  return searchFileContents({
    request,
    rootPath: required(args.path, "path"),
    pattern: required(args.pattern, "pattern"),
    caseSensitive: asBoolean(args.caseSensitive, false),
    limit: clampInt(args.limit, 25, 1, 200),
    config,
    storage,
    deps,
  });
}

async function codeSearch(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: FilesystemToolExecutorDeps,
) {
  const args = request.args;
  return searchFileContents({
    request,
    rootPath: required(args.path, "path"),
    pattern: required(args.query, "query"),
    caseSensitive: asBoolean(args.caseSensitive, false),
    limit: clampInt(args.limit, 25, 1, 200),
    config,
    storage,
    deps,
    codeOnly: true,
  });
}

async function codeSearchFiles(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: FilesystemToolExecutorDeps,
) {
  const args = request.args;
  const rootPath = required(args.path, "path");
  await deps.assertReadPathAllowedForRequest(rootPath, request, config, storage);
  const fullRoot = path.resolve(rootPath);
  const query = required(args.query, "query");
  const caseSensitive = asBoolean(args.caseSensitive, false);
  const limit = clampInt(args.limit, 25, 1, 200);
  const normalizedQuery = caseSensitive ? query : query.toLowerCase();
  const matches: Array<{ path: string; name: string; type: "file" | "dir" }> = [];
  const pending = [fullRoot];
  let skippedDirs = 0;

  while (pending.length > 0 && matches.length < limit) {
    const current = pending.pop() as string;
    const stat = await fs.stat(current);
    if (stat.isFile()) {
      const name = path.basename(current);
      const haystack = caseSensitive ? name : name.toLowerCase();
      if (haystack.includes(normalizedQuery)) {
        matches.push({ path: current, name, type: "file" });
      }
      continue;
    }

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (shouldSkipSearchEntry(entry.name) || shouldSkipSearchEntryAtRoot(fullRoot, entryPath, entry.isDirectory())) {
        if (entry.isDirectory()) {
          skippedDirs += 1;
        }
        continue;
      }
      const haystack = caseSensitive ? entry.name : entry.name.toLowerCase();
      if (haystack.includes(normalizedQuery)) {
        matches.push({
          path: entryPath,
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file",
        });
        if (matches.length >= limit) {
          break;
        }
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }

  return {
    path: fullRoot,
    query,
    count: matches.length,
    matches,
    ...(skippedDirs > 0 ? { skippedDirs } : {}),
  };
}

async function fsWrite(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const p = required(args.path, "path");
  const content = String(args.content ?? "");
  assertWritePathInJail(p, config.sandbox.writeJailRoots);
  const full = path.resolve(p);
  const existing = await readExistingUtf8File(full);
  if (existing === content) {
    throw new Error(
      `fs.write made no changes to ${full}. The target already contains identical content; inspect the file or provide a concrete changed edit.`,
    );
  }
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
  return { path: full, bytesWritten: content.length };
}

async function readExistingUtf8File(full: string): Promise<string | undefined> {
  try {
    return await fs.readFile(full, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

async function fsList(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: FilesystemToolExecutorDeps,
) {
  const args = request.args;
  const p = asString(args.path) ?? ".";
  await deps.assertReadPathAllowedForRequest(p, request, config, storage);
  const full = path.resolve(p);
  const items = await fs.readdir(full, { withFileTypes: true });
  return {
    path: full,
    items: items.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
    })),
  };
}

async function fsStat(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: FilesystemToolExecutorDeps,
) {
  const args = request.args;
  const p = required(args.path, "path");
  await deps.assertReadPathAllowedForRequest(p, request, config, storage);
  const full = path.resolve(p);
  const stat = await fs.stat(full);
  return {
    path: full,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

async function fsCopy(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: FilesystemToolExecutorDeps,
) {
  const args = request.args;
  const from = required(args.from, "from");
  const to = required(args.to, "to");
  await deps.assertReadPathAllowedForRequest(from, request, config, storage);
  assertWritePathInJail(to, config.sandbox.writeJailRoots);
  const fullTo = path.resolve(to);
  await fs.mkdir(path.dirname(fullTo), { recursive: true });
  await fs.copyFile(path.resolve(from), fullTo);
  return { from: path.resolve(from), to: fullTo };
}

async function fsMove(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const from = required(args.from, "from");
  const to = required(args.to, "to");
  assertWritePathInJail(from, config.sandbox.writeJailRoots);
  assertWritePathInJail(to, config.sandbox.writeJailRoots);
  const fullTo = path.resolve(to);
  await fs.mkdir(path.dirname(fullTo), { recursive: true });
  await fs.rename(path.resolve(from), fullTo);
  return { from: path.resolve(from), to: fullTo };
}

async function fsDelete(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const p = required(args.path, "path");
  assertWritePathInJail(p, config.sandbox.writeJailRoots);
  await fs.rm(path.resolve(p), { recursive: asBoolean(args.recursive, false), force: false });
  return { path: path.resolve(p), deleted: true };
}

async function searchFileContents(input: {
  request: ToolInvokeRequest;
  rootPath: string;
  pattern: string;
  caseSensitive: boolean;
  limit: number;
  config: ToolPolicyConfig;
  storage: AsyncStorage;
  deps: FilesystemToolExecutorDeps;
  codeOnly?: boolean;
}): Promise<Record<string, unknown>> {
  await input.deps.assertReadPathAllowedForRequest(input.rootPath, input.request, input.config, input.storage);
  const fullRoot = path.resolve(input.rootPath);
  const normalizedPattern = input.caseSensitive ? input.pattern : input.pattern.toLowerCase();
  const matches: Array<{
    path: string;
    line: number;
    lineText: string;
  }> = [];
  const pending = [fullRoot];
  let skippedDirs = 0;
  let skippedLinks = 0;
  let skippedOversizeFiles = 0;

  while (pending.length > 0 && matches.length < input.limit) {
    const current = pending.pop() as string;
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      skippedLinks += 1;
      continue;
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      continue;
    }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (
          shouldSkipSearchEntry(entry.name) ||
          shouldSkipSearchEntryAtRoot(fullRoot, entryPath, entry.isDirectory())
        ) {
          if (entry.isDirectory()) {
            skippedDirs += 1;
          }
          continue;
        }
        if (entry.isDirectory()) {
          pending.push(entryPath);
          continue;
        }
        if (input.codeOnly && !looksLikeCodeFile(entry.name)) {
          continue;
        }
        pending.push(entryPath);
      }
      continue;
    }
    if (input.codeOnly && !looksLikeCodeFile(path.basename(current))) {
      continue;
    }
    if (stat.size > SEARCH_MAX_CONTENT_FILE_BYTES) {
      skippedOversizeFiles += 1;
      continue;
    }
    const content = await fs.readFile(current, "utf8");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index] ?? "";
      const haystack = input.caseSensitive ? lineText : lineText.toLowerCase();
      if (!haystack.includes(normalizedPattern)) {
        continue;
      }
      matches.push({
        path: current,
        line: index + 1,
        lineText: lineText.slice(0, 400),
      });
      if (matches.length >= input.limit) {
        break;
      }
    }
  }

  return {
    path: fullRoot,
    pattern: input.pattern,
    count: matches.length,
    matches,
    ...(skippedDirs > 0 ? { skippedDirs } : {}),
    ...(skippedLinks > 0 ? { skippedLinks } : {}),
    ...(skippedOversizeFiles > 0
      ? {
          skippedOversizeFiles,
          skippedOversizeNote: `files larger than ${SEARCH_MAX_CONTENT_FILE_BYTES} bytes were not content-searched; use file.read_range for those`,
        }
      : {}),
  };
}

async function readUtf8FileBounded(fullPath: string, maxBytes: number): Promise<{ content: string; bytes: number }> {
  const handle = await fs.open(fullPath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Filesystem read requires a regular file: ${fullPath}`);
    }
    if (stat.size > maxBytes) {
      throw filesystemReadLimitError(fullPath, maxBytes);
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= maxBytes) {
      const remaining = maxBytes + 1 - bytes;
      const chunk = Buffer.allocUnsafe(Math.min(FILESYSTEM_READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      bytes += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }

    if (bytes > maxBytes) {
      throw filesystemReadLimitError(fullPath, maxBytes);
    }
    return {
      content: Buffer.concat(chunks, bytes).toString("utf8"),
      bytes,
    };
  } finally {
    await handle.close();
  }
}

function filesystemReadLimitError(fullPath: string, maxBytes: number): Error {
  return new Error(`Filesystem read exceeds the ${maxBytes} byte limit: ${fullPath}`);
}

function selectLineRange(
  content: string,
  requestedStartLine: unknown,
  requestedEndLine: unknown,
): { startLine: number; endLine: number; lineCount: number; content: string } {
  let totalLines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      totalLines += 1;
    }
  }

  const startLine = clampInt(requestedStartLine, 1, 1, totalLines);
  const endLine = clampInt(requestedEndLine, startLine, startLine, totalLines);
  let startOffset = startLine === 1 ? 0 : content.length;
  let endOffset = content.length;
  let currentLine = 1;

  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) {
      continue;
    }
    if (currentLine === endLine) {
      endOffset = index > 0 && content.charCodeAt(index - 1) === 13 ? index - 1 : index;
      break;
    }
    currentLine += 1;
    if (currentLine === startLine) {
      startOffset = index + 1;
    }
  }

  return {
    startLine,
    endLine,
    lineCount: endLine - startLine + 1,
    content: content.slice(startOffset, endOffset).replace(/\r\n/g, "\n"),
  };
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function required(value: unknown, field: string): string {
  const parsed = asString(value);
  if (!parsed) throw new Error(`${field} is required`);
  return parsed;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

// Directory names skipped at every depth during local search traversal.
// Only unambiguous VCS/dependency/build outputs and agent/editor state belong
// here: anything that could plausibly be a source directory in a user's repo
// (artifacts, logs, postgres, ...) must NOT be name-skipped globally or
// searches silently miss real code (e.g. packages/storage/src/postgres).
const SEARCH_SKIPPED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".claude",
  ".codex-temp",
  ".scratch",
]);

// Heavy runtime/output directories skipped only when they sit DIRECTLY under
// the search root (searching from the repo root skips them; explicitly
// searching inside one still works). These are multi-GB on this workstation
// (installer artifacts, stored tool outputs, database files) and were the
// reason repo-wide queries took 30-90 seconds -- and they leak prior eval
// evidence back into new runs.
const SEARCH_ROOT_SKIPPED_RELATIVE_DIRS = new Set([
  "artifacts",
  "eval-assets",
  "logs",
  "workspace",
  "data/postgres",
  "data/tool-artifacts",
]);

// Files larger than this are skipped for content search: reading multi-MB
// binaries or logs into memory for substring matching is wasted I/O. Skips are
// counted in the result so the model knows the search was not exhaustive.
const SEARCH_MAX_CONTENT_FILE_BYTES = 1_500_000;

function shouldSkipSearchEntry(name: string): boolean {
  return SEARCH_SKIPPED_DIR_NAMES.has(name);
}

function shouldSkipSearchEntryAtRoot(rootPath: string, entryPath: string, isDirectory: boolean): boolean {
  if (!isDirectory) {
    return false;
  }
  const relative = path.relative(rootPath, entryPath).replace(/\\/g, "/").toLowerCase();
  if (!relative || relative.startsWith("..")) {
    return false;
  }
  return SEARCH_ROOT_SKIPPED_RELATIVE_DIRS.has(relative);
}

function looksLikeCodeFile(name: string): boolean {
  return /\.(c|cc|cpp|cs|css|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|mts|php|py|rb|rs|sh|sql|swift|toml|ts|tsx|vue|yaml|yml)$/i.test(
    name,
  );
}
