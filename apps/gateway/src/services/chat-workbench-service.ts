import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  NotFoundError,
  ValidationError,
  type ChatSessionWorkbenchDiffResponse,
  type ChatSessionWorkbenchFileResponse,
  type ChatSessionWorkbenchOutputResponse,
  type ChatSessionWorkbenchRecord,
  type ChatSessionWorkbenchTreeEntry,
  type ChatSessionWorkbenchTreeResponse,
} from "@goatcitadel/contracts";
import { WorktreeManager } from "@goatcitadel/orchestration";
import { assertExistingPathRealpathAllowed, assertWritePathInJail } from "@goatcitadel/policy-engine";
import { serializePathWithinRoot } from "./security-utils.js";
import type { GatewayService } from "./gateway-service.js";

const MAX_TREE_ITEMS = 250;
const MAX_FILE_BYTES = 256 * 1024;

export type ChatWorkbenchHost = GatewayService;

export async function getChatSessionWorkbench(
  host: ChatWorkbenchHost,
  sessionId: string,
): Promise<ChatSessionWorkbenchRecord> {
  host.requireChatSession(sessionId);
  return syncWorkbenchState(host, sessionId);
}

export async function createChatSessionWorkbenchWorktree(
  host: ChatWorkbenchHost,
  sessionId: string,
  input: { baseRef?: string } = {},
): Promise<ChatSessionWorkbenchRecord> {
  host.requireChatSession(sessionId);
  const context = resolveProjectContext(host, sessionId, true);
  const current = syncWorkbenchState(host, sessionId);
  const baseRef = input.baseRef?.trim() || current.baseRef || "HEAD";
  const worktreesRoot = path.resolve(host.config.rootDir, host.config.assistant.worktreesDir);
  const targetPath = path.resolve(worktreesRoot, sessionId);

  await fs.mkdir(worktreesRoot, { recursive: true });
  assertWritePathInJail(targetPath, host.config.toolPolicy.sandbox.writeJailRoots);

  if (fsSync.existsSync(targetPath) && !isWorkbenchPathUsable(targetPath)) {
    throw new ValidationError({
      message:
        "Workbench path already exists but is not a valid git worktree. Clean it up before creating a new worktree for this session.",
    });
  }

  if (!fsSync.existsSync(targetPath)) {
    const manager = new WorktreeManager({
      repoRoot: host.config.rootDir,
      worktreesRoot,
    });
    await manager.create(sessionId, baseRef);
  }

  const updated = host.storage.chatSessionWorkbench.patch(sessionId, {
    projectId: context.project.projectId,
    baseRef,
    worktreePath: targetPath,
    worktreeStatus: "ready",
  });
  host.publishRealtime("chat_workbench_updated", "chat", {
    type: "chat_workbench_worktree_created",
    sessionId,
    projectId: context.project.projectId,
    baseRef,
    worktreePath: serializeWorkbenchPath(host, targetPath),
  });
  return hydrateWorkbenchRecord(host, updated, context.project.projectId);
}

export async function getChatSessionWorkbenchTree(
  host: ChatWorkbenchHost,
  sessionId: string,
): Promise<ChatSessionWorkbenchTreeResponse> {
  host.requireChatSession(sessionId);
  const state = syncWorkbenchState(host, sessionId);
  const context = resolveWorkbenchContext(host, sessionId, state, true);
  const changedFiles = listChangedFiles(context.worktreePath, context.repoScopePath);
  const entries: ChatSessionWorkbenchTreeEntry[] = [];
  await walkWorkbenchTree(context.projectRoot, context.projectRoot, entries, changedFiles, MAX_TREE_ITEMS);
  return {
    state,
    rootPath: context.project.workspacePath,
    changedFiles,
    items: entries,
  };
}

