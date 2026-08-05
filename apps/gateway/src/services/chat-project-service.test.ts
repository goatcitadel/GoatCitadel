import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError, type ChatProjectRecord } from "@goatcitadel/contracts";
import { ChatProjectService, type ChatProjectServiceContext } from "./chat-project-service.js";

const execFileMock = vi.hoisted(() => vi.fn());
let tempRoot: string;
let published: Array<{ channel: string; topic: string; payload: Record<string, unknown> }>;

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("ChatProjectService", () => {
  beforeEach(async () => {
    execFileMock.mockImplementation((command: string, args: string[], options: unknown, callback: unknown) => {
      const cb = callback as (error: Error | null, result: { stdout: string; stderr: string }) => void;
      cb(null, { stdout: `${command} ${args.join(" ")}`, stderr: "" });
    });
    tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "goatcitadel-chat-project-service-"));
    published = [];
  });

  afterEach(async () => {
    execFileMock.mockReset();
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  });

  it("wraps project CRUD with normalized workspace ids and realtime events", async () => {
    const { service, storage } = createService();

    await expect(service.listChatProjects("active", 5, " ws-a ")).resolves.toEqual([]);

    const created = await service.createChatProject({
      workspaceId: " ws-a ",
      name: "Control Plane",
      workspacePath: "apps/gateway",
      color: "teal",
    });
    expect(created).toMatchObject({
      projectId: "project-1",
      workspaceId: "ws-a",
      name: "Control Plane",
    });
    expect(published.at(-1)?.payload).toMatchObject({
      type: "chat_project_created",
      projectId: "project-1",
      workspaceId: "ws-a",
    });

    const updated = await service.updateChatProject(
      "project-1",
      {
        workspaceId: " ws-b ",
        name: "Gateway",
      },
      1,
    );
    expect(updated).toMatchObject({ projectId: "project-1", workspaceId: "ws-b", name: "Gateway" });

    expect((await service.archiveChatProject("project-1", 2)).archivedAt).toBeTruthy();
    expect((await service.restoreChatProject("project-1", 3)).archivedAt).toBeUndefined();
    await expect(service.hardDeleteChatProject("project-1", 4)).resolves.toBe(true);
    expect(storage.chatProjects.hardDeleteWithRevision).toHaveBeenCalledWith("project-1", 4);
    expect(published.map((event) => event.payload.type)).toEqual([
      "chat_project_created",
      "chat_project_updated",
      "chat_project_archived",
      "chat_project_restored",
      "chat_project_deleted",
    ]);
  });

  it("imports an existing workspace folder in place and initializes git when needed", async () => {
    const workspaceRoot = path.join(tempRoot, "workspace");
    const sourcePath = path.join(workspaceRoot, "Manual Project");
    await fsPromises.mkdir(sourcePath, { recursive: true });
    await fsPromises.writeFile(path.join(sourcePath, "README.md"), "hello");
    const sourceRealPath = await fsPromises.realpath(sourcePath);
    const { service } = createService({ workspaceDir: "workspace", readOnlyRoots: [tempRoot] });

    const result = await service.importChatProject({
      workspaceId: " ws-a ",
      sourceType: "local_folder",
      sourcePath,
    });

    expect(result).toMatchObject({
      sourceType: "local_folder",
      materializedPath: "Manual Project",
      imported: false,
      repoReady: false,
    });
    expect(result.project).toMatchObject({
      name: "Manual Project",
      workspaceId: "ws-a",
      workspacePath: "Manual Project",
    });
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["init", "-b", "main"],
      expect.objectContaining({ cwd: sourceRealPath }),
      expect.any(Function),
    );
    expect(published.at(-1)?.payload).toMatchObject({
      type: "chat_project_imported",
      sourceType: "local_folder",
      workspacePath: "Manual Project",
    });
  });

  it("copies an external local folder into a slugged import target", async () => {
    const sourcePath = path.join(tempRoot, "external source");
    await fsPromises.mkdir(sourcePath, { recursive: true });
    await fsPromises.writeFile(path.join(sourcePath, "file.txt"), "copied");
    const { service } = createService({ workspaceDir: "workspace", readOnlyRoots: [tempRoot] });

    const result = await service.importChatProject({
      workspaceId: "ws-a",
      name: "My Imported Project!",
      sourceType: "local_folder",
      sourcePath,
    });

    expect(result).toMatchObject({
      imported: true,
      materializedPath: "imports/my-imported-project",
    });
    await expect(
      fsPromises.readFile(path.join(tempRoot, "workspace", result.materializedPath, "file.txt"), "utf8"),
    ).resolves.toBe("copied");
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      [
        "-c",
        "user.name=GoatCitadel",
        "-c",
        "user.email=goatcitadel@local",
        "commit",
        "--allow-empty",
        "-m",
        "Initial import of external source",
      ],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("clones local git folders and github repos with collision-safe targets", async () => {
    const sourcePath = path.join(tempRoot, "source.git");
    await fsPromises.mkdir(path.join(sourcePath, ".git"), { recursive: true });
    const sourceRealPath = await fsPromises.realpath(sourcePath);
    const workspaceRoot = path.join(tempRoot, "workspace");
    await fsPromises.mkdir(path.join(workspaceRoot, "imports", "shared-name"), { recursive: true });
    const workspaceRootRealPath = await fsPromises.realpath(workspaceRoot);
    const { service } = createService({ workspaceDir: "workspace", readOnlyRoots: [tempRoot] });

    const localResult = await service.importChatProject({
      sourceType: "local_folder",
      name: "Shared Name",
      sourcePath,
    });
    expect(localResult.materializedPath).toBe("imports/shared-name-2");
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["clone", "--no-local", sourceRealPath, path.join(workspaceRootRealPath, "imports", "shared-name-2")],
      expect.objectContaining({ cwd: path.join(workspaceRootRealPath, "imports") }),
      expect.any(Function),
    );

    const githubResult = await service.importChatProject({
      sourceType: "github_repo",
      repoUrl: "https://github.com/example/goat-demo.git",
      ref: "main",
    });
    expect(githubResult.project.description).toBe("Imported from https://github.com/example/goat-demo.git");
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        "main",
        "https://github.com/example/goat-demo.git",
        expect.stringContaining("goat-demo"),
      ],
      expect.objectContaining({ cwd: workspaceRootRealPath }),
      expect.any(Function),
    );
  });

  it("updates existing imported project records and validates missing or unsafe sources", async () => {
    const workspaceRoot = path.join(tempRoot, "workspace");
    const existingPath = path.join(workspaceRoot, "Existing");
    await fsPromises.mkdir(path.join(existingPath, ".git"), { recursive: true });
    const { service, projects } = createService({ workspaceDir: "workspace" });
    projects.push({
      projectId: "project-existing",
      revision: 1,
      workspaceId: "ws-a",
      name: "Existing",
      workspacePath: "Existing",
      createdAt: "2026-03-22T12:00:00.000Z",
      updatedAt: "2026-03-22T12:00:00.000Z",
    });

    await expect(service.importChatProject({ sourceType: "local_folder" })).rejects.toThrow(ValidationError);
    await expect(service.importChatProject({ sourceType: "github_repo" })).rejects.toThrow(ValidationError);
    await expect(
      service.importChatProject({
        sourceType: "local_folder",
        sourcePath: path.join(tempRoot, "missing"),
      }),
    ).rejects.toThrow("Local folder does not exist");
    const disallowedSource = path.join(tempRoot, "outside-read-root");
    await fsPromises.mkdir(disallowedSource, { recursive: true });
    await expect(
      service.importChatProject({
        sourceType: "local_folder",
        sourcePath: disallowedSource,
      }),
    ).rejects.toThrow("Path is outside read allowlist");

    const result = await service.importChatProject({
      workspaceId: "ws-a",
      name: "Fresh Name",
      sourceType: "local_folder",
      sourcePath: existingPath,
    });

    expect(result.project).toMatchObject({
      projectId: "project-existing",
      name: "Fresh Name",
      workspacePath: "Existing",
    });
  });
});

