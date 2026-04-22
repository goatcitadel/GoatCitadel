import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChatProjectRecord, RealtimeEvent } from "@goatcitadel/contracts";
import { ValidationError, type ChatProjectImportResult } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";

const execFileAsync = promisify(execFile);

export interface ChatProjectServiceContext {
  readonly storage: Pick<Storage, "chatProjects">;
  readonly config: GatewayRuntimeConfig;
  normalizeWorkspaceId(workspaceId?: string): string | undefined;
  publishRealtime(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
}

/**
 * Encapsulates chat-project CRUD behind the narrow storage/workspace/realtime
 * dependencies it actually needs.
 */
export class ChatProjectService {
  constructor(private readonly ctx: ChatProjectServiceContext) {}

  listChatProjects(
    view: "active" | "archived" | "all" = "active",
    limit = 300,
    workspaceId?: string,
  ): ChatProjectRecord[] {
    return this.ctx.storage.chatProjects.list(view, limit, this.ctx.normalizeWorkspaceId(workspaceId));
  }

  createChatProject(input: {
    workspaceId?: string;
    name: string;
    description?: string;
    workspacePath: string;
    color?: string;
  }): ChatProjectRecord {
    const created = this.ctx.storage.chatProjects.create({
      ...input,
      workspaceId: this.ctx.normalizeWorkspaceId(input.workspaceId),
    });
    this.ctx.publishRealtime("system", "chat", {
      type: "chat_project_created",
      projectId: created.projectId,
      name: created.name,
      workspaceId: created.workspaceId,
    });
    return created;
  }

  async importChatProject(input: {
    workspaceId?: string;
    name?: string;
    sourceType: "local_folder" | "github_repo";
    sourcePath?: string;
    repoUrl?: string;
    ref?: string;
  }): Promise<ChatProjectImportResult> {
    const workspaceRoot = path.resolve(this.ctx.config.rootDir, this.ctx.config.assistant.workspaceDir);
    await fsPromises.mkdir(workspaceRoot, { recursive: true });

    const sourceType = input.sourceType;
    const workspaceId = this.ctx.normalizeWorkspaceId(input.workspaceId);
    const desiredName =
      input.name?.trim() ||
      (sourceType === "github_repo" ? deriveRepoName(input.repoUrl) : deriveFolderName(input.sourcePath)) ||
      "Imported project";

    let materializedAbsolutePath: string;
    let imported = true;

    if (sourceType === "local_folder") {
      const sourcePath = input.sourcePath?.trim();
      if (!sourcePath) {
        throw new ValidationError({ code: "FIELD_REQUIRED", field: "sourcePath" });
      }
      materializedAbsolutePath = await materializeLocalFolder({
        workspaceRoot,
        sourcePath,
        desiredName,
      });
      imported = path.resolve(sourcePath) !== materializedAbsolutePath;
    } else {
      const repoUrl = input.repoUrl?.trim();
      if (!repoUrl) {
        throw new ValidationError({ code: "FIELD_REQUIRED", field: "repoUrl" });
      }
      materializedAbsolutePath = await materializeGithubRepo({
        workspaceRoot,
        repoUrl,
        ref: input.ref?.trim() || undefined,
        desiredName,
      });
    }

    const relativeWorkspacePath = normalizeWorkspaceRelativePath(workspaceRoot, materializedAbsolutePath);
    const existing = this.ctx.storage.chatProjects
      .list("all", 1000, workspaceId)
      .find((project) => project.workspacePath === relativeWorkspacePath);

    const project = existing
      ? this.ctx.storage.chatProjects.update(existing.projectId, {
          workspaceId,
          name: existing.name === existing.workspacePath ? desiredName : existing.name || desiredName,
          workspacePath: relativeWorkspacePath,
        })
      : this.ctx.storage.chatProjects.create({
          workspaceId,
          name: desiredName,
          workspacePath: relativeWorkspacePath,
          description:
            sourceType === "github_repo"
              ? `Imported from ${input.repoUrl?.trim()}`
              : `Imported from ${input.sourcePath?.trim()}`,
        });

    this.ctx.publishRealtime("system", "chat", {
      type: "chat_project_imported",
      projectId: project.projectId,
      name: project.name,
      workspaceId: project.workspaceId,
      workspacePath: project.workspacePath,
      sourceType,
    });

    return {
      project,
      sourceType,
      materializedPath: project.workspacePath,
      repoReady: fs.existsSync(path.join(materializedAbsolutePath, ".git")),
      imported,
    };
  }

  updateChatProject(
    projectId: string,
    input: {
      workspaceId?: string;
      name?: string;
      description?: string;
      workspacePath?: string;
      color?: string;
    },
  ): ChatProjectRecord {
    const updated = this.ctx.storage.chatProjects.update(projectId, {
      ...input,
      workspaceId: input.workspaceId ? this.ctx.normalizeWorkspaceId(input.workspaceId) : undefined,
    });
    this.ctx.publishRealtime("system", "chat", {
      type: "chat_project_updated",
      projectId: updated.projectId,
      name: updated.name,
      workspaceId: updated.workspaceId,
    });
    return updated;
  }