export async function getChatSessionWorkbenchFile(
  host: ChatWorkbenchHost,
  sessionId: string,
  relativePath: string,
): Promise<ChatSessionWorkbenchFileResponse> {
  host.requireChatSession(sessionId);
  const state = syncWorkbenchState(host, sessionId);
  const context = resolveWorkbenchContext(host, sessionId, state, true);
  const normalized = normalizeWorkbenchRelativePath(relativePath);
  const targetPath = path.resolve(context.projectRoot, normalized);
  assertPathInsideRoot(targetPath, context.projectRoot, "workbench file");
  try {
    assertExistingPathRealpathAllowed(
      targetPath,
      host.config.toolPolicy.sandbox.writeJailRoots,
      host.config.toolPolicy.sandbox.readOnlyRoots,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new NotFoundError({ entity: "Workbench file", id: normalized });
    }
    throw error;
  }

  const stat = await fs.stat(targetPath);
  if (stat.isDirectory()) {
    throw new ValidationError({ message: `Path is a directory: ${normalized}` });
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new ValidationError({
      message: `File exceeds ${MAX_FILE_BYTES} bytes and is too large for the workbench viewer.`,
    });
  }

  const content = await fs.readFile(targetPath, "utf8");
  const changedFiles = new Set(listChangedFiles(context.worktreePath, context.repoScopePath));
  const nextState = host.storage.chatSessionWorkbench.patch(sessionId, {
    projectId: context.project.projectId,
    activeFilePath: normalized,
  });
  return {
    state: hydrateWorkbenchRecord(host, nextState, context.project.projectId),
    path: normalized,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    contentType: guessContentType(targetPath),
    language: guessLanguage(targetPath),
    changed: changedFiles.has(normalized),
    content,
  };
}

export async function getChatSessionWorkbenchDiff(
  host: ChatWorkbenchHost,
  sessionId: string,
): Promise<ChatSessionWorkbenchDiffResponse> {
  host.requireChatSession(sessionId);
  const state = syncWorkbenchState(host, sessionId);
  const context = resolveWorkbenchContext(host, sessionId, state, true);
  const changedFiles = listChangedFiles(context.worktreePath, context.repoScopePath);
  const numstatRaw = runGit(context.worktreePath, ["diff", "--numstat", "--", context.repoScopePath]);
  let additions = 0;
  let deletions = 0;
  for (const line of numstatRaw.split(/\r?\n/)) {
    const [addedRaw, deletedRaw] = line.split("\t");
    if (!addedRaw || !deletedRaw) {
      continue;
    }
    additions += Number.parseInt(addedRaw, 10) || 0;
    deletions += Number.parseInt(deletedRaw, 10) || 0;
  }
  const diff = runGit(context.worktreePath, ["diff", "--", context.repoScopePath]);
  const nextState = host.storage.chatSessionWorkbench.patch(sessionId, {
    projectId: context.project.projectId,
    diffArtifactId: `workbench-diff:${sessionId}`,
  });
  return {
    state: hydrateWorkbenchRecord(host, nextState, context.project.projectId),
    scopePath: context.project.workspacePath,
    changedFiles,
    summary: {
      changedFiles: changedFiles.length,
      additions,
      deletions,
    },
    diff,
  };
}

export async function getChatSessionWorkbenchOutput(
  host: ChatWorkbenchHost,
  sessionId: string,
): Promise<ChatSessionWorkbenchOutputResponse> {
  host.requireChatSession(sessionId);
  syncWorkbenchState(host, sessionId);
  const projectId = host.storage.chatSessionProjects.get(sessionId)?.projectId;
  const helperRuns = host.storage.codeModeRuns
    .list(200)
    .filter((run) => run.sessionId === sessionId)
    .slice(0, 8)
    .map((run) => ({
      runId: run.runId,
      status: run.status,
      language: run.language,
      requestedOutputIntent: run.requestedOutputIntent,
      stdoutPreview: run.stdoutPreview,
      stderrPreview: run.stderrPreview,
      createdAt: run.createdAt,
    }));
  const latest = helperRuns[0];
  const validationStatus = latest
    ? latest.status === "completed"
      ? "passed"
      : latest.status === "failed"
        ? "failed"
        : "pending"
    : "idle";
  const output =
    helperRuns.length === 0
      ? "No validation output yet."
      : helperRuns
          .map((run) => {
            const header = `${run.language} helper · ${run.status}`;
            const body = [run.stdoutPreview, run.stderrPreview].filter(Boolean).join("\n").trim();
            return body ? `${header}\n${body}` : header;
          })
          .join("\n\n");
  const nextState = host.storage.chatSessionWorkbench.patch(sessionId, {
    projectId,
    outputArtifactId: latest ? `code-mode-run:${latest.runId}` : undefined,
    validationStatus,
  });
  return {
    state: hydrateWorkbenchRecord(host, nextState, projectId),
    helperRuns,
    output,
    lastUpdatedAt: latest?.createdAt,
  };
}