function createService(input: { workspaceDir?: string; readOnlyRoots?: string[] } = {}): {
  service: ChatProjectService;
  storage: ChatProjectServiceContext["storage"];
  projects: ChatProjectRecord[];
} {
  const projects: ChatProjectRecord[] = [];
  const now = "2026-03-22T12:00:00.000Z";
  const storage = {
    chatProjects: {
      list: vi.fn((_view: string, _limit: number, workspaceId?: string) =>
        projects.filter((project) => !workspaceId || project.workspaceId === workspaceId),
      ),
      create: vi.fn((input: Partial<ChatProjectRecord>) => {
        const project = {
          projectId: `project-${projects.length + 1}`,
          revision: 1,
          workspaceId: input.workspaceId,
          name: input.name ?? "Untitled",
          description: input.description,
          workspacePath: input.workspacePath ?? "workspace",
          color: input.color,
          createdAt: now,
          updatedAt: now,
        } as ChatProjectRecord;
        projects.push(project);
        return project;
      }),
      updateWithRevision: vi.fn((projectId: string, patch: Partial<ChatProjectRecord>, expectedRevision: number) => {
        const project = projects.find((item) => item.projectId === projectId);
        if (!project) {
          throw new Error(`missing ${projectId}`);
        }
        if (project.revision !== expectedRevision) {
          throw new Error(`stale ${projectId}`);
        }
        Object.assign(project, patch, { revision: project.revision + 1, updatedAt: now });
        return project;
      }),
      archiveWithRevision: vi.fn((projectId: string, expectedRevision: number) => {
        const project = projects.find((item) => item.projectId === projectId);
        if (!project) {
          throw new Error(`missing ${projectId}`);
        }
        if (project.revision !== expectedRevision) {
          throw new Error(`stale ${projectId}`);
        }
        project.archivedAt = now;
        project.lifecycleStatus = "archived";
        project.revision += 1;
        return project;
      }),
      restoreWithRevision: vi.fn((projectId: string, expectedRevision: number) => {
        const project = projects.find((item) => item.projectId === projectId);
        if (!project) {
          throw new Error(`missing ${projectId}`);
        }
        if (project.revision !== expectedRevision) {
          throw new Error(`stale ${projectId}`);
        }
        delete project.archivedAt;
        project.lifecycleStatus = "active";
        project.revision += 1;
        return project;
      }),
      hardDeleteWithRevision: vi.fn((projectId: string, expectedRevision: number) => {
        const index = projects.findIndex((item) => item.projectId === projectId);
        if (index === -1) {
          return false;
        }
        if (projects[index]?.revision !== expectedRevision) {
          throw new Error(`stale ${projectId}`);
        }
        projects.splice(index, 1);
        return true;
      }),
    },
  } satisfies ChatProjectServiceContext["storage"];

  return {
    service: new ChatProjectService({
      storage,
      config: {
        rootDir: tempRoot,
        assistant: { workspaceDir: input.workspaceDir ?? "workspace" },
        toolPolicy: {
          sandbox: {
            writeJailRoots: [path.join(tempRoot, input.workspaceDir ?? "workspace")],
            readOnlyRoots: input.readOnlyRoots ?? [],
          },
        },
      } as ChatProjectServiceContext["config"],
      normalizeWorkspaceId: (workspaceId?: string) => workspaceId?.trim() || "default-workspace",
      publishRealtime: async (channel, topic, payload) => {
        published.push({ channel, topic, payload });
      },
    }),
    storage,
    projects,
  };
}
