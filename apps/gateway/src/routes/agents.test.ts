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
});