  archiveChatProject(projectId: string): ChatProjectRecord {
    const archived = this.ctx.storage.chatProjects.archive(projectId);
    this.ctx.publishRealtime("system", "chat", {
      type: "chat_project_archived",
      projectId: archived.projectId,
    });
    return archived;
  }

  restoreChatProject(projectId: string): ChatProjectRecord {
    const restored = this.ctx.storage.chatProjects.restore(projectId);
    this.ctx.publishRealtime("system", "chat", {
      type: "chat_project_restored",
      projectId: restored.projectId,
    });
    return restored;
  }

  hardDeleteChatProject(projectId: string): boolean {
    const deleted = this.ctx.storage.chatProjects.hardDelete(projectId);
    if (deleted) {
      this.ctx.publishRealtime("system", "chat", {
        type: "chat_project_deleted",
        projectId,
      });
    }
    return deleted;
  }
}

async function materializeLocalFolder(input: {
  workspaceRoot: string;
  sourcePath: string;
  desiredName: string;
}): Promise<string> {
  const absoluteSourcePath = path.resolve(input.sourcePath);
  const stat = await fsPromises.stat(absoluteSourcePath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new ValidationError({ message: `Local folder does not exist: ${input.sourcePath}` });
  }

  const sourceInsideWorkspace = isPathInsideRoot(input.workspaceRoot, absoluteSourcePath);
  const targetPath = sourceInsideWorkspace
    ? absoluteSourcePath
    : await allocateImportTarget(input.workspaceRoot, input.desiredName, "local");

  if (!sourceInsideWorkspace) {
    if (isGitRepo(absoluteSourcePath)) {
      await cloneRepoToTarget(absoluteSourcePath, targetPath);
    } else {
      await fsPromises.cp(absoluteSourcePath, targetPath, { recursive: true });
    }
  }

  if (!isGitRepo(targetPath)) {
    await initializeImportedRepo(targetPath, `Initial import of ${path.basename(absoluteSourcePath)}`);
  }

  return targetPath;
}

async function materializeGithubRepo(input: {
  workspaceRoot: string;
  repoUrl: string;
  ref?: string;
  desiredName: string;
}): Promise<string> {
  const targetPath = await allocateImportTarget(input.workspaceRoot, input.desiredName, "github");
  const args = ["clone", "--depth", "1"];
  if (input.ref) {
    args.push("--branch", input.ref);
  }
  args.push(input.repoUrl, targetPath);
  await execFileAsync("git", args, {
    cwd: input.workspaceRoot,
    windowsHide: true,
  });
  return targetPath;
}

async function cloneRepoToTarget(sourcePath: string, targetPath: string): Promise<void> {
  await execFileAsync("git", ["clone", "--no-local", sourcePath, targetPath], {
    cwd: path.dirname(targetPath),
    windowsHide: true,
  });
}

async function initializeImportedRepo(targetPath: string, message: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: targetPath, windowsHide: true });
  await execFileAsync("git", ["add", "-A"], { cwd: targetPath, windowsHide: true });
  await execFileAsync(
    "git",
    ["-c", "user.name=GoatCitadel", "-c", "user.email=goatcitadel@local", "commit", "--allow-empty", "-m", message],
    { cwd: targetPath, windowsHide: true },
  );
}

async function allocateImportTarget(workspaceRoot: string, desiredName: string, prefix: string): Promise<string> {
  const importsRoot = path.join(workspaceRoot, "imports");
  await fsPromises.mkdir(importsRoot, { recursive: true });
  const baseSlug = slugify(desiredName) || `${prefix}-repo`;
  for (let index = 0; index < 200; index += 1) {
    const candidate = path.join(importsRoot, index === 0 ? baseSlug : `${baseSlug}-${index + 1}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new ValidationError({ message: `Unable to allocate an import target for ${desiredName}.` });
}

function normalizeWorkspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
  if (!relative || relative === "." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new ValidationError({ message: "Imported project must live inside the configured workspace directory." });
  }
  return relative;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || relative === "." || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isGitRepo(targetPath: string): boolean {
  return fs.existsSync(path.join(targetPath, ".git"));
}

function deriveRepoName(repoUrl?: string): string | undefined {
  const trimmed = repoUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  const fileName = trimmed.split("/").at(-1)?.replace(/\.git$/i, "")?.trim();
  return fileName || undefined;
}

function deriveFolderName(folderPath?: string): string | undefined {
  const trimmed = folderPath?.trim();
  if (!trimmed) {
    return undefined;
  }
  const baseName = path.basename(trimmed);
  return baseName?.trim() || undefined;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
