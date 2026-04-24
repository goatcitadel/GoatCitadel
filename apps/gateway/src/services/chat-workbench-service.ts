import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  NotFoundError,
  ValidationError,
  type ChatSessionWorkbenchDiffResponse,
  type ChatSessionWorkbenchFileDiffResponse,
  type ChatSessionWorkbenchFileResponse,
  type ChatSessionWorkbenchOutputResponse,
  type ChatSessionWorkbenchRecord,
  type ChatSessionWorkbenchSaveFileRequest,
  type ChatSessionWorkbenchTreeEntry,
  type ChatSessionWorkbenchTreeResponse,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { WorktreeManager } from "@goatcitadel/orchestration";
import { assertExistingPathRealpathAllowed, assertWritePathInJail } from "@goatcitadel/policy-engine";
import type { GatewayRuntimeConfig } from "../config.js";
import { serializePathWithinRoot } from "./security-utils.js";

const MAX_TREE_ITEMS = 250;
const MAX_FILE_BYTES = 256 * 1024;

type ChatWorkbenchStorage = Pick<
  Storage,
  "chatProjects" | "chatSessionProjects" | "chatSessionWorkbench" | "codeModeRuns"
>;

export interface ChatWorkbenchDependencies {
  readonly config: GatewayRuntimeConfig;
  readonly storage: ChatWorkbenchStorage;
  requireChatSession(sessionId: string): void;
  publishRealtime(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: Pick<import("@goatcitadel/contracts").RealtimeEvent, "eventClass" | "eventAuthority" | "links">,
  ): void;
}

export async function getChatSessionWorkbench(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
): Promise<ChatSessionWorkbenchRecord> {
  deps.requireChatSession(sessionId);
  return syncWorkbenchState(deps, sessionId);
}

export async function createChatSessionWorkbenchWorktree(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
  input: { baseRef?: string } = {},
): Promise<ChatSessionWorkbenchRecord> {
  deps.requireChatSession(sessionId);
  const context = resolveProjectContext(deps, sessionId, true);
  const current = syncWorkbenchState(deps, sessionId);
  const baseRef = input.baseRef?.trim() || current.baseRef || "HEAD";
  const worktreesRoot = path.resolve(deps.config.rootDir, deps.config.assistant.worktreesDir);
  const targetPath = path.resolve(worktreesRoot, sessionId);

  await fs.mkdir(worktreesRoot, { recursive: true });
  assertWritePathInJail(targetPath, deps.config.toolPolicy.sandbox.writeJailRoots);

  if (fsSync.existsSync(targetPath) && !isWorkbenchPathUsable(targetPath)) {
    throw new ValidationError({
      message:
        "Workbench path already exists but is not a valid git worktree. Clean it up before creating a new worktree for this session.",
    });
  }

  if (!fsSync.existsSync(targetPath)) {
    const manager = new WorktreeManager({
      repoRoot: context.repoRoot,
      worktreesRoot,
    });
    await manager.create(sessionId, baseRef);
  }

  const updated = deps.storage.chatSessionWorkbench.patch(sessionId, {
    projectId: context.project.projectId,
    baseRef,
    worktreePath: targetPath,
    worktreeStatus: "ready",
  });
  deps.publishRealtime("chat_workbench_updated", "chat", {
    type: "chat_workbench_worktree_created",
    sessionId,
    projectId: context.project.projectId,
    baseRef,
    worktreePath: serializeWorkbenchPath(deps, targetPath),
  });
  return hydrateWorkbenchRecord(deps, updated, context.project.projectId);
}

export async function getChatSessionWorkbenchTree(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
): Promise<ChatSessionWorkbenchTreeResponse> {
  deps.requireChatSession(sessionId);
  const state = syncWorkbenchState(deps, sessionId);
  const context = resolveWorkbenchContext(deps, sessionId, state, true);
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
  deps: ChatWorkbenchDependencies,
  sessionId: string,
  relativePath: string,
): Promise<ChatSessionWorkbenchFileResponse> {
  deps.requireChatSession(sessionId);
  const state = syncWorkbenchState(deps, sessionId);
  const context = resolveWorkbenchContext(deps, sessionId, state, true);
  return buildWorkbenchFileResponse(deps, sessionId, context, relativePath);
}

