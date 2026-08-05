import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChatProjectRecord, RealtimeEvent } from "@goatcitadel/contracts";
import { ValidationError, type ChatProjectImportResult } from "@goatcitadel/contracts";
import { assertExistingPathRealpathAllowed } from "@goatcitadel/policy-engine";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
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
  ): Promise<unknown>;
}

/**
 * Encapsulates chat-project CRUD behind the narrow storage/workspace/realtime
 * dependencies it actually needs.
 */
export class ChatProjectService {
  constructor(private readonly ctx: ChatProjectServiceContext) {}

  async listChatProjects(
    view: "active" | "archived" | "all" = "active",
    limit = 300,
    workspaceId?: string,
  ): Promise<ChatProjectRecord[]> {
    return await this.ctx.storage.chatProjects.list(view, limit, this.ctx.normalizeWorkspaceId(workspaceId));
  }

  async createChatProject(input: {
    workspaceId?: string;
    name: string;
    description?: string;
    workspacePath: string;
    color?: string;
  }): Promise<ChatProjectRecord> {
    const created = await this.ctx.storage.chatProjects.create({
      ...input,
      workspaceId: this.ctx.normalizeWorkspaceId(input.workspaceId),
    });
    await this.ctx.publishRealtime("system", "chat", {
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
    const configuredWorkspaceRoot = path.resolve(this.ctx.config.rootDir, this.ctx.config.assistant.workspaceDir);
    await fsPromises.mkdir(configuredWorkspaceRoot, { recursive: true });
    const workspaceRoot = await fsPromises.realpath(configuredWorkspaceRoot);

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
        writeJailRoots: this.ctx.config.toolPolicy.sandbox.writeJailRoots,
        readOnlyRoots: this.ctx.config.toolPolicy.sandbox.readOnlyRoots,
      });
      imported = (await fsPromises.realpath(path.resolve(sourcePath))) !== materializedAbsolutePath;
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
    const existing = (await this.ctx.storage.chatProjects.list("all", 1000, workspaceId)).find(
      (project) => project.workspacePath === relativeWorkspacePath,
    );

    const project = existing
      ? await this.ctx.storage.chatProjects.updateWithRevision(
          existing.projectId,
          {
            workspaceId,
            name: existing.name === existing.workspacePath ? desiredName : existing.name || desiredName,
            workspacePath: relativeWorkspacePath,
          },
          existing.revision,
        )
      : await this.ctx.storage.chatProjects.create({
          workspaceId,
          name: desiredName,
          workspacePath: relativeWorkspacePath,
          description:
            sourceType === "github_repo"
              ? `Imported from ${input.repoUrl?.trim()}`
              : `Imported from ${input.sourcePath?.trim()}`,
        });

    await this.ctx.publishRealtime("system", "chat", {
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

  async updateChatProject(
    projectId: string,
    input: {
      workspaceId?: string;
      name?: string;
      description?: string;
      workspacePath?: string;
      color?: string;
    },
    expectedRevision: number,
  ): Promise<ChatProjectRecord> {
    const updated = await this.ctx.storage.chatProjects.updateWithRevision(
      projectId,
      {
        ...input,
        workspaceId: input.workspaceId ? this.ctx.normalizeWorkspaceId(input.workspaceId) : undefined,
      },
      expectedRevision,
    );
    await this.ctx.publishRealtime("system", "chat", {
      type: "chat_project_updated",
      projectId: updated.projectId,
      name: updated.name,
      workspaceId: updated.workspaceId,
    });
    return updated;
  }

  async archiveChatProject(projectId: string, expectedRevision: number): Promise<ChatProjectRecord> {
    const archived = await this.ctx.storage.chatProjects.archiveWithRevision(projectId, expectedRevision);
    await this.ctx.publishRealtime("system", "chat", {
      type: "chat_project_archived",
      projectId: archived.projectId,
    });
    return archived;
  }

  async restoreChatProject(projectId: string, expectedRevision: number): Promise<ChatProjectRecord> {
    const restored = await this.ctx.storage.chatProjects.restoreWithRevision(projectId, expectedRevision);
    await this.ctx.publishRealtime("system", "chat", {
      type: "chat_project_restored",
      projectId: restored.projectId,
    });
    return restored;
  }

  async hardDeleteChatProject(projectId: string, expectedRevision: number): Promise<boolean> {
    const deleted = await this.ctx.storage.chatProjects.hardDeleteWithRevision(projectId, expectedRevision);
    if (deleted) {
      await this.ctx.publishRealtime("system", "chat", {
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
  writeJailRoots: string[];
  readOnlyRoots: string[];
}): Promise<string> {
  const absoluteSourcePath = path.resolve(input.sourcePath);
  const stat = await fsPromises.stat(absoluteSourcePath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new ValidationError({ message: `Local folder does not exist: ${input.sourcePath}` });
  }
  const [writeJailRoots, readOnlyRoots] = await Promise.all([
    realpathExistingRoots(input.writeJailRoots),
    realpathExistingRoots(input.readOnlyRoots),
  ]);
  assertExistingPathRealpathAllowed(absoluteSourcePath, writeJailRoots, readOnlyRoots);

  const sourceRealPath = await fsPromises.realpath(absoluteSourcePath);
  const sourceInsideWorkspace = isPathInsideRoot(input.workspaceRoot, sourceRealPath);
  const targetPath = sourceInsideWorkspace
    ? sourceRealPath
    : await allocateImportTarget(input.workspaceRoot, input.desiredName, "local");

  if (!sourceInsideWorkspace) {
    if (isGitRepo(sourceRealPath)) {
      await cloneRepoToTarget(sourceRealPath, targetPath);
    } else {
      await fsPromises.cp(sourceRealPath, targetPath, { recursive: true });
    }
  }

  if (!isGitRepo(targetPath)) {
    await initializeImportedRepo(targetPath, `Initial import of ${path.basename(sourceRealPath)}`);
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

async function realpathExistingRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    try {
      out.push(await fsPromises.realpath(root));
    } catch {
      out.push(path.resolve(root));
    }
  }
  return out;
}

function isGitRepo(targetPath: string): boolean {
  return fs.existsSync(path.join(targetPath, ".git"));
}

function deriveRepoName(repoUrl?: string): string | undefined {
  const trimmed = repoUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  const fileName = trimmed
    .split("/")
    .at(-1)
    ?.replace(/\.git$/i, "")
    ?.trim();
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
