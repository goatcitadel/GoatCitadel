import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
/* eslint-disable max-lines */
import { randomUUID } from "node:crypto";
import {
  NotFoundError,
  ValidationError,
  type AgenticCommandRunRecord,
  type ChatSessionWorkbenchCommandRunRequest,
  type ChatSessionWorkbenchCommandRunResponse,
  type ChatSessionWorkbenchDiffResponse,
  type ChatSessionWorkbenchFileDiffResponse,
  type ChatSessionWorkbenchFileResponse,
  type ChatSessionWorkbenchOutputResponse,
  type ChatSessionWorkbenchPackageManager,
  type ChatSessionWorkbenchPatchApplyRequest,
  type ChatSessionWorkbenchPatchApplyResponse,
  type ChatSessionWorkbenchPatchExportResponse,
  type ChatSessionWorkbenchRecord,
  type ChatSessionWorkbenchRevertFileRequest,
  type ChatSessionWorkbenchRevertResponse,
  type ChatSessionWorkbenchSaveFileRequest,
  type ChatSessionWorkbenchTreeEntry,
  type ChatSessionWorkbenchTreeResponse,
  type ChatSessionWorkbenchValidationResult,
  type CodeModeRunRecord,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { WorktreeManager } from "@goatcitadel/orchestration";
import {
  assertExistingPathRealpathAllowed,
  assertWritePathInJail,
  resolveExecutableCommand,
} from "@goatcitadel/policy-engine";
import type { GatewayRuntimeConfig } from "../config.js";
import { serializePathWithinRoot } from "./security-utils.js";

const MAX_TREE_ITEMS = 250;
const MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_ARGS = 64;
const MAX_COMMAND_ARG_BYTES = 4096;
const COMMAND_OUTPUT_CAPTURE_BYTES = 64 * 1024;
const COMMAND_OUTPUT_PREVIEW_CHARS = 12 * 1024;
const PACKAGE_MANAGER_COMMANDS = new Set(["npm", "pnpm", "yarn", "bun"]);
const VALIDATION_SCRIPT_PATTERN =
  /^(test|typecheck|lint|build|check|verify|coverage)(:[a-zA-Z0-9._-]+)*$|^format:check$/;

type ChatWorkbenchStorage = Pick<
  Storage,
  "chatProjects" | "chatSessionProjects" | "chatSessionWorkbench" | "codeModeRuns"
>;

export interface ChatWorkbenchDependencies {
  readonly config: GatewayRuntimeConfig;
  readonly storage: ChatWorkbenchStorage;
  requireChatSession(sessionId: string): void;
  listCodeModeRuns?(options: { limit?: number; sessionId?: string }): CodeModeRunRecord[];
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
  const changedFiles = listChangedFiles(context.worktreePath, context.repoScopePath);
  const validation = await runWorkbenchPostWriteValidation(deps, sessionId, context, changedFiles);

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
      validationStatus: response.state.validationStatus,
      validation,
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

export async function runChatSessionWorkbenchCommand(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
  input: ChatSessionWorkbenchCommandRunRequest,
): Promise<ChatSessionWorkbenchCommandRunResponse> {
  deps.requireChatSession(sessionId);
  const state = syncWorkbenchState(deps, sessionId);
  const context = resolveWorkbenchContext(deps, sessionId, state, true);
  assertExistingPathRealpathAllowed(
    context.projectRoot,
    deps.config.toolPolicy.sandbox.writeJailRoots,
    deps.config.toolPolicy.sandbox.readOnlyRoots,
  );
  assertWritePathInJail(context.projectRoot, deps.config.toolPolicy.sandbox.writeJailRoots);

  const command = normalizeWorkbenchCommand(input.command);
  const args = normalizeWorkbenchCommandArgs(input.args ?? []);
  assertWorkbenchCommandAllowed(command, args);
  const timeoutMs = normalizeWorkbenchCommandTimeout(input.timeoutMs);
  const commandRunId = `workbench-command:${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  deps.storage.chatSessionWorkbench.patch(sessionId, {
    projectId: context.project.projectId,
    outputArtifactId: commandRunId,
    validationStatus: "pending",
  });
  deps.publishRealtime(
    "chat_workbench_updated",
    "chat",
    {
      type: "chat_workbench_command_started",
      sessionId,
      projectId: context.project.projectId,
      commandRunId,
      command,
      args,
      timeoutMs,
      cwd: serializeWorkbenchPath(deps, context.projectRoot),
      validationStatus: "pending",
    },
    {
      eventClass: "operational_signal",
      eventAuthority: "retained_stream",
      links: { sessionId },
    },
  );

  const result = await executeWorkbenchCommand(command, args, {
    cwd: context.projectRoot,
    timeoutMs,
  });
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startedAtMs;
  const status = result.timedOut ? "timed_out" : result.exitCode === 0 ? "passed" : "failed";
  const validationStatus = status === "passed" ? "passed" : "failed";
  const finalState = deps.storage.chatSessionWorkbench.patch(sessionId, {
    projectId: context.project.projectId,
    outputArtifactId: commandRunId,
    validationStatus,
  });
  const stderrPreview = result.spawnError
    ? appendPreviewLine(result.stderrPreview, result.spawnError)
    : result.stderrPreview;
  const run: AgenticCommandRunRecord & {
    cwd: string;
    durationMs: number;
    stdoutBytes: number;
    stderrBytes: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  } = {
    commandRunId,
    sessionId,
    worktreePath: serializeWorkbenchPath(deps, context.worktreePath),
    command,
    args,
    status,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    startedAt,
    completedAt,
    stdoutPreview: result.stdoutPreview,
    stderrPreview,
    validationStatus,
    cwd: serializeWorkbenchPath(deps, context.projectRoot),
    durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  };

  deps.publishRealtime(
    "chat_workbench_updated",
    "chat",
    {
      type: "chat_workbench_command_completed",
      sessionId,
      projectId: context.project.projectId,
      commandRunId,
      command,
      args,
      status,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      validationStatus,
      stdoutPreview: run.stdoutPreview,
      stderrPreview: run.stderrPreview,
      stdoutTruncated: run.stdoutTruncated,
      stderrTruncated: run.stderrTruncated,
    },
    {
      eventClass: "operational_signal",
      eventAuthority: "retained_stream",
      links: { sessionId },
    },
  );

  return {
    state: hydrateWorkbenchRecord(deps, finalState, context.project.projectId),
    run,
    output: buildWorkbenchOperationOutput(
      hydrateWorkbenchRecord(deps, finalState, context.project.projectId),
      formatCommandOutput(command, args, status, run.stdoutPreview, run.stderrPreview),
      completedAt,
    ),
  };
}

export async function applyChatSessionWorkbenchPatch(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
  input: ChatSessionWorkbenchPatchApplyRequest,
): Promise<ChatSessionWorkbenchPatchApplyResponse> {
  deps.requireChatSession(sessionId);
  const state = syncWorkbenchState(deps, sessionId);
  const context = resolveWorkbenchContext(deps, sessionId, state, true);
  assertWorkbenchMutationScope(deps, context);
  const patch = normalizeWorkbenchPatch(input.patch);
  const patchPaths = extractPatchPaths(patch);
  assertPatchPathsInWorkbenchScope(context, patchPaths);
  const checkOnly = Boolean(input.checkOnly);
  const startedAt = new Date().toISOString();
  const artifactId = `workbench-patch:${randomUUID()}`;
  const applyResult = applyPatchWithScope(context, patch, checkOnly);
  const changedFiles = listChangedFiles(context.worktreePath, context.repoScopePath);
  const validation =
    applyResult.exitCode === 0 && !checkOnly
      ? await runWorkbenchPostWriteValidation(deps, sessionId, context, changedFiles)
      : undefined;
  const validationStatus =
    applyResult.exitCode !== 0 ? "failed" : validation ? mapWorkbenchValidationState(validation) : "passed";
  const finalState = deps.storage.chatSessionWorkbench.patch(sessionId, {
    projectId: context.project.projectId,
    diffArtifactId: artifactId,
    validationStatus,
  });
  const hydrated = hydrateWorkbenchRecord(deps, finalState, context.project.projectId);
  const output = buildWorkbenchOperationOutput(
    hydrated,
    formatCommandOutput(
      checkOnly ? "git apply --check" : "git apply",
      [],
      applyResult.exitCode === 0 ? "passed" : "failed",
      applyResult.stdoutPreview,
      applyResult.stderrPreview,
    ),
    startedAt,
    validation,
  );
  deps.publishRealtime(
    "chat_workbench_updated",
    "chat",
    {
      type: checkOnly ? "chat_workbench_patch_checked" : "chat_workbench_patch_applied",
      sessionId,
      projectId: context.project.projectId,
      patchArtifactId: artifactId,
      applied: !checkOnly && applyResult.exitCode === 0,
      checkOnly,
      changedFiles,
      validationStatus,
      validation,
    },
    {
      eventClass: "operational_signal",
      eventAuthority: "retained_stream",
      links: { sessionId },
    },
  );
  if (applyResult.exitCode !== 0) {
    throw new ValidationError({
      message: output.output || "Patch could not be applied to the workbench.",
    });
  }
  return {
    state: hydrated,
    applied: !checkOnly,
    checkOnly,
    changedFiles,
    output,
  };
}

export async function exportChatSessionWorkbenchPatch(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
): Promise<ChatSessionWorkbenchPatchExportResponse> {
  deps.requireChatSession(sessionId);
  const state = syncWorkbenchState(deps, sessionId);
  const context = resolveWorkbenchContext(deps, sessionId, state, true);
  assertWorkbenchMutationScope(deps, context);
  const diff = await getChatSessionWorkbenchDiff(deps, sessionId);
  return {
    state: diff.state,
    patch: diff.diff,
    changedFiles: diff.changedFiles,
    summary: diff.summary,
    generatedAt: new Date().toISOString(),
  };
}

export async function revertChatSessionWorkbenchFile(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
  input: ChatSessionWorkbenchRevertFileRequest,
): Promise<ChatSessionWorkbenchRevertResponse> {
  deps.requireChatSession(sessionId);
  const state = syncWorkbenchState(deps, sessionId);
  const context = resolveWorkbenchContext(deps, sessionId, state, true);
  assertWorkbenchMutationScope(deps, context);
  const normalized = normalizeWorkbenchRelativePath(input.path);
  const targetPath = path.resolve(context.projectRoot, normalized);
  assertPathInsideRoot(targetPath, context.projectRoot, "workbench revert file");
  assertWritePathInJail(targetPath, deps.config.toolPolicy.sandbox.writeJailRoots);
  const repoScopedPath = toRepoScopedFilePath(context.repoScopePath, normalized);
  const wasUntracked = isGitPathUntracked(context.worktreePath, repoScopedPath);
  if (wasUntracked) {
    await fs.rm(targetPath, { recursive: true, force: true });
  } else {
    runGit(context.worktreePath, ["restore", "--source=HEAD", "--staged", "--worktree", "--", repoScopedPath]);
  }
  const changedFiles = listChangedFiles(context.worktreePath, context.repoScopePath);
  const finalState = deps.storage.chatSessionWorkbench.patch(sessionId, {
    projectId: context.project.projectId,
    validationStatus: "idle",
  });
  const hydrated = hydrateWorkbenchRecord(deps, finalState, context.project.projectId);
  const output = buildWorkbenchOperationOutput(
    hydrated,
    `Reverted ${normalized}${wasUntracked ? " by removing the untracked file." : "."}`,
    new Date().toISOString(),
  );
  publishWorkbenchRevert(deps, sessionId, context.project.projectId, [normalized], changedFiles);
  return {
    state: hydrated,
    revertedFiles: [normalized],
    changedFiles,
    output,
  };
}

export async function revertChatSessionWorkbenchChanges(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
): Promise<ChatSessionWorkbenchRevertResponse> {
  deps.requireChatSession(sessionId);
  const state = syncWorkbenchState(deps, sessionId);
  const context = resolveWorkbenchContext(deps, sessionId, state, true);
  assertWorkbenchMutationScope(deps, context);
  const before = listChangedFiles(context.worktreePath, context.repoScopePath);
  runGit(context.worktreePath, ["restore", "--source=HEAD", "--staged", "--worktree", "--", context.repoScopePath]);
  const untrackedFiles = listUntrackedFiles(context.worktreePath, context.repoScopePath);
  for (const repoScopedPath of untrackedFiles) {
    const relativePath = fromRepoScopedFilePath(context.repoScopePath, repoScopedPath);
    const targetPath = path.resolve(context.projectRoot, relativePath);
    assertPathInsideRoot(targetPath, context.projectRoot, "workbench revert all file");
    assertWritePathInJail(targetPath, deps.config.toolPolicy.sandbox.writeJailRoots);
    await fs.rm(targetPath, { recursive: true, force: true });
  }
  const changedFiles = listChangedFiles(context.worktreePath, context.repoScopePath);
  const finalState = deps.storage.chatSessionWorkbench.patch(sessionId, {
    projectId: context.project.projectId,
    diffArtifactId: undefined,
    validationStatus: "idle",
  });
  const hydrated = hydrateWorkbenchRecord(deps, finalState, context.project.projectId);
  const output = buildWorkbenchOperationOutput(
    hydrated,
    before.length === 0 ? "No workbench changes needed to be reverted." : `Reverted ${before.length} file change(s).`,
    new Date().toISOString(),
  );
  publishWorkbenchRevert(deps, sessionId, context.project.projectId, before, changedFiles);
  return {
    state: hydrated,
    revertedFiles: before,
    changedFiles,
    output,
  };
}

export async function getChatSessionWorkbenchOutput(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
): Promise<ChatSessionWorkbenchOutputResponse> {
  deps.requireChatSession(sessionId);
  const state = syncWorkbenchState(deps, sessionId);
  const projectId = deps.storage.chatSessionProjects.get(sessionId)?.projectId;
  const codeModeRuns =
    deps.listCodeModeRuns?.({ sessionId, limit: 8 }) ??
    (typeof deps.storage.codeModeRuns.listFiltered === "function"
      ? deps.storage.codeModeRuns.listFiltered({ sessionId, limit: 8 })
      : deps.storage.codeModeRuns
          .list(500)
          .filter((run) => run.sessionId === sessionId)
          .slice(0, 8));
  const helperRuns = codeModeRuns.slice(0, 8).map((run) => ({
    runId: run.runId,
    turnId: run.turnId,
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
      : latest.status === "failed" || latest.status === "expired" || latest.status === "rejected"
        ? "failed"
        : "pending"
    : state.validationStatus;
  const output =
    helperRuns.length === 0
      ? state.validationStatus === "idle"
        ? "No validation output yet."
        : `Latest validation status: ${state.validationStatus}.`
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
  const detectedPackageManager =
    current.packageManager === undefined ? detectProjectPackageManager(deps, projectId) : undefined;
  const patched = deps.storage.chatSessionWorkbench.patch(sessionId, {
    projectId,
    worktreeStatus: nextStatus,
    packageManager: detectedPackageManager,
  });
  return hydrateWorkbenchRecord(deps, patched, projectId);
}

const PACKAGE_MANAGER_LOCKFILES: Array<[string, ChatSessionWorkbenchPackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
];

export function detectPackageManagerFromRoot(root: string): ChatSessionWorkbenchPackageManager | undefined {
  for (const [filename, manager] of PACKAGE_MANAGER_LOCKFILES) {
    try {
      if (fsSync.existsSync(path.join(root, filename))) {
        return manager;
      }
    } catch {
      // ignore unreadable paths; treat as no lockfile
    }
  }
  return undefined;
}

function detectProjectPackageManager(
  deps: ChatWorkbenchDependencies,
  projectId: string | undefined,
): ChatSessionWorkbenchPackageManager | undefined {
  if (!projectId) {
    return undefined;
  }
  let project: { workspacePath: string } | undefined;
  try {
    project = deps.storage.chatProjects.get(projectId);
  } catch {
    return undefined;
  }
  if (!project) {
    return undefined;
  }
  const workspaceRoot = path.resolve(deps.config.rootDir, deps.config.assistant.workspaceDir);
  const absoluteProjectPath = path.resolve(workspaceRoot, project.workspacePath);
  const projectMatch = detectPackageManagerFromRoot(absoluteProjectPath);
  if (projectMatch) {
    return projectMatch;
  }
  return detectPackageManagerFromRoot(deps.config.rootDir);
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
  const effectiveProjectId = input.projectId ?? fallbackProjectId;
  return {
    ...input,
    projectId: effectiveProjectId,
    worktreePath: input.worktreePath ? serializeWorkbenchPath(deps, input.worktreePath) : undefined,
  };
}

function buildWorkbenchOperationOutput(
  state: ChatSessionWorkbenchRecord,
  output: string,
  lastUpdatedAt: string,
  validation?: ChatSessionWorkbenchValidationResult,
): ChatSessionWorkbenchOutputResponse {
  return {
    state,
    helperRuns: [],
    output: [output || "Workbench operation completed.", formatWorkbenchValidationOutput(validation)]
      .filter(Boolean)
      .join("\n\n"),
    validation,
    lastUpdatedAt,
  };
}

function formatWorkbenchValidationOutput(validation?: ChatSessionWorkbenchValidationResult): string | undefined {
  if (!validation) {
    return undefined;
  }
  const label = validation.commandLabel ? `Post-write validation: ${validation.commandLabel}` : "Post-write validation";
  const lines = [
    `${label} · ${validation.status}`,
    validation.reason ? `Reason: ${validation.reason}` : undefined,
    validation.durationMs !== undefined ? `Duration: ${validation.durationMs}ms` : undefined,
    validation.changedFiles.length > 0 ? `Changed files: ${validation.changedFiles.join(", ")}` : undefined,
    validation.stdoutPreview ? `stdout\n${validation.stdoutPreview}` : undefined,
    validation.stderrPreview ? `stderr\n${validation.stderrPreview}` : undefined,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n\n");
}

async function runWorkbenchPostWriteValidation(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
  context: {
    project: { projectId: string; workspacePath: string };
    projectRoot: string;
    worktreePath: string;
    repoScopePath: string;
  },
  changedFiles: string[],
): Promise<ChatSessionWorkbenchValidationResult> {
  const startedAt = Date.now();
  const distinctChangedFiles = [...new Set(changedFiles)].sort();
  if (distinctChangedFiles.length === 0) {
    const validation = buildSkippedWorkbenchValidation(
      distinctChangedFiles,
      "No changed files were detected after the write.",
      startedAt,
    );
    persistWorkbenchValidationResult(deps, sessionId, context.project.projectId, validation);
    publishWorkbenchValidationResult(deps, sessionId, context.project.projectId, validation);
    return validation;
  }

  const jsonValidation = await validateChangedJsonFiles(context.projectRoot, distinctChangedFiles, startedAt);
  if (jsonValidation.status === "failed") {
    persistWorkbenchValidationResult(deps, sessionId, context.project.projectId, jsonValidation);
    publishWorkbenchValidationResult(deps, sessionId, context.project.projectId, jsonValidation);
    return jsonValidation;
  }

  if (!fsSync.existsSync(path.join(context.worktreePath, ".git"))) {
    const validation = buildSkippedWorkbenchValidation(
      distinctChangedFiles,
      "No Git metadata is available for the workbench, so git diff --check could not run.",
      startedAt,
    );
    persistWorkbenchValidationResult(deps, sessionId, context.project.projectId, validation);
    publishWorkbenchValidationResult(deps, sessionId, context.project.projectId, validation);
    return validation;
  }

  const command = "git";
  const args = ["diff", "--check"];
  assertWorkbenchCommandAllowed(command, args);
  const result = await executeWorkbenchCommand(command, args, {
    cwd: context.projectRoot,
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  });
  const stderrPreview = result.spawnError
    ? appendPreviewLine(result.stderrPreview, result.spawnError)
    : result.stderrPreview;
  const validation: ChatSessionWorkbenchValidationResult = {
    status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "passed" : "failed",
    commandLabel: "git diff --check",
    durationMs: Date.now() - startedAt,
    changedFiles: distinctChangedFiles,
    stdoutPreview: result.stdoutPreview,
    stderrPreview,
    reason: result.timedOut ? "Validation timed out before completion." : result.spawnError,
  };
  persistWorkbenchValidationResult(deps, sessionId, context.project.projectId, validation);
  publishWorkbenchValidationResult(deps, sessionId, context.project.projectId, validation);
  return validation;
}

async function validateChangedJsonFiles(
  projectRoot: string,
  changedFiles: string[],
  startedAt: number,
): Promise<ChatSessionWorkbenchValidationResult> {
  const jsonFiles = changedFiles.filter((file) => /\.json$/i.test(file));
  for (const relativePath of jsonFiles) {
    const targetPath = path.resolve(projectRoot, relativePath);
    assertPathInsideRoot(targetPath, projectRoot, "workbench validation file");
    if (!fsSync.existsSync(targetPath)) {
      continue;
    }
    try {
      JSON.parse(await fs.readFile(targetPath, "utf8"));
    } catch (error) {
      return {
        status: "failed",
        commandLabel: "JSON parse",
        durationMs: Date.now() - startedAt,
        changedFiles,
        stderrPreview: `${relativePath}: ${(error as Error).message}`,
        reason: "Changed JSON failed to parse.",
      };
    }
  }
  return {
    status: "passed",
    commandLabel: "JSON parse",
    durationMs: Date.now() - startedAt,
    changedFiles,
  };
}

function buildSkippedWorkbenchValidation(
  changedFiles: string[],
  reason: string,
  startedAt: number,
): ChatSessionWorkbenchValidationResult {
  return {
    status: "skipped",
    commandLabel: "post-write validation",
    durationMs: Date.now() - startedAt,
    changedFiles,
    reason,
  };
}

function persistWorkbenchValidationResult(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
  projectId: string,
  validation: ChatSessionWorkbenchValidationResult,
): void {
  deps.storage.chatSessionWorkbench.patch(sessionId, {
    projectId,
    validationStatus: mapWorkbenchValidationState(validation),
  });
}

function publishWorkbenchValidationResult(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
  projectId: string,
  validation: ChatSessionWorkbenchValidationResult,
): void {
  deps.publishRealtime(
    "chat_workbench_updated",
    "chat",
    {
      type: "chat_workbench_post_write_validation_completed",
      sessionId,
      projectId,
      validationStatus: mapWorkbenchValidationState(validation),
      validation,
    },
    {
      eventClass: "operational_signal",
      eventAuthority: "retained_stream",
      links: { sessionId },
    },
  );
}

function mapWorkbenchValidationState(
  validation: ChatSessionWorkbenchValidationResult,
): ChatSessionWorkbenchRecord["validationStatus"] {
  if (validation.status === "passed") {
    return "passed";
  }
  if (validation.status === "skipped") {
    return "idle";
  }
  return "failed";
}

function formatCommandOutput(
  command: string,
  args: string[],
  status: "passed" | "failed" | "timed_out",
  stdoutPreview?: string,
  stderrPreview?: string,
): string {
  const commandLine = [command, ...args].join(" ");
  const sections = [`${commandLine} · ${status}`];
  if (stdoutPreview) {
    sections.push(`stdout\n${stdoutPreview}`);
  }
  if (stderrPreview) {
    sections.push(`stderr\n${stderrPreview}`);
  }
  return sections.join("\n\n");
}

function publishWorkbenchRevert(
  deps: ChatWorkbenchDependencies,
  sessionId: string,
  projectId: string,
  revertedFiles: string[],
  changedFiles: string[],
): void {
  deps.publishRealtime(
    "chat_workbench_updated",
    "chat",
    {
      type: "chat_workbench_reverted",
      sessionId,
      projectId,
      revertedFiles,
      changedFiles,
      validationStatus: "idle",
    },
    {
      eventClass: "operational_signal",
      eventAuthority: "retained_stream",
      links: { sessionId },
    },
  );
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

function listUntrackedFiles(worktreePath: string, repoScopePath: string): string[] {
  const output = runGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "--", repoScopePath]);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter(Boolean);
}

function isGitPathUntracked(worktreePath: string, repoScopedPath: string): boolean {
  const status = runGit(worktreePath, ["status", "--short", "--", repoScopedPath]);
  return status
    .split(/\r?\n/)
    .some((line) => line.startsWith("?? ") && extractChangedFilePath(line) === repoScopedPath.replaceAll("\\", "/"));
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function runGitWithInput(cwd: string, args: string[], input: string): WorkbenchCommandExecutionResult {
  const stdout = createCappedOutputCapture(COMMAND_OUTPUT_CAPTURE_BYTES);
  const stderr = createCappedOutputCapture(COMMAND_OUTPUT_CAPTURE_BYTES);
  try {
    const output = execFileSync("git", ["-C", cwd, ...args], {
      input,
      windowsHide: true,
      maxBuffer: COMMAND_OUTPUT_CAPTURE_BYTES,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    stdout.append(output);
    return {
      exitCode: 0,
      timedOut: false,
      stdoutPreview: stdout.preview(),
      stderrPreview: stderr.preview(),
      stdoutBytes: stdout.totalBytes,
      stderrBytes: stderr.totalBytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      status?: number;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    if (execError.stdout) {
      stdout.append(execError.stdout);
    }
    if (execError.stderr) {
      stderr.append(execError.stderr);
    }
    return {
      exitCode: typeof execError.status === "number" ? execError.status : 1,
      timedOut: false,
      spawnError: execError.message,
      stdoutPreview: stdout.preview(),
      stderrPreview: appendPreviewLine(stderr.preview(), execError.message),
      stdoutBytes: stdout.totalBytes,
      stderrBytes: stderr.totalBytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  }
}

function applyPatchWithScope(
  context: { worktreePath: string; repoScopePath: string },
  patch: string,
  checkOnly: boolean,
): WorkbenchCommandExecutionResult {
  const usesRepoScopedPaths = patchUsesRepoScopedPaths(patch, context.repoScopePath);
  if (context.repoScopePath !== "." && !usesRepoScopedPaths) {
    const scopedArgs = ["apply", "--whitespace=nowarn", `--directory=${context.repoScopePath}`];
    if (checkOnly) {
      scopedArgs.push("--check");
    }
    scopedArgs.push("-");
    return runGitWithInput(context.worktreePath, scopedArgs, patch);
  }
  const args = ["apply", "--whitespace=nowarn"];
  if (checkOnly) {
    args.push("--check");
  }
  args.push("-");
  const direct = runGitWithInput(context.worktreePath, args, patch);
  return direct;
}

function patchUsesRepoScopedPaths(patch: string, repoScopePath: string): boolean {
  const normalizedScope = repoScopePath.replaceAll("\\", "/").replace(/\/$/, "");
  if (normalizedScope === ".") {
    return true;
  }
  return extractPatchPaths(patch).some(
    (patchPath) => patchPath === normalizedScope || patchPath.startsWith(`${normalizedScope}/`),
  );
}

interface WorkbenchCommandExecutionOptions {
  cwd: string;
  timeoutMs: number;
}

interface WorkbenchCommandExecutionResult {
  exitCode?: number;
  timedOut: boolean;
  spawnError?: string;
  stdoutPreview?: string;
  stderrPreview?: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

async function executeWorkbenchCommand(
  command: string,
  args: string[],
  options: WorkbenchCommandExecutionOptions,
): Promise<WorkbenchCommandExecutionResult> {
  const executable = resolveExecutableCommand(command, args);
  const stdout = createCappedOutputCapture(COMMAND_OUTPUT_CAPTURE_BYTES);
  const stderr = createCappedOutputCapture(COMMAND_OUTPUT_CAPTURE_BYTES);
  return await new Promise<WorkbenchCommandExecutionResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let spawnError: string | undefined;
    let forcedSettleHandle: NodeJS.Timeout | undefined;
    const child = spawn(executable.file, executable.args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        CI: process.env.CI ?? "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      windowsHide: true,
      shell: false,
    });

    const settle = (exitCode?: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (forcedSettleHandle) {
        clearTimeout(forcedSettleHandle);
      }
      resolve({
        exitCode,
        timedOut,
        spawnError,
        stdoutPreview: stdout.preview(),
        stderrPreview: stderr.preview(),
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill();
      forcedSettleHandle = setTimeout(() => settle(undefined), 1_500);
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
    child.once("error", (error) => {
      spawnError = error instanceof Error ? error.message : String(error);
      settle(undefined);
    });
    child.once("close", (code) => {
      settle(typeof code === "number" ? code : undefined);
    });
  });
}

function createCappedOutputCapture(maxBytes: number): {
  append(chunk: Buffer | string): void;
  preview(): string | undefined;
  readonly totalBytes: number;
  readonly truncated: boolean;
} {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let totalBytes = 0;
  return {
    append(chunk: Buffer | string): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      const remaining = maxBytes - capturedBytes;
      if (remaining <= 0) {
        return;
      }
      const next = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
      chunks.push(next);
      capturedBytes += next.length;
    },
    preview(): string | undefined {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text && totalBytes === 0) {
        return undefined;
      }
      const outputWasTruncated = totalBytes > capturedBytes || text.length > COMMAND_OUTPUT_PREVIEW_CHARS;
      const body = text.length > COMMAND_OUTPUT_PREVIEW_CHARS ? text.slice(0, COMMAND_OUTPUT_PREVIEW_CHARS) : text;
      return outputWasTruncated ? appendPreviewLine(body, "...[truncated]") : body;
    },
    get totalBytes(): number {
      return totalBytes;
    },
    get truncated(): boolean {
      return totalBytes > capturedBytes;
    },
  };
}

function appendPreviewLine(value: string | undefined, line: string): string {
  const trimmed = value?.trimEnd();
  return trimmed ? `${trimmed}\n${line}` : line;
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

function normalizeWorkbenchCommand(inputCommand: string): string {
  const command = inputCommand.trim();
  if (!command) {
    throw new ValidationError({ message: "Workbench command is required." });
  }
  if (command.length > 128) {
    throw new ValidationError({ message: "Workbench command is too long." });
  }
  if (/[\0\r\n]/.test(command)) {
    throw new ValidationError({ message: "Workbench command contains invalid control characters." });
  }
  if (command.includes("/") || command.includes("\\") || command === "." || command === "..") {
    throw new ValidationError({ message: "Workbench command must be an executable name, not a path." });
  }
  return command;
}

function normalizeWorkbenchCommandArgs(inputArgs: string[]): string[] {
  if (inputArgs.length > MAX_COMMAND_ARGS) {
    throw new ValidationError({ message: `Workbench command cannot exceed ${MAX_COMMAND_ARGS} arguments.` });
  }
  return inputArgs.map((arg) => {
    if (typeof arg !== "string") {
      throw new ValidationError({ message: "Workbench command arguments must be strings." });
    }
    if (arg.includes("\0")) {
      throw new ValidationError({ message: "Workbench command argument contains an invalid null byte." });
    }
    if (Buffer.byteLength(arg, "utf8") > MAX_COMMAND_ARG_BYTES) {
      throw new ValidationError({
        message: `Workbench command arguments cannot exceed ${MAX_COMMAND_ARG_BYTES} bytes.`,
      });
    }
    return arg;
  });
}

function assertWorkbenchCommandAllowed(command: string, args: string[]): void {
  const commandName = normalizeExecutableName(command);
  if (PACKAGE_MANAGER_COMMANDS.has(commandName)) {
    const scriptName = extractPackageManagerScript(commandName, args);
    if (scriptName && VALIDATION_SCRIPT_PATTERN.test(scriptName)) {
      return;
    }
  }
  if (commandName === "git" && isAllowedGitValidationCommand(args)) {
    return;
  }
  throw new ValidationError({
    message:
      "Workbench command rejected. Only validation package scripts such as test, typecheck, lint, build, check, verify, coverage, and git diff --check are allowed.",
  });
}

function normalizeExecutableName(command: string): string {
  return command.toLowerCase().replace(/\.(cmd|exe)$/, "");
}

function extractPackageManagerScript(commandName: string, args: string[]): string | undefined {
  const commandArgs = stripPackageManagerFlags(args);
  if (commandArgs.length === 0) {
    return undefined;
  }
  if (commandName === "npm") {
    return commandArgs[0] === "run" || commandArgs[0] === "run-script" ? commandArgs[1] : undefined;
  }
  if (commandName === "bun") {
    return commandArgs[0] === "run" ? commandArgs[1] : undefined;
  }
  if (commandArgs[0] === "run") {
    return commandArgs[1];
  }
  return commandArgs[0]?.startsWith("-") ? undefined : commandArgs[0];
}

function stripPackageManagerFlags(args: string[]): string[] {
  let index = 0;
  while (args[index] === "--silent" || args[index] === "--if-present") {
    index += 1;
  }
  return args.slice(index);
}

function isAllowedGitValidationCommand(args: string[]): boolean {
  return args.length === 2 && args[0] === "diff" && args[1] === "--check";
}

function normalizeWorkbenchCommandTimeout(inputTimeoutMs?: number): number {
  if (inputTimeoutMs === undefined) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  if (!Number.isFinite(inputTimeoutMs) || inputTimeoutMs <= 0) {
    throw new ValidationError({ message: "Workbench command timeout must be a positive number." });
  }
  return Math.min(Math.floor(inputTimeoutMs), MAX_COMMAND_TIMEOUT_MS);
}

function normalizeWorkbenchPatch(inputPatch: string): string {
  if (typeof inputPatch !== "string" || !inputPatch.trim()) {
    throw new ValidationError({ message: "Patch content is required." });
  }
  if (inputPatch.includes("\0")) {
    throw new ValidationError({ message: "Patch content contains an invalid null byte." });
  }
  if (Buffer.byteLength(inputPatch, "utf8") > 4 * 1024 * 1024) {
    throw new ValidationError({ message: "Patch content exceeds the 4 MB workbench limit." });
  }
  return inputPatch;
}

function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const [, rawLeft, rawRight] = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/.exec(line) ?? [];
      addPatchPath(paths, rawLeft);
      addPatchPath(paths, rawRight);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      if (raw !== "/dev/null") {
        addPatchPath(paths, raw.replace(/^[ab]\//, ""));
      }
    }
  }
  if (paths.size === 0) {
    throw new ValidationError({ message: "Patch does not contain any file paths." });
  }
  return [...paths];
}

function addPatchPath(paths: Set<string>, rawPath?: string): void {
  if (!rawPath) {
    return;
  }
  const cleaned = rawPath.trim().replaceAll("\\", "/");
  if (!cleaned || cleaned === "/dev/null") {
    return;
  }
  paths.add(cleaned);
}

function assertPatchPathsInWorkbenchScope(
  context: { projectRoot: string; repoScopePath: string },
  patchPaths: string[],
): void {
  const normalizedScope = context.repoScopePath.replaceAll("\\", "/").replace(/\/$/, "");
  const usesRepoScopedPaths =
    normalizedScope !== "." &&
    patchPaths.some((patchPath) => patchPath === normalizedScope || patchPath.startsWith(`${normalizedScope}/`));
  for (const patchPath of patchPaths) {
    const normalized = normalizeWorkbenchRelativePath(patchPath);
    if (
      usesRepoScopedPaths &&
      normalizedScope !== "." &&
      normalized !== normalizedScope &&
      !normalized.startsWith(`${normalizedScope}/`)
    ) {
      throw new ValidationError({
        message: `Patch mixes project-relative and repository-relative paths outside ${normalizedScope}.`,
      });
    }
    const projectRelativePath =
      normalizedScope === "."
        ? normalized
        : normalized === normalizedScope
          ? "."
          : normalized.startsWith(`${normalizedScope}/`)
            ? normalized.slice(normalizedScope.length + 1)
            : normalized;
    const targetPath = path.resolve(context.projectRoot, projectRelativePath);
    assertPathInsideRoot(targetPath, context.projectRoot, "workbench patch file");
  }
}

function toRepoScopedFilePath(repoScopePath: string, relativePath: string): string {
  const normalizedScope = repoScopePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const normalizedRelativePath = normalizeWorkbenchRelativePath(relativePath);
  return path.posix.join(normalizedScope, normalizedRelativePath);
}

function fromRepoScopedFilePath(repoScopePath: string, repoScopedPath: string): string {
  const normalizedScope = repoScopePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const normalizedPath = repoScopedPath.replaceAll("\\", "/");
  if (normalizedScope === "." || !normalizedScope) {
    return normalizeWorkbenchRelativePath(normalizedPath);
  }
  if (!normalizedPath.startsWith(`${normalizedScope}/`)) {
    throw new ValidationError({ message: `Git path is outside the workbench project scope: ${repoScopedPath}` });
  }
  return normalizeWorkbenchRelativePath(normalizedPath.slice(normalizedScope.length + 1));
}

function assertWorkbenchMutationScope(
  deps: ChatWorkbenchDependencies,
  context: { projectRoot: string; worktreePath: string },
): void {
  assertExistingPathRealpathAllowed(
    context.projectRoot,
    deps.config.toolPolicy.sandbox.writeJailRoots,
    deps.config.toolPolicy.sandbox.readOnlyRoots,
  );
  assertWritePathInJail(context.projectRoot, deps.config.toolPolicy.sandbox.writeJailRoots);
  assertWritePathInJail(context.worktreePath, deps.config.toolPolicy.sandbox.writeJailRoots);
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
