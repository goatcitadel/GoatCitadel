import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerChatProjectRoutes } from "./chat.projects.js";

describe("chat project routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("lists, creates, updates, archives, restores, and hard-deletes chat projects", async () => {
    const services = {
      listChatProjects: vi.fn(() => [{ projectId: "project-1" }]),
      createChatProject: vi.fn(() => ({ projectId: "project-2", name: "New project" })),
      updateChatProject: vi.fn(() => ({ projectId: "project-2", name: "Renamed" })),
      archiveChatProject: vi.fn(() => ({ projectId: "project-2", lifecycleStatus: "archived" })),
      restoreChatProject: vi.fn(() => ({ projectId: "project-2", lifecycleStatus: "active" })),
      hardDeleteChatProject: vi.fn(() => true),
    };
    app = buildApp(services);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/chat/projects?workspaceId=workspace-1&view=all&limit=2",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ items: [{ projectId: "project-1" }], view: "all" });
    expect(services.listChatProjects).toHaveBeenCalledWith("all", 2, "workspace-1");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/chat/projects",
      payload: {
        workspaceId: "workspace-1",
        name: "New project",
        description: "Demo",
        workspacePath: "projects/new",
        color: "#00ffaa",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(services.createChatProject).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      name: "New project",
      description: "Demo",
      workspacePath: "projects/new",
      color: "#00ffaa",
    });

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/chat/projects/project-2",
      payload: { name: "Renamed", color: "#112233" },
    });
    expect(updated.statusCode).toBe(200);
    expect(services.updateChatProject).toHaveBeenCalledWith("project-2", {
      name: "Renamed",
      color: "#112233",
    });

    await expect(app.inject({ method: "POST", url: "/api/v1/chat/projects/project-2/archive" })).resolves.toMatchObject(
      {
        statusCode: 200,
      },
    );
    await expect(app.inject({ method: "POST", url: "/api/v1/chat/projects/project-2/restore" })).resolves.toMatchObject(
      {
        statusCode: 200,
      },
    );
    const deleted = await app.inject({ method: "DELETE", url: "/api/v1/chat/projects/project-2" });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true, projectId: "project-2", mode: "hard" });
  });

  it("validates import modes and maps service errors to 400 without changing the contract", async () => {
    const importChatProject = vi
      .fn()
      .mockResolvedValueOnce({ projectId: "import-local", sourceType: "local_folder" })
      .mockRejectedValueOnce(new Error("clone failed"));
    app = buildApp({ importChatProject });

    const missingSourcePath = await app.inject({
      method: "POST",
      url: "/api/v1/chat/projects/import",
      payload: { sourceType: "local_folder" },
    });
    expect(missingSourcePath.statusCode).toBe(400);
    expect(missingSourcePath.body).toContain("sourcePath is required");

    const missingRepoUrl = await app.inject({
      method: "POST",
      url: "/api/v1/chat/projects/import",
      payload: { sourceType: "github_repo" },
    });
    expect(missingRepoUrl.statusCode).toBe(400);
    expect(missingRepoUrl.body).toContain("repoUrl is required");

    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/chat/projects/import",
      payload: {
        workspaceId: "workspace-1",
        name: "Local import",
        sourceType: "local_folder",
        sourcePath: "F:/code/example",
      },
    });
    expect(imported.statusCode).toBe(201);
    expect(importChatProject).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      name: "Local import",
      sourceType: "local_folder",
      sourcePath: "F:/code/example",
    });

    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/chat/projects/import",
      payload: {
        sourceType: "github_repo",
        repoUrl: "https://github.com/example/repo.git",
      },
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toEqual({ error: "clone failed" });
  });

  it("returns validation and service errors for project mutations", async () => {
    app = buildApp({
      createChatProject: vi.fn(() => {
        throw new Error("workspace path already exists");
      }),
      updateChatProject: vi.fn(() => {
        throw new Error("project missing");
      }),
      archiveChatProject: vi.fn(() => {
        throw new Error("archive failed");
      }),
      restoreChatProject: vi.fn(() => {
        throw new Error("restore failed");
      }),
      hardDeleteChatProject: vi.fn(),
    });

    await expect(app.inject({ method: "GET", url: "/api/v1/chat/projects?limit=0" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/chat/projects", payload: { name: "", workspacePath: "" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/chat/projects",
        payload: { name: "Existing", workspacePath: "projects/existing" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "PATCH", url: "/api/v1/chat/projects/project-1", payload: { name: "" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "PATCH", url: "/api/v1/chat/projects/project-1", payload: { name: "New" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "POST", url: "/api/v1/chat/projects/project-1/archive" })).resolves.toMatchObject(
      {
        statusCode: 400,
      },
    );
    await expect(app.inject({ method: "POST", url: "/api/v1/chat/projects/project-1/restore" })).resolves.toMatchObject(
      {
        statusCode: 400,
      },
    );
    const softDelete = await app.inject({ method: "DELETE", url: "/api/v1/chat/projects/project-1?mode=soft" });
    expect(softDelete.statusCode).toBe(400);
    expect(softDelete.json()).toEqual({ error: "Only hard delete is supported for chat projects." });
  });
});

function buildApp(chatProjects: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { chatProjects } as never);
  registerChatProjectRoutes(next);
  return next;
}
