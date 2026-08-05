import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError } from "@goatcitadel/contracts";
import { workspacesRoutes } from "./workspaces.js";

describe("workspace and guidance routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  function createWorkspaceService(overrides: Record<string, unknown> = {}) {
    return {
      listWorkspaces: vi.fn(async () => []),
      createWorkspace: vi.fn(async (input: Record<string, unknown>) => ({
        workspaceId: "workspace-created",
        revision: 1,
        lifecycleStatus: "active",
        ...input,
      })),
      getWorkspace: vi.fn(async (workspaceId: string) => ({
        workspaceId,
        revision: 1,
        name: "Default",
        slug: "default",
        lifecycleStatus: "active",
      })),
      updateWorkspace: vi.fn(async (workspaceId: string, input: Record<string, unknown>, expectedRevision: number) => ({
        workspaceId,
        revision: expectedRevision + 1,
        ...input,
      })),
      archiveWorkspace: vi.fn(async (workspaceId: string, expectedRevision: number) => ({
        workspaceId,
        revision: expectedRevision + 1,
        lifecycleStatus: "archived",
      })),
      restoreWorkspace: vi.fn(async (workspaceId: string, expectedRevision: number) => ({
        workspaceId,
        revision: expectedRevision + 1,
        lifecycleStatus: "active",
      })),
      listGlobalGuidance: vi.fn(async () => [{ docType: "goatcitadel", scope: "global" }]),
      updateGlobalGuidance: vi.fn(async (docType: string, content: string) => ({
        docType,
        scope: "global",
        content,
      })),
      listWorkspaceGuidance: vi.fn(async (workspaceId: string) => ({
        workspaceId,
        items: [{ docType: "agents", scope: "workspace" }],
      })),
      updateWorkspaceGuidance: vi.fn(async (workspaceId: string, docType: string, content: string) => ({
        workspaceId,
        docType,
        scope: "workspace",
        content,
      })),
      ...overrides,
    };
  }

  async function registerWorkspaceService(overrides: Record<string, unknown> = {}) {
    const service = createWorkspaceService(overrides);
    app = Fastify();
    app.decorate("services", { workspaces: service } as never);
    await app.register(workspacesRoutes);
    return service;
  }

  it("lists workspaces through gateway service with optional Citadel scope", async () => {
    const listWorkspaces = vi.fn(async () => [
      {
        workspaceId: "default",
        name: "Default",
        slug: "default",
        lifecycleStatus: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    app = Fastify();
    app.decorate("services", { workspaces: { listWorkspaces } } as never);
    await app.register(workspacesRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/workspaces?view=active&limit=25&citadelId=company",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: unknown[]; citadelId?: string };
    expect(body.items).toHaveLength(1);
    expect(body.citadelId).toBe("company");
    expect(listWorkspaces).toHaveBeenCalledWith("active", 25, "company");
  });

  it("rejects workspace security doc override endpoint by schema", async () => {
    app = Fastify();
    app.decorate("services", { workspaces: { updateWorkspaceGuidance: vi.fn() } } as never);
    await app.register(workspacesRoutes);

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/workspaces/default/guidance/security",
      payload: {
        content: "# workspace security override",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("allows global security doc updates", async () => {
    const updateGlobalGuidance = vi.fn(async () => ({
      docType: "security",
      scope: "global",
      fileName: "SECURITY.md",
      absolutePath: "F:/code/personal-ai/SECURITY.md",
      exists: true,
      content: "# Security Policy",
    }));
    app = Fastify();
    app.decorate("services", { workspaces: { updateGlobalGuidance } } as never);
    await app.register(workspacesRoutes);

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/guidance/global/security",
      payload: {
        content: "# Security Policy",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateGlobalGuidance).toHaveBeenCalledWith("security", "# Security Policy");
  });

  it("creates, reads, updates, archives, and restores workspaces", async () => {
    const service = await registerWorkspaceService();

    const createResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      payload: {
        citadelId: "company",
        name: "Research",
        slug: "research",
        description: "Research workspace",
        workspacePrefs: {
          density: "compact",
        },
      },
    });
    const getResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/workspaces/workspace-created",
    });
    const updateResponse = await app!.inject({
      method: "PATCH",
      url: "/api/v1/workspaces/workspace-created",
      payload: {
        expectedRevision: 3,
        name: "Research Lab",
      },
    });
    const archiveResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/workspaces/workspace-created/archive",
      payload: { expectedRevision: 4 },
    });
    const restoreResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/workspaces/workspace-created/restore",
      payload: { expectedRevision: 5 },
    });

    expect(createResponse.statusCode).toBe(201);
    expect(getResponse.statusCode).toBe(200);
    expect(updateResponse.statusCode).toBe(200);
    expect(archiveResponse.statusCode).toBe(200);
    expect(restoreResponse.statusCode).toBe(200);
    expect(createResponse.json()).toMatchObject({ workspaceId: "workspace-created", name: "Research" });
    expect(getResponse.json()).toMatchObject({ workspaceId: "workspace-created", name: "Default" });
    expect(updateResponse.json()).toMatchObject({ workspaceId: "workspace-created", name: "Research Lab" });
    expect(service.createWorkspace).toHaveBeenCalledWith({
      citadelId: "company",
      name: "Research",
      slug: "research",
      description: "Research workspace",
      workspacePrefs: {
        density: "compact",
      },
    });
    expect(service.getWorkspace).toHaveBeenCalledWith("workspace-created");
    expect(service.updateWorkspace).toHaveBeenCalledWith("workspace-created", { name: "Research Lab" }, 3);
    expect(service.archiveWorkspace).toHaveBeenCalledWith("workspace-created", 4);
    expect(service.restoreWorkspace).toHaveBeenCalledWith("workspace-created", 5);
    expect(archiveResponse.json()).toMatchObject({ lifecycleStatus: "archived" });
    expect(restoreResponse.json()).toMatchObject({ lifecycleStatus: "active" });
  });

  it("lists and updates global and workspace guidance documents", async () => {
    const service = await registerWorkspaceService();

    const globalListResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/guidance/global",
    });
    const globalUpdateResponse = await app!.inject({
      method: "PUT",
      url: "/api/v1/guidance/global/contributing",
      payload: {
        content: "# Contributing",
      },
    });
    const workspaceListResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/workspaces/default/guidance",
    });
    const workspaceUpdateResponse = await app!.inject({
      method: "PUT",
      url: "/api/v1/workspaces/default/guidance/agents",
      payload: {
        content: "# Workspace Agents",
      },
    });

    expect(globalListResponse.statusCode).toBe(200);
    expect(globalUpdateResponse.statusCode).toBe(200);
    expect(workspaceListResponse.statusCode).toBe(200);
    expect(workspaceUpdateResponse.statusCode).toBe(200);
    expect(service.listGlobalGuidance).toHaveBeenCalledWith();
    expect(service.updateGlobalGuidance).toHaveBeenCalledWith("contributing", "# Contributing");
    expect(service.listWorkspaceGuidance).toHaveBeenCalledWith("default");
    expect(service.updateWorkspaceGuidance).toHaveBeenCalledWith("default", "agents", "# Workspace Agents");
    expect(globalListResponse.json()).toEqual({
      items: [{ docType: "goatcitadel", scope: "global" }],
    });
    expect(workspaceListResponse.json()).toMatchObject({
      workspaceId: "default",
      items: [{ docType: "agents" }],
    });
  });

  it("maps workspace service failures to route error responses", async () => {
    await registerWorkspaceService({
      createWorkspace: vi.fn(async () => {
        throw new Error("duplicate slug");
      }),
      getWorkspace: vi.fn(async () => {
        throw new Error("missing workspace");
      }),
      updateWorkspace: vi.fn(async () => {
        throw new Error("invalid workspace");
      }),
      archiveWorkspace: vi.fn(async () => {
        throw new Error("archive blocked");
      }),
      restoreWorkspace: vi.fn(async () => {
        throw new Error("restore blocked");
      }),
      listWorkspaceGuidance: vi.fn(async () => {
        throw new Error("guidance missing");
      }),
      updateWorkspaceGuidance: vi.fn(async () => {
        throw new Error("guidance update blocked");
      }),
    });

    const createResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      payload: {
        name: "Research",
      },
    });
    const getResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/workspaces/missing",
    });
    const updateResponse = await app!.inject({
      method: "PATCH",
      url: "/api/v1/workspaces/missing",
      payload: {
        expectedRevision: 1,
        name: "Research",
      },
    });
    const archiveResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/workspaces/missing/archive",
      payload: { expectedRevision: 1 },
    });
    const restoreResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/workspaces/missing/restore",
      payload: { expectedRevision: 1 },
    });
    const workspaceGuidanceResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/workspaces/missing/guidance",
    });
    const workspaceGuidanceUpdateResponse = await app!.inject({
      method: "PUT",
      url: "/api/v1/workspaces/missing/guidance/agents",
      payload: {
        content: "# Agents",
      },
    });

    expect(createResponse.statusCode).toBe(400);
    expect(getResponse.statusCode).toBe(404);
    expect(updateResponse.statusCode).toBe(500);
    expect(archiveResponse.statusCode).toBe(500);
    expect(restoreResponse.statusCode).toBe(500);
    expect(workspaceGuidanceResponse.statusCode).toBe(400);
    expect(workspaceGuidanceUpdateResponse.statusCode).toBe(400);
    expect(createResponse.json()).toEqual({ error: "duplicate slug" });
    expect(getResponse.json()).toEqual({ error: "missing workspace" });
  });

  it("preserves workspace revision conflicts as structured HTTP 409 responses", async () => {
    const conflict = new ConflictError({
      code: "WRITE_CONFLICT",
      message: "workspace changed",
      details: {
        resourceKind: "workspace",
        resourceId: "workspace-1",
        expectedRevision: 2,
        currentRevision: 3,
      },
    });
    await registerWorkspaceService({
      updateWorkspace: vi.fn(async () => {
        throw conflict;
      }),
      archiveWorkspace: vi.fn(async () => {
        throw conflict;
      }),
      restoreWorkspace: vi.fn(async () => {
        throw conflict;
      }),
    });

    const responses = await Promise.all([
      app!.inject({
        method: "PATCH",
        url: "/api/v1/workspaces/workspace-1",
        payload: { expectedRevision: 2, name: "Draft" },
      }),
      app!.inject({
        method: "POST",
        url: "/api/v1/workspaces/workspace-1/archive",
        payload: { expectedRevision: 2 },
      }),
      app!.inject({
        method: "POST",
        url: "/api/v1/workspaces/workspace-1/restore",
        payload: { expectedRevision: 2 },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "WRITE_CONFLICT",
        details: {
          resourceKind: "workspace",
          resourceId: "workspace-1",
          expectedRevision: 2,
          currentRevision: 3,
        },
      });
    }
  });

  it("rejects malformed workspace and guidance inputs before calling services", async () => {
    const service = await registerWorkspaceService();

    const createResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      payload: {
        name: "",
      },
    });
    const getResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/workspaces/",
    });
    const updateResponse = await app!.inject({
      method: "PATCH",
      url: "/api/v1/workspaces/default",
      payload: {
        name: "",
      },
    });
    const globalGuidanceResponse = await app!.inject({
      method: "PUT",
      url: "/api/v1/guidance/global/security",
      payload: {},
    });
    const workspaceGuidanceResponse = await app!.inject({
      method: "PUT",
      url: "/api/v1/workspaces/default/guidance/agents",
      payload: {},
    });

    expect(createResponse.statusCode).toBe(400);
    expect(getResponse.statusCode).toBe(400);
    expect(updateResponse.statusCode).toBe(400);
    expect(globalGuidanceResponse.statusCode).toBe(400);
    expect(workspaceGuidanceResponse.statusCode).toBe(400);
    expect(service.createWorkspace).not.toHaveBeenCalled();
    expect(service.updateWorkspace).not.toHaveBeenCalled();
    expect(service.updateGlobalGuidance).not.toHaveBeenCalled();
    expect(service.updateWorkspaceGuidance).not.toHaveBeenCalled();
  });
});
