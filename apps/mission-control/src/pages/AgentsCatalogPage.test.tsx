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

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

function collectText(node: unknown): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return ((node as { children?: unknown[] }).children ?? []).map((child) => collectText(child)).join(" ");
  }
  return "";
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

async function clickButton(renderer: ReactTestRenderer, label: string, occurrence = 0): Promise<void> {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && collectText(node).replace(/\s+/g, " ").includes(label),
  )[occurrence];
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  await act(async () => {
    button.props.onClick();
  });
  await flush();
}

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

  it("imports, approves, retires, and activates catalog entries through visible controls", async () => {
    await act(async () => {
      renderer = create(<AgentsCatalogPage workspaceId="default" sessionId="sess-1" />);
    });
    await flush();

    await clickButton(renderer!, "Import / Refresh Agency");
    expect(apiMocks.importAgencyAgentCatalog).toHaveBeenCalledWith({ workspaceId: "default" });
    expect(rendererText(renderer!)).toContain("Imported 144 Agency specialists for default from main.");

    await clickButton(renderer!, "Approve");
    expect(apiMocks.patchImportedAgentCatalogState).toHaveBeenCalledWith("catalog-frontend", { state: "approved" });
    expect(rendererText(renderer!)).toContain("Frontend Developer is now approved.");

    await clickButton(renderer!, "Retire");
    expect(apiMocks.patchImportedAgentCatalogState).toHaveBeenCalledWith("catalog-frontend", { state: "retired" });

    await clickButton(renderer!, "Activate for session");
    expect(apiMocks.activateImportedAgentCatalogEntry).toHaveBeenCalledWith("catalog-frontend", {
      sessionId: "sess-1",
    });
    expect(rendererText(renderer!)).toContain(
      "Activated Frontend Developer for session sess-1 as a manual-only specialist.",
    );
  });

  it("shows empty-state import affordance when no specialists are imported", async () => {
    apiMocks.fetchImportedAgentCatalog.mockResolvedValueOnce({
      workspaceId: "default",
      divisions: [],
      items: [],
    });

    await act(async () => {
      renderer = create(<AgentsCatalogPage workspaceId="default" sessionId="sess-1" />);
    });
    await flush();

    expect(rendererText(renderer!)).toContain("No imported specialists yet");
    expect(rendererText(renderer!)).toContain("Run the Agency import to populate the catalog for this workspace.");

    await clickButton(renderer!, "Import Agency");
    expect(apiMocks.importAgencyAgentCatalog).toHaveBeenCalledWith({ workspaceId: "default" });
  });

  it("surfaces catalog load and import failures as visible errors", async () => {
    apiMocks.fetchImportedAgentCatalog.mockRejectedValueOnce(new Error("catalog database unavailable"));

    await act(async () => {
      renderer = create(<AgentsCatalogPage workspaceId="default" />);
    });
    await flush();

    expect(rendererText(renderer!)).toContain("catalog database unavailable");

    apiMocks.importAgencyAgentCatalog.mockRejectedValueOnce(new Error("agency repo unavailable"));
    await clickButton(renderer!, "Import / Refresh Agency");

    expect(rendererText(renderer!)).toContain("agency repo unavailable");
  });
});