function syncWorkbenchState(host: ChatWorkbenchHost, sessionId: string): ChatSessionWorkbenchRecord {
  const projectId = host.storage.chatSessionProjects.get(sessionId)?.projectId;
  const current = host.storage.chatSessionWorkbench.ensure(sessionId);
  const nextStatus = resolveWorkbenchPathStatus(current.worktreePath);
  const patched = host.storage.chatSessionWorkbench.patch(sessionId, {
    projectId,
    worktreeStatus: nextStatus,
  });
  return hydrateWorkbenchRecord(host, patched, projectId);
}

function hydrateWorkbenchRecord(
  host: ChatWorkbenchHost,
  input: ChatSessionWorkbenchRecord,
  fallbackProjectId?: string,
): ChatSessionWorkbenchRecord {
  return {
    ...input,
    projectId: input.projectId ?? fallbackProjectId,
    worktreePath: input.worktreePath ? serializeWorkbenchPath(host, input.worktreePath) : undefined,
  };
}

function resolveWorkbenchContext(
  host: ChatWorkbenchHost,
  sessionId: string,
  state: ChatSessionWorkbenchRecord,
  requireWorktree: boolean,
): {
  project: { projectId: string; workspacePath: string };
  projectRoot: string;
  worktreePath: string;
  repoScopePath: string;
} {
  const project = resolveProjectContext(host, sessionId, true).project;
  const worktreePath = state.worktreePath ? deserializeWorkbenchPath(host, state.worktreePath) : undefined;
  if (!worktreePath || state.worktreeStatus !== "ready") {
    if (requireWorktree) {
      throw new ValidationError({ message: "This session does not have a ready worktree yet." });
    }
    throw new ValidationError({ message: "Workbench context is not ready." });
  }
  const repoScopePath = toRepoScopedProjectPath(host.config.assistant.workspaceDir, project.workspacePath);
  return {
    project,
    projectRoot: path.resolve(worktreePath, repoScopePath),
    worktreePath,
    repoScopePath,
  };
}

function resolveProjectContext(
  host: ChatWorkbenchHost,
  sessionId: string,
  required: boolean,
): {
  project: { projectId: string; workspacePath: string };
} {
  const projectId = host.storage.chatSessionProjects.get(sessionId)?.projectId;
  if (!projectId) {
    if (required) {
      throw new ValidationError({ message: "Bind a project before using the workbench." });
    }
    throw new ValidationError({ message: "Project context is unavailable." });
  }
  const project = host.storage.chatProjects.get(projectId);
  return {
    project: {
      projectId: project.projectId,
      workspacePath: project.workspacePath,
    },
  };
}

