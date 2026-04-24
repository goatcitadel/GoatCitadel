import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
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

  it("lists workspaces through gateway service", async () => {
    const listWorkspaces = vi.fn(() => [
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
      url: "/api/v1/workspaces?view=active&limit=25",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: unknown[] };
    expect(body.items).toHaveLength(1);
    expect(listWorkspaces).toHaveBeenCalledWith("active", 25);
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
});
