import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CITADEL_ID, type CapabilityScopeAssignment } from "@goatcitadel/contracts";
import { CapabilityScopeResolver, type CapabilityScopeResolverDeps } from "./capability-scope-resolver.js";
import { WorkspaceTurnSkills, type TurnSkillCatalogSource } from "./workspace-turn-skills.js";

function catalog() {
  return {
    listSkills: vi.fn(async () => []),
    listCatalog: vi.fn(async () => []),
  } satisfies TurnSkillCatalogSource;
}

function skillRow(scopeKind: "citadel" | "workspace", scopeId: string, resourceRef: string): CapabilityScopeAssignment {
  return {
    assignmentId: `${scopeKind}-${resourceRef}`,
    scopeKind,
    scopeId,
    resourceType: "skill",
    resourceRef,
    enabled: true,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  };
}

function resolver(rows: CapabilityScopeAssignment[], overrides: Partial<CapabilityScopeResolverDeps> = {}) {
  return new CapabilityScopeResolver({
    listAssignmentsForScope: (kind, id) => rows.filter((row) => row.scopeKind === kind && row.scopeId === id),
    listAllSkillIds: () => ["bundled:alpha", "bundled:beta"],
    listAllIntegrationIds: () => [],
    listAllMcpServerIds: () => [],
    isDisabled: () => false,
    ...overrides,
  });
}

function turnSkills(source: TurnSkillCatalogSource, scopeResolver: CapabilityScopeResolver, citadelId = "personal") {
  const resolveCitadelId = vi.fn(async () => citadelId);
  return { skills: new WorkspaceTurnSkills(source, { resolver: scopeResolver, resolveCitadelId }), resolveCitadelId };
}

describe("WorkspaceTurnSkills", () => {
  it("keeps reads without a workspace install-wide, as before", async () => {
    const source = catalog();
    const { skills, resolveCitadelId } = turnSkills(source, resolver([]));

    await skills.listSkills();
    await skills.listCatalog("callable");
    await skills.listInstalledCatalog("inspectable");

    expect(source.listSkills).toHaveBeenCalledWith();
    expect(source.listCatalog.mock.calls).toEqual([["callable"], ["inspectable"]]);
    expect(resolveCitadelId).not.toHaveBeenCalled();
  });

  it("passes the workspace's own choices, narrowed by its Citadel's, with the workspace", async () => {
    const source = catalog();
    const rows = [
      skillRow("citadel", "team", "bundled:alpha"),
      skillRow("citadel", "team", "bundled:beta"),
      skillRow("workspace", "workspace-a", "bundled:alpha"),
      skillRow("workspace", "workspace-a", "bundled:gone"),
    ];
    const { skills, resolveCitadelId } = turnSkills(source, resolver(rows), "team");

    await skills.listSkills("workspace-a");
    await skills.listCatalog("callable", "workspace-a");
    await skills.listInstalledCatalog("callable", "workspace-a");

    const chosen = new Set(["bundled:alpha"]);
    expect(resolveCitadelId).toHaveBeenCalledWith("workspace-a");
    expect(source.listSkills).toHaveBeenCalledWith(chosen, "workspace-a");
    // The base prompt's index never takes the workspace, so it never adds self-authored skills.
    expect(source.listCatalog.mock.calls).toEqual([
      ["callable", chosen, "workspace-a"],
      ["callable", chosen],
    ]);
  });

  it("passes ALL for a workspace whose Citadel has not chosen either", async () => {
    const source = catalog();
    const { skills } = turnSkills(source, resolver([]));

    await skills.listCatalog("inspectable", "workspace-a");

    expect(source.listCatalog).toHaveBeenCalledWith("inspectable", "ALL", "workspace-a");
  });

  it("reads a blank Citadel id as the default Citadel", async () => {
    const source = catalog();
    const { skills } = turnSkills(source, resolver([skillRow("citadel", DEFAULT_CITADEL_ID, "bundled:beta")]), "");

    await skills.listSkills("workspace-a");

    expect(source.listSkills).toHaveBeenCalledWith(new Set(["bundled:beta"]), "workspace-a");
  });

  it("chooses no installed skill when the choices cannot be read", async () => {
    const source = catalog();
    const onError = vi.fn();
    const failing = resolver([], {
      listAssignmentsForScope: () => {
        throw new Error("storage unavailable");
      },
      onError,
    });

    await turnSkills(source, failing).skills.listCatalog("callable", "workspace-a");

    expect(source.listCatalog).toHaveBeenCalledWith("callable", new Set(), "workspace-a");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("chooses no installed skill, and reports why, when the workspace's Citadel cannot be read", async () => {
    const source = catalog();
    const onError = vi.fn();
    const failure = new Error("workspace store unavailable");
    const skills = new WorkspaceTurnSkills(source, {
      resolver: resolver([]),
      resolveCitadelId: async () => {
        throw failure;
      },
      onError,
    });

    await skills.listSkills("workspace-a");

    expect(source.listSkills).toHaveBeenCalledWith(new Set(), "workspace-a");
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("never hides a skill because integrations or MCP servers cannot be listed", async () => {
    const source = catalog();
    const unavailable = () => {
      throw new Error("unavailable");
    };
    const rows = [skillRow("workspace", "workspace-a", "bundled:alpha")];
    const scopeResolver = resolver(rows, { listAllIntegrationIds: unavailable, listAllMcpServerIds: unavailable });

    await turnSkills(source, scopeResolver).skills.listSkills("workspace-a");

    expect(source.listSkills).toHaveBeenCalledWith(new Set(["bundled:alpha"]), "workspace-a");
    // The full resolution the MCP scope gate uses still fails closed for every type.
    expect((await scopeResolver.resolve("personal", "workspace-a")).skills).toEqual(new Set());
  });

  it("passes ALL while capability scoping is switched off", async () => {
    const source = catalog();
    const rows = [skillRow("workspace", "workspace-a", "bundled:alpha")];

    await turnSkills(source, resolver(rows, { isDisabled: () => true })).skills.listSkills("workspace-a");

    expect(source.listSkills).toHaveBeenCalledWith("ALL", "workspace-a");
  });
});

describe("workspace turn skill wiring", () => {
  // Every workspace turn reads skills through WorkspaceTurnSkills. A direct "ALL" read would load
  // skills the workspace's choices leave out.
  it.each(["./gateway-service.ts", "./chat-skill-selection-runtime.ts", "./chat-capability-discovery-service.ts"])(
    "%s never reads the install-wide skill set for a workspace",
    (file) => {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");

      expect(source).not.toMatch(/\.(listCatalog|listSkills)\([^)]*"ALL"/);
    },
  );
});