async function walkWorkbenchTree(
  rootDir: string,
  currentDir: string,
  out: ChatSessionWorkbenchTreeEntry[],
  changedFiles: string[],
  maxItems: number,
): Promise<void> {
  if (out.length >= maxItems) {
    return;
  }
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) {
      return left.isDirectory() ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  const changedSet = new Set(changedFiles);
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, fullPath).replaceAll("\\", "/");
    out.push({
      path: relativePath,
      name: entry.name,
      kind: entry.isDirectory() ? "directory" : "file",
      changed: entry.isDirectory()
        ? changedFiles.some((item) => item.startsWith(`${relativePath}/`))
        : changedSet.has(relativePath),
      depth: relativePath.split("/").length - 1,
    });
    if (out.length >= maxItems) {
      return;
    }
    if (entry.isDirectory()) {
      await walkWorkbenchTree(rootDir, fullPath, out, changedFiles, maxItems);
      if (out.length >= maxItems) {
        return;
      }
    }
  }
}

function listChangedFiles(worktreePath: string, repoScopePath: string): string[] {
  const status = runGit(worktreePath, ["status", "--short", "--", repoScopePath]);
  return parseChangedFilesFromStatus(status, repoScopePath);
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function serializeWorkbenchPath(host: ChatWorkbenchHost, fullPath: string): string {
  return serializePathWithinRoot(host.config.rootDir, fullPath);
}

function deserializeWorkbenchPath(host: ChatWorkbenchHost, storedPath: string): string {
  if (storedPath === "[outside-root]") {
    throw new ValidationError({ message: "Workbench path points outside the repository root." });
  }
  const normalized = storedPath.replace(/^\.\//, "");
  return path.resolve(host.config.rootDir, normalized);
}

function normalizeWorkbenchRelativePath(inputPath: string): string {
  const normalized = path.normalize(inputPath).replaceAll("\\", "/");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.endsWith("/..") ||
    normalized.includes("/../")
  ) {
    throw new ValidationError({ message: `Invalid relative path: ${inputPath}` });
  }
  if (path.isAbsolute(normalized)) {
    throw new ValidationError({ message: `Absolute paths are not allowed: ${inputPath}` });
  }
  return normalized;
}

function assertPathInsideRoot(targetPath: string, rootDir: string, label: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ValidationError({ message: `${label} is outside the project root.` });
  }
}

function toRepoScopedProjectPath(workspaceDir: string, projectWorkspacePath: string): string {
  const normalizedWorkspaceDir = workspaceDir.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const normalizedProjectPath = projectWorkspacePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return path.posix.join(normalizedWorkspaceDir, normalizedProjectPath);
}

export function resolveWorkbenchPathStatus(worktreePath?: string): ChatSessionWorkbenchRecord["worktreeStatus"] {
  if (!worktreePath) {
    return "uninitialized";
  }
  if (!fsSync.existsSync(worktreePath)) {
    return "missing";
  }
  return isWorkbenchPathUsable(worktreePath) ? "ready" : "blocked";
}

function isWorkbenchPathUsable(worktreePath: string): boolean {
  const gitPointerPath = path.join(worktreePath, ".git");
  return fsSync.existsSync(gitPointerPath);
}

export function parseChangedFilesFromStatus(status: string, repoScopePath: string): string[] {
  const normalizedScope = repoScopePath.replaceAll("\\", "/").replace(/\/$/, "");
  return status
    .split(/\r?\n/)
    .map((line) => extractChangedFilePath(line))
    .filter((value): value is string => Boolean(value))
    .map((rawPath) =>
      rawPath.startsWith(`${normalizedScope}/`) ? rawPath.slice(normalizedScope.length + 1) : rawPath,
    );
}

function extractChangedFilePath(statusLine: string): string | null {
  const line = statusLine.trimEnd();
  if (line.length <= 3) {
    return null;
  }
  const payload = line.slice(3).trim().replaceAll("\\", "/");
  if (!payload) {
    return null;
  }
  const renameArrow = " -> ";
  if (payload.includes(renameArrow)) {
    return payload.split(renameArrow).at(-1)?.trim() || null;
  }
  return payload;
}

function guessLanguage(filePath: string): string {
  return path.extname(filePath).replace(/^\./, "") || "text";
}

function guessContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".ts":
    case ".tsx":
      return "text/typescript";
    case ".js":
    case ".jsx":
      return "text/javascript";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    default:
      return "text/plain";
  }
}