export async function saveChatSessionWorkbenchFile(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
  input: ChatSessionWorkbenchSaveFileRequest,
): Promise<ChatSessionWorkbenchFileResponse> {
  deps.requireChatSession(sessionId);
  const state = syncWorkbenchState(deps, sessionId);
  const context = resolveWorkbenchContext(deps, sessionId, state, true);
  const normalized = normalizeWorkbenchRelativePath(input.path);
  const targetPath = path.resolve(context.projectRoot, normalized);
  assertPathInsideRoot(targetPath, context.projectRoot, "workbench file");
  assertWritePathInJail(targetPath, deps.config.toolPolicy.sandbox.writeJailRoots);

  const contentBytes = Buffer.byteLength(input.content, "utf8");
  if (contentBytes > MAX_FILE_BYTES) {
    throw new ValidationError({
      message: `File exceeds ${MAX_FILE_BYTES} bytes and is too large for the workbench editor.`,
    });
  }

  let existingStat: fsSync.Stats | null = null;
  try {
    assertExistingPathRealpathAllowed(
      targetPath,
      deps.config.toolPolicy.sandbox.writeJailRoots,
      deps.config.toolPolicy.sandbox.readOnlyRoots,
    );
    existingStat = await fs.stat(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  if (existingStat?.isDirectory()) {
    throw new ValidationError({ message: `Path is a directory: ${normalized}` });
  }

  if (existingStat && existingStat.size > MAX_FILE_BYTES) {
    throw new ValidationError({
      message: `File exceeds ${MAX_FILE_BYTES} bytes and is too large for the workbench editor.`,
    });
  }

  if (existingStat) {
    const existingBuffer = await fs.readFile(targetPath);
    assertWorkbenchFileIsText(existingBuffer, normalized, "editor");
  } else {
    const parentDir = path.dirname(targetPath);
    const parentStat = await fs.stat(parentDir).catch(() => null);
    if (!parentStat?.isDirectory()) {
      throw new ValidationError({ message: `Parent directory does not exist for ${normalized}.` });
    }
    assertPathInsideRoot(parentDir, context.projectRoot, "workbench file parent");
  }

  await fs.writeFile(targetPath, input.content, "utf8");

  const response = await buildWorkbenchFileResponse(deps, sessionId, context, normalized);
  deps.publishRealtime(
    "chat_workbench_updated",
    "chat",
    {
      type: "chat_workbench_file_saved",
      sessionId,
      projectId: context.project.projectId,
      path: normalized,
      changed: response.changed,
      activeFilePath: response.state.activeFilePath,
    },
    {
      eventClass: "operational_signal",
      eventAuthority: "retained_stream",
      links: { sessionId },
    },
  );
  return response;
}

export async function getChatSessionWorkbenchFileDiff(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
  relativePath: string,
): Promise<ChatSessionWorkbenchFileDiffResponse> {
  deps.requireChatSession(sessionId);
  const state = syncWorkbenchState(deps, sessionId);
  const context = resolveWorkbenchContext(deps, sessionId, state, true);
  const file = await buildWorkbenchFileResponse(deps, sessionId, context, relativePath);
  const repoScopedFilePath = toRepoScopedFilePath(context.repoScopePath, file.path);
  const originalContent = file.changed
    ? (readGitFileAtHead(context.worktreePath, repoScopedFilePath) ?? "")
    : file.content;

  return {
    state: file.state,
    path: file.path,
    language: file.language,
    changed: file.changed,
    originalContent,
    modifiedContent: file.content,
  };
}

export async function getChatSessionWorkbenchDiff(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
): Promise<ChatSessionWorkbenchDiffResponse> {
  deps.requireChatSession(sessionId);
  const state = syncWorkbenchState(deps, sessionId);
  const context = resolveWorkbenchContext(deps, sessionId, state, true);
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
  const nextState = deps.storage.chatSessionWorkbench.patch(sessionId, {
    projectId: context.project.projectId,
    diffArtifactId: `workbench-diff:${sessionId}`,
  });
  return {
    state: hydrateWorkbenchRecord(deps, nextState, context.project.projectId),
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
  deps: ChatWorkbenchDependencies,
  sessionId: string,
): Promise<ChatSessionWorkbenchOutputResponse> {
  deps.requireChatSession(sessionId);
  syncWorkbenchState(deps, sessionId);
  const projectId = deps.storage.chatSessionProjects.get(sessionId)?.projectId;
  const helperRuns = deps.storage.codeModeRuns
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
  const nextState = deps.storage.chatSessionWorkbench.patch(sessionId, {
    projectId,
    outputArtifactId: latest ? `code-mode-run:${latest.runId}` : undefined,
    validationStatus,
  });
  return {
    state: hydrateWorkbenchRecord(deps, nextState, projectId),
    helperRuns,
    output,
    lastUpdatedAt: latest?.createdAt,
  };
}

function syncWorkbenchState(deps: ChatWorkbenchDependencies, sessionId: string): ChatSessionWorkbenchRecord {
  const projectId = deps.storage.chatSessionProjects.get(sessionId)?.projectId;
  const current = deps.storage.chatSessionWorkbench.ensure(sessionId);
  const nextStatus = resolveWorkbenchPathStatus(current.worktreePath);
  const patched = deps.storage.chatSessionWorkbench.patch(sessionId, {
    projectId,
    worktreeStatus: nextStatus,
  });
  return hydrateWorkbenchRecord(deps, patched, projectId);
}

async function buildWorkbenchFileResponse(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
  context: {
    project: { projectId: string; workspacePath: string };
    projectRoot: string;
    worktreePath: string;
    repoScopePath: string;
  },
  relativePath: string,
): Promise<ChatSessionWorkbenchFileResponse> {
  const { normalized, targetPath, stat, content } = await readWorkbenchFilePayload(
    deps,
    context.projectRoot,
    relativePath,
  );
  const changedFiles = new Set(listChangedFiles(context.worktreePath, context.repoScopePath));
  const nextState = deps.storage.chatSessionWorkbench.patch(sessionId, {
    projectId: context.project.projectId,
    activeFilePath: normalized,
  });
  return {
    state: hydrateWorkbenchRecord(deps, nextState, context.project.projectId),
    path: normalized,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    contentType: guessContentType(targetPath),
    language: guessLanguage(targetPath),
    changed: changedFiles.has(normalized),
    content,
  };
}

function hydrateWorkbenchRecord(
  deps: ChatWorkbenchDependencies,
  input: ChatSessionWorkbenchRecord,
  fallbackProjectId?: string,
): ChatSessionWorkbenchRecord {
  return {
    ...input,
    projectId: input.projectId ?? fallbackProjectId,
    worktreePath: input.worktreePath ? serializeWorkbenchPath(deps, input.worktreePath) : undefined,
  };
}

function resolveWorkbenchContext(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
  state: ChatSessionWorkbenchRecord,
  requireWorktree: boolean,
): {
  project: { projectId: string; workspacePath: string };
  projectRoot: string;
  worktreePath: string;
  repoScopePath: string;
} {
  const project = resolveProjectContext(deps, sessionId, true).project;
  const projectContext = resolveProjectContext(deps, sessionId, true);
  const worktreePath = state.worktreePath ? deserializeWorkbenchPath(deps, state.worktreePath) : undefined;
  if (!worktreePath || state.worktreeStatus !== "ready") {
    if (requireWorktree) {
      throw new ValidationError({ message: "This session does not have a ready worktree yet." });
    }
    throw new ValidationError({ message: "Workbench context is not ready." });
  }
  const repoScopePath =
    projectContext.kind === "standalone_repo"
      ? "."
      : toRepoScopedProjectPath(deps.config.assistant.workspaceDir, project.workspacePath);
  return {
    project,
    projectRoot: projectContext.kind === "standalone_repo" ? worktreePath : path.resolve(worktreePath, repoScopePath),
    worktreePath,
    repoScopePath,
  };
}

function resolveProjectContext(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
  required: boolean,
): {
  project: { projectId: string; workspacePath: string };
  repoRoot: string;
  kind: "workspace_subpath" | "standalone_repo";
} {
  const projectId = deps.storage.chatSessionProjects.get(sessionId)?.projectId;
  if (!projectId) {
    if (required) {
      throw new ValidationError({ message: "Bind a project before using the workbench." });
    }
    throw new ValidationError({ message: "Project context is unavailable." });
  }
  const project = deps.storage.chatProjects.get(projectId);
  const workspaceRoot = path.resolve(deps.config.rootDir, deps.config.assistant.workspaceDir);
  const absoluteProjectPath = path.resolve(workspaceRoot, project.workspacePath);
  const standaloneRepoRoot = isStandaloneProjectRepoRoot(workspaceRoot, absoluteProjectPath)
    ? absoluteProjectPath
    : undefined;
  return {
    project: {
      projectId: project.projectId,
      workspacePath: project.workspacePath,
    },
    repoRoot: standaloneRepoRoot ?? deps.config.rootDir,
    kind: standaloneRepoRoot ? "standalone_repo" : "workspace_subpath",
  };
}

async function readWorkbenchFilePayload(
  deps: ChatWorkbenchDependencies,
  projectRoot: string,
  relativePath: string,
): Promise<{
  normalized: string;
  targetPath: string;
  stat: fsSync.Stats;
  content: string;
}> {
  const normalized = normalizeWorkbenchRelativePath(relativePath);
  const targetPath = path.resolve(projectRoot, normalized);
  assertPathInsideRoot(targetPath, projectRoot, "workbench file");
  try {
    assertExistingPathRealpathAllowed(
      targetPath,
      deps.config.toolPolicy.sandbox.writeJailRoots,
      deps.config.toolPolicy.sandbox.readOnlyRoots,
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

  const contentBuffer = await fs.readFile(targetPath);
  assertWorkbenchFileIsText(contentBuffer, normalized, "viewer");
  return {
    normalized,
    targetPath,
    stat,
    content: contentBuffer.toString("utf8"),
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

function readGitFileAtHead(cwd: string, repoScopedFilePath: string): string | null {
  try {
    return runGit(cwd, ["show", `HEAD:${repoScopedFilePath}`]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("exists on disk, but not in 'HEAD'") || message.includes("does not exist in 'HEAD'")) {
      return null;
    }
    throw error;
  }
}

function serializeWorkbenchPath(deps: ChatWorkbenchDependencies, fullPath: string): string {
  return serializePathWithinRoot(deps.config.rootDir, fullPath);
}

function deserializeWorkbenchPath(deps: ChatWorkbenchDependencies, storedPath: string): string {
  if (storedPath === "[outside-root]") {
    throw new ValidationError({ message: "Workbench path points outside the repository root." });
  }
  const normalized = storedPath.replace(/^\.\//, "");
  return path.resolve(deps.config.rootDir, normalized);
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

function toRepoScopedFilePath(repoScopePath: string, relativePath: string): string {
  const normalizedScope = repoScopePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const normalizedRelativePath = normalizeWorkbenchRelativePath(relativePath);
  return path.posix.join(normalizedScope, normalizedRelativePath);
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

function isStandaloneProjectRepoRoot(workspaceRoot: string, projectRoot: string): boolean {
  const relative = path.relative(workspaceRoot, projectRoot);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  return fsSync.existsSync(path.join(projectRoot, ".git"));
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

function assertWorkbenchFileIsText(fileBuffer: Buffer, relativePath: string, surface: "viewer" | "editor"): void {
  const sample = fileBuffer.subarray(0, Math.min(fileBuffer.length, 8192));
  if (sample.includes(0)) {
    throw new ValidationError({
      message: `File is not a text file and cannot be opened in the workbench ${surface}: ${relativePath}`,
    });
  }
}
