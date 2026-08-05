import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { agentsRoutes } from "./agents.js";

describe("agents routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  function createAgentsService(overrides: Record<string, unknown> = {}) {
    return {
      listAgents: vi.fn(async (view: string, limit: number) => [
        {
          roleId: `agent-${view}`,
          name: `Agent ${view}`,
          title: "Operator",
          summary: `Limit ${limit}`,
          lifecycleStatus: view === "archived" ? "archived" : "active",
        },
      ]),
      listImportedAgentCatalog: vi.fn(() => ({ items: [] })),
      getImportedAgentCatalogEntry: vi.fn((entryId: string) => ({
        entryId,
        state: "disabled",
      })),
      importAgencyAgentCatalog: vi.fn(async () => ({ importedCount: 0 })),
      patchImportedAgentCatalogEntryState: vi.fn((entryId: string, patch: Record<string, unknown>) => ({
        entryId,
        ...patch,
      })),
      activateImportedAgentCatalogEntryForSession: vi.fn(),
      getAgent: vi.fn((agentId: string) => ({ roleId: agentId, name: "Goatherder" })),
      createAgentProfile: vi.fn((input: Record<string, unknown>) => ({
        lifecycleStatus: "active",
        ...input,
      })),
      updateAgentProfile: vi.fn((agentId: string, input: Record<string, unknown>) => ({
        roleId: agentId,
        ...input,
      })),
      archiveAgentProfile: vi.fn((agentId: string, input: Record<string, unknown>) => ({
        roleId: agentId,
        lifecycleStatus: "archived",
        ...input,
      })),
      restoreAgentProfile: vi.fn((agentId: string) => ({
        roleId: agentId,
        lifecycleStatus: "active",
      })),
      hardDeleteAgentProfile: vi.fn(() => true),
      ...overrides,
    };
  }

  async function registerAgentsService(overrides: Record<string, unknown> = {}) {
    const service = createAgentsService(overrides);
    app = Fastify();
    app.decorate("services", { agents: service } as never);
    await app.register(agentsRoutes);
    return service;
  }

  it("lists imported catalog entries with workspace filters", async () => {
    const listImportedAgentCatalog = vi.fn(() => ({
      workspaceId: "default",
      divisions: ["engineering"],
      items: [
        {
          entryId: "catalog-frontend",
          workspaceId: "default",
          division: "engineering",
          state: "disabled",
          createdAt: "2026-04-20T12:00:00.000Z",
          updatedAt: "2026-04-20T12:00:00.000Z",
          definition: {
            definitionId: "definition-frontend",
            slug: "frontend-developer",
            frontmatter: {
              name: "Frontend Developer",
              description: "Builds polished interfaces",
            },
            rawMarkdown: "# Frontend Developer",
            bodyMarkdown: "## Your Core Mission",
            sectionOrder: ["core-mission"],
            sectionMap: {},
            parseStatus: "supported",
            parseWarnings: [],
            provenance: {
              provider: "agency_agents",
              repoUrl: "https://github.com/msitarzewski/agency-agents",
              ref: "main",
              commit: "abc123",
              path: "engineering/frontend-developer.md",
              sha256: "sha",
              importedAt: "2026-04-20T12:00:00.000Z",
            },
          },
        },
      ],
    }));
    app = Fastify();
    app.decorate("services", { agents: { listImportedAgentCatalog } } as never);
    await app.register(agentsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agents/catalog?workspaceId=default&division=engineering&parseStatus=supported",
    });

    expect(response.statusCode).toBe(200);
    expect(listImportedAgentCatalog).toHaveBeenCalledWith({
      workspaceId: "default",
      division: "engineering",
      parseStatus: "supported",
      limit: 300,
    });
    expect(response.json()).toMatchObject({
      workspaceId: "default",
      divisions: ["engineering"],
      items: [{ entryId: "catalog-frontend" }],
    });
  });

  it("imports the Agency repo through the catalog route", async () => {
    const importAgencyAgentCatalog = vi.fn(async () => ({
      workspaceId: "default",
      repoUrl: "https://github.com/msitarzewski/agency-agents.git",
      ref: "main",
      commit: "abc123",
      importedAt: "2026-04-20T13:00:00.000Z",
      importedCount: 144,
      divisions: ["engineering", "marketing"],
      parseCounts: {
        supported: 120,
        supported_with_warnings: 20,
        unsupported: 4,
      },
    }));
    app = Fastify();
    app.decorate("services", { agents: { importAgencyAgentCatalog } } as never);
    await app.register(agentsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/catalog/import/agency-agents",
      payload: {
        workspaceId: "default",
        ref: "main",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(importAgencyAgentCatalog).toHaveBeenCalledWith({
      workspaceId: "default",
      ref: "main",
    });
    expect(response.json()).toMatchObject({
      importedCount: 144,
      parseCounts: {
        supported: 120,
      },
    });
  });

  it("activates a catalog entry into the current session", async () => {
    const activateImportedAgentCatalogEntryForSession = vi.fn(() => ({
      catalogEntry: {
        entryId: "catalog-frontend",
        workspaceId: "default",
        division: "engineering",
        state: "active",
      },
      specialist: {
        candidateId: "candidate-frontend",
        sessionId: "sess-1",
        source: "catalog",
        status: "active",
        routingMode: "manual_only",
      },
    }));
    app = Fastify();
    app.decorate("services", { agents: { activateImportedAgentCatalogEntryForSession } } as never);
    await app.register(agentsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/catalog/catalog-frontend/activate-session",
      payload: {
        sessionId: "sess-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(activateImportedAgentCatalogEntryForSession).toHaveBeenCalledWith("sess-1", "catalog-frontend");
    expect(response.json()).toMatchObject({
      specialist: {
        source: "catalog",
        routingMode: "manual_only",
      },
    });
  });

  it("projects imported catalog provenance URLs at every response boundary without mutating service truth", async () => {
    const rawRepoUrl =
      "https://agency-user:agent-provenance-secret@example.test/private-agents.git?access_token=agent-provenance-secret";
    const rawMarkdown = [
      "# Private Agent",
      "",
      "Operator-authored example: Authorization: Bearer prose-must-remain-byte-identical",
    ].join("\n");
    const catalogEntry = {
      entryId: "catalog-private",
      workspaceId: "default",
      division: "engineering",
      state: "approved",
      definition: {
        definitionId: "definition-private",
        slug: "private-agent",
        rawMarkdown,
        provenance: {
          provider: "agency_agents",
          repoUrl: rawRepoUrl,
          ref: "main",
          path: "engineering/private-agent.md",
          sha256: "sha-private",
          importedAt: "2026-07-09T12:00:00.000Z",
        },
      },
    };
    const catalogList = {
      workspaceId: "default",
      divisions: ["engineering"],
      items: [catalogEntry],
    };
    const importResult = {
      workspaceId: "default",
      repoUrl: rawRepoUrl,
      ref: "main",
      importedAt: "2026-07-09T12:00:00.000Z",
      importedCount: 1,
      divisions: ["engineering"],
      parseCounts: { supported: 1, supported_with_warnings: 0, unsupported: 0 },
    };
    const activationResult = {
      catalogEntry,
      specialist: {
        candidateId: "candidate-private",
        sessionId: "sess-private",
        source: "catalog",
        status: "active",
        routingMode: "manual_only",
      },
    };
    const service = await registerAgentsService({
      listImportedAgentCatalog: vi.fn(() => catalogList),
      getImportedAgentCatalogEntry: vi.fn(() => catalogEntry),
      importAgencyAgentCatalog: vi.fn(async () => importResult),
      patchImportedAgentCatalogEntryState: vi.fn(() => catalogEntry),
      activateImportedAgentCatalogEntryForSession: vi.fn(() => activationResult),
    });

    const listResponse = await app!.inject({ method: "GET", url: "/api/v1/agents/catalog" });
    const detailResponse = await app!.inject({ method: "GET", url: "/api/v1/agents/catalog/catalog-private" });
    const importResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/agents/catalog/import/agency-agents",
      payload: { workspaceId: "default", repoUrl: rawRepoUrl, ref: "main" },
    });
    const stateResponse = await app!.inject({
      method: "PATCH",
      url: "/api/v1/agents/catalog/catalog-private/state",
      payload: { state: "approved" },
    });
    const activationResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/agents/catalog/catalog-private/activate-session",
      payload: { sessionId: "sess-private" },
    });

    expect(service.importAgencyAgentCatalog).toHaveBeenCalledWith({
      workspaceId: "default",
      repoUrl: rawRepoUrl,
      ref: "main",
    });
    expect([
      listResponse.statusCode,
      detailResponse.statusCode,
      importResponse.statusCode,
      stateResponse.statusCode,
      activationResponse.statusCode,
    ]).toEqual([200, 200, 201, 200, 200]);
    const publicBodies = [
      listResponse.json(),
      detailResponse.json(),
      importResponse.json(),
      stateResponse.json(),
      activationResponse.json(),
    ];
    for (const body of publicBodies) {
      expect(JSON.stringify(body)).not.toContain("agent-provenance-secret");
      expect(JSON.stringify(body)).toContain("[REDACTED]");
    }
    expect(listResponse.json().items[0].definition.rawMarkdown).toBe(rawMarkdown);
    expect(detailResponse.json().definition.rawMarkdown).toBe(rawMarkdown);

    expect(catalogEntry.definition.provenance.repoUrl).toBe(rawRepoUrl);
    expect(catalogEntry.definition.rawMarkdown).toBe(rawMarkdown);
    expect(importResult.repoUrl).toBe(rawRepoUrl);
  });

  it("lists active agents with default route filters", async () => {
    const service = await registerAgentsService();

    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/agents",
    });

    expect(response.statusCode).toBe(200);
    expect(service.listAgents).toHaveBeenCalledWith("active", 300);
    expect(response.json()).toMatchObject({
      view: "active",
      items: [{ roleId: "agent-active" }],
    });
  });

  it("reads and patches imported catalog entries by id", async () => {
    const service = await registerAgentsService();

    const detailResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/agents/catalog/catalog-frontend",
    });
    const patchResponse = await app!.inject({
      method: "PATCH",
      url: "/api/v1/agents/catalog/catalog-frontend/state",
      payload: {
        state: "approved",
      },
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(patchResponse.statusCode).toBe(200);
    expect(service.getImportedAgentCatalogEntry).toHaveBeenCalledWith("catalog-frontend");
    expect(service.patchImportedAgentCatalogEntryState).toHaveBeenCalledWith("catalog-frontend", {
      state: "approved",
    });
    expect(detailResponse.json()).toMatchObject({ entryId: "catalog-frontend" });
    expect(patchResponse.json()).toMatchObject({
      entryId: "catalog-frontend",
      state: "approved",
    });
  });

  it("creates, updates, archives, restores, and hard-deletes agent profiles", async () => {
    const service = await registerAgentsService();

    const createResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: {
        roleId: "custom-agent",
        name: "Custom Agent",
        title: "Custom Operator",
        summary: "A custom operator profile.",
        specialties: ["testing"],
      },
    });
    const updateResponse = await app!.inject({
      method: "PATCH",
      url: "/api/v1/agents/custom-agent",
      payload: {
        title: "Updated Operator",
      },
    });
    const archiveResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/agents/custom-agent/archive",
      payload: {
        archivedBy: "operator",
        archiveReason: "not needed",
      },
    });
    const restoreResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/agents/custom-agent/restore",
    });
    const deleteResponse = await app!.inject({
      method: "DELETE",
      url: "/api/v1/agents/custom-agent?mode=hard",
    });

    expect(createResponse.statusCode).toBe(201);
    expect(updateResponse.statusCode).toBe(200);
    expect(archiveResponse.statusCode).toBe(200);
    expect(restoreResponse.statusCode).toBe(200);
    expect(deleteResponse.statusCode).toBe(200);
    expect(service.createAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        roleId: "custom-agent",
        title: "Custom Operator",
      }),
    );
    expect(service.updateAgentProfile).toHaveBeenCalledWith("custom-agent", {
      title: "Updated Operator",
    });
    expect(service.archiveAgentProfile).toHaveBeenCalledWith("custom-agent", {
      archivedBy: "operator",
      archiveReason: "not needed",
    });
    expect(service.restoreAgentProfile).toHaveBeenCalledWith("custom-agent");
    expect(service.hardDeleteAgentProfile).toHaveBeenCalledWith("custom-agent");
    expect(deleteResponse.json()).toEqual({
      deleted: true,
      agentId: "custom-agent",
      mode: "hard",
    });
  });

  it("rejects malformed agent route inputs before calling services", async () => {
    const service = await registerAgentsService();

    const listResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/agents?limit=0",
    });
    const importResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/agents/catalog/import/agency-agents",
      payload: {
        workspaceId: "",
      },
    });
    const stateResponse = await app!.inject({
      method: "PATCH",
      url: "/api/v1/agents/catalog/catalog-frontend/state",
      payload: {
        state: "published",
      },
    });
    const activationResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/agents/catalog/catalog-frontend/activate-session",
      payload: {},
    });
    const createResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: {
        roleId: "custom-agent",
      },
    });
    const deleteResponse = await app!.inject({
      method: "DELETE",
      url: "/api/v1/agents/custom-agent",
    });

    expect(listResponse.statusCode).toBe(400);
    expect(importResponse.statusCode).toBe(400);
    expect(stateResponse.statusCode).toBe(400);
    expect(activationResponse.statusCode).toBe(400);
    expect(createResponse.statusCode).toBe(400);
    expect(deleteResponse.statusCode).toBe(400);
    expect(service.listAgents).not.toHaveBeenCalled();
    expect(service.importAgencyAgentCatalog).not.toHaveBeenCalled();
    expect(service.patchImportedAgentCatalogEntryState).not.toHaveBeenCalled();
    expect(service.activateImportedAgentCatalogEntryForSession).not.toHaveBeenCalled();
    expect(service.createAgentProfile).not.toHaveBeenCalled();
    expect(service.hardDeleteAgentProfile).not.toHaveBeenCalled();
  });

  it("returns 404 when hard-deleting an unknown agent profile", async () => {
    const service = await registerAgentsService({
      hardDeleteAgentProfile: vi.fn(() => false),
    });

    const response = await app!.inject({
      method: "DELETE",
      url: "/api/v1/agents/missing-agent?mode=hard",
    });

    expect(response.statusCode).toBe(404);
    expect(service.hardDeleteAgentProfile).toHaveBeenCalledWith("missing-agent");
    expect(response.json()).toEqual({
      error: "Agent profile missing-agent not found",
    });
  });

  it("uses the shared route error envelope for untyped service failures", async () => {
    await registerAgentsService({
      getAgent: vi.fn(() => {
        throw new Error("plain failure");
      }),
    });

    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/agents/custom-agent",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
  });
});
