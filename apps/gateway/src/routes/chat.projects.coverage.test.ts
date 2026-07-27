import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
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
      updateChatProject: vi.fn(() => ({ projectId: "project-2", revision: 4, name: "Renamed" })),
      archiveChatProject: vi.fn(() => ({ projectId: "project-2", revision: 5, lifecycleStatus: "archived" })),
      restoreChatProject: vi.fn(() => ({ projectId: "project-2", revision: 6, lifecycleStatus: "active" })),
      hardDeleteChatProject: vi.fn(() => true),
    };
    app = buildApp(services);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/chat/projects?workspaceId=workspace-1&view=all&limit=2",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ items: [{ projectId: "project-1" }], view: "all" });
    expect(services.listChatProjects).toHaveBeenCalledWith("all", 2, "workspace-1", undefined);

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

    await app.inject({
      method: "GET",
      url: "/api/v1/chat/projects?citadelId=company&workspaceId=engineering&view=active&limit=5",
    });
    expect(services.listChatProjects).toHaveBeenLastCalledWith("active", 5, "engineering", "company");

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/chat/projects/project-2",
      payload: { expectedRevision: 3, name: "Renamed", color: "#112233" },
    });
    expect(updated.statusCode).toBe(200);
    expect(services.updateChatProject).toHaveBeenCalledWith(
      "project-2",
      {
        name: "Renamed",
        color: "#112233",
      },
      3,
    );

    await expect(
      app.inject({ method: "POST", url: "/api/v1/chat/projects/project-2/archive", payload: { expectedRevision: 4 } }),
    ).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/chat/projects/project-2/restore", payload: { expectedRevision: 5 } }),
    ).resolves.toMatchObject({
      statusCode: 200,
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/chat/projects/project-2?mode=hard&expectedRevision=6",
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true, projectId: "project-2", mode: "hard" });
  });

  it("validates import modes and does not expose untyped service failures", async () => {
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
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "Internal server error" });
  });

  it("returns a structured client error when project scope ownership is invalid", async () => {
    app = buildApp({
      listChatProjects: vi.fn(() => {
        throw new ValidationError({
          field: "workspaceId",
          message: "workspace default belongs to citadel personal, not company",
        });
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat/projects?citadelId=company&workspaceId=default",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "workspace default belongs to citadel personal, not company",
      code: "FIELD_INVALID",
      details: { field: "workspaceId" },
    });
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
      app.inject({
        method: "PATCH",
        url: "/api/v1/chat/projects/project-1",
        payload: { expectedRevision: 1, name: "New" },
      }),
    ).resolves.toMatchObject({ statusCode: 500 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/chat/projects/project-1/archive", payload: { expectedRevision: 1 } }),
    ).resolves.toMatchObject({
      statusCode: 500,
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/chat/projects/project-1/restore", payload: { expectedRevision: 1 } }),
    ).resolves.toMatchObject({
      statusCode: 500,
    });
    const softDelete = await app.inject({
      method: "DELETE",
      url: "/api/v1/chat/projects/project-1?mode=soft&expectedRevision=1",
    });
    expect(softDelete.statusCode).toBe(400);
    expect(softDelete.json()).toEqual({ error: "Only hard delete is supported for chat projects." });
    await expect(
      app.inject({ method: "DELETE", url: "/api/v1/chat/projects/project-1?expectedRevision=1" }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "DELETE", url: "/api/v1/chat/projects/project-1?mode=hard" }),
    ).resolves.toMatchObject({ statusCode: 400 });
  });

  it("returns structured 409 details for stale project mutations", async () => {
    const conflict = new ConflictError({
      code: "WRITE_CONFLICT",
      message: "chat project changed",
      details: {
        resourceKind: "chat_project",
        resourceId: "project-1",
        expectedRevision: 5,
        currentRevision: 6,
      },
    });
    const fail = vi.fn(() => {
      throw conflict;
    });
    app = buildApp({
      importChatProject: fail,
      updateChatProject: fail,
      archiveChatProject: fail,
      restoreChatProject: fail,
      hardDeleteChatProject: fail,
    });

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/chat/projects/import",
        payload: { sourceType: "local_folder", sourcePath: "F:/code/example" },
      }),
      app.inject({
        method: "PATCH",
        url: "/api/v1/chat/projects/project-1",
        payload: { expectedRevision: 5, name: "Draft" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/chat/projects/project-1/archive",
        payload: { expectedRevision: 5 },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/chat/projects/project-1/restore",
        payload: { expectedRevision: 5 },
      }),
      app.inject({
        method: "DELETE",
        url: "/api/v1/chat/projects/project-1?mode=hard&expectedRevision=5",
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "WRITE_CONFLICT",
        details: {
          resourceKind: "chat_project",
          resourceId: "project-1",
          expectedRevision: 5,
          currentRevision: 6,
        },
      });
    }
  });
});

function buildApp(chatProjects: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { chatProjects } as never);
  registerChatProjectRoutes(next);
  return next;
}
