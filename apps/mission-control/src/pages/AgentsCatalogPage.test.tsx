import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchImportedAgentCatalog: vi.fn(async () => ({
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
          bodyMarkdown: "## Your Core Mission\n- Ship clean UI",
          sectionOrder: ["core-mission"],
          sectionMap: {
            "core-mission": {
              key: "core-mission",
              slug: "core-mission",
              heading: "Your Core Mission",
              level: 2,
              kind: "operations",
              content: "- Ship clean UI",
              canonicalKey: "core-mission",
            },
          },
          parseStatus: "supported_with_warnings",
          parseWarnings: ["Unrecognized sections: Secret Sauce."],
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
  })),
  importAgencyAgentCatalog: vi.fn(async () => ({
    workspaceId: "default",
    repoUrl: "https://github.com/msitarzewski/agency-agents.git",
    ref: "main",
    importedAt: "2026-04-20T13:00:00.000Z",
    importedCount: 144,
    divisions: ["engineering"],
    parseCounts: {
      supported: 120,
      supported_with_warnings: 20,
      unsupported: 4,
    },
  })),
  patchImportedAgentCatalogState: vi.fn(async (_entryId: string, input: { state: string }) => ({
    entryId: "catalog-frontend",
    workspaceId: "default",
    division: "engineering",
    state: input.state,
    createdAt: "2026-04-20T12:00:00.000Z",
    updatedAt: "2026-04-20T13:00:00.000Z",
    definition: {
      definitionId: "definition-frontend",
      slug: "frontend-developer",
      frontmatter: {
        name: "Frontend Developer",
        description: "Builds polished interfaces",
      },
      rawMarkdown: "# Frontend Developer",
      bodyMarkdown: "## Your Core Mission\n- Ship clean UI",
      sectionOrder: ["core-mission"],
      sectionMap: {},
      parseStatus: "supported_with_warnings",
      parseWarnings: [],
      provenance: {
        provider: "agency_agents",
        path: "engineering/frontend-developer.md",
        sha256: "sha",
        importedAt: "2026-04-20T12:00:00.000Z",
      },
    },
  })),
  activateImportedAgentCatalogEntry: vi.fn(async () => ({
    catalogEntry: {
      entryId: "catalog-frontend",
      workspaceId: "default",
      division: "engineering",
      state: "active",
      createdAt: "2026-04-20T12:00:00.000Z",
      updatedAt: "2026-04-20T13:00:00.000Z",
      definition: {
        definitionId: "definition-frontend",
        slug: "frontend-developer",
        frontmatter: {
          name: "Frontend Developer",
          description: "Builds polished interfaces",
        },
        rawMarkdown: "# Frontend Developer",
        bodyMarkdown: "## Your Core Mission\n- Ship clean UI",
        sectionOrder: ["core-mission"],
        sectionMap: {},
        parseStatus: "supported_with_warnings",
        parseWarnings: [],
        provenance: {
          provider: "agency_agents",
          path: "engineering/frontend-developer.md",
          sha256: "sha",
          importedAt: "2026-04-20T12:00:00.000Z",
        },
      },
    },
    specialist: {
      candidateId: "candidate-frontend",
      sessionId: "sess-1",
      source: "catalog",
      status: "active",
      routingMode: "manual_only",
    },
  })),
}));

vi.mock("../api/client", () => apiMocks);

import { AgentsCatalogPage } from "./AgentsCatalogPage";

describe("AgentsCatalogPage", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    renderer?.unmount();
    renderer = null;
    apiMocks.fetchImportedAgentCatalog.mockClear();
    apiMocks.importAgencyAgentCatalog.mockClear();
    apiMocks.patchImportedAgentCatalogState.mockClear();
    apiMocks.activateImportedAgentCatalogEntry.mockClear();
  });

  it("renders catalog search results, parse badges, and rich preview", async () => {
    await act(async () => {
      renderer = create(<AgentsCatalogPage workspaceId="default" sessionId="sess-1" />);
    });

    const text = JSON.stringify(renderer!.toJSON());
    expect(apiMocks.fetchImportedAgentCatalog).toHaveBeenCalled();
    expect(text).toContain("Frontend Developer");
    expect(text).toContain("warnings");
    expect(text).toContain("engineering/frontend-developer.md");
    expect(text).toContain("Rich definition preview");
    expect(text).toContain("Activate for session");
  });
});
