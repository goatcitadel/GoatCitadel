import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { trustRoutes } from "./trust.js";

describe("trust routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  async function registerTrustServices(services: Record<string, unknown>) {
    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", services as never);
    await app.register(trustRoutes);
  }

  it("projects permission profiles and callable capabilities without mutating enforcement state", async () => {
    const listPermissionProfiles = vi.fn(() => [
      {
        profileId: "profile-1",
        label: "Careful Code",
        builtin: false,
        status: "active",
        scope: "operator",
        scopeRef: "operator-test",
        approvalMode: "approve_risky",
        toolPatterns: ["shell.exec"],
        allow: ["files.read"],
        deny: ["browser.cookies.get"],
        readAccessMode: "roots_only",
        defaultForSurfaces: ["code"],
        createdBy: "operator-test",
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
      },
    ]);
    const listCapabilityCatalog = vi.fn((scope: "inspectable" | "callable") => [
      {
        capabilityId: `cap-${scope}`,
        kind: "tool",
        category: "built_in",
        title: `Catalog ${scope}`,
        summary: "Runtime-owned capability.",
        callable: scope === "callable",
        toolName: "files.read",
      },
    ]);

    await registerTrustServices({
      tools: {
        listPermissionProfiles,
        listToolGrants: vi.fn(() => []),
        listActiveLocalOperatorOverrides: vi.fn(() => []),
      },
      capabilities: {
        listCapabilityCatalog,
      },
      mcp: {
        listMcpServers: vi.fn(() => []),
      },
      skills: {
        listSkills: vi.fn(() => []),
      },
      addons: {
        listAddonsCatalog: vi.fn(() => []),
        listInstalledAddons: vi.fn(async () => []),
      },
    });

    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/trust/policy-snapshot",
    });

    expect(response.statusCode).toBe(200);
    expect(listPermissionProfiles).toHaveBeenCalledWith(true);
    expect(listCapabilityCatalog).toHaveBeenCalledWith("callable");
    expect(response.json()).toMatchObject({
      readOnly: true,
      mutationSemantics: "none",
      permissionProfiles: [
        {
          profileId: "profile-1",
          approvalMode: "approve_risky",
          posture: "callable",
          source: "tools.permissionProfiles",
        },
      ],
      capabilities: {
        callable: [
          {
            capabilityId: "cap-callable",
            callable: true,
            posture: "callable",
            source: "capabilities.catalog",
          },
        ],
      },
    });
  });

  it("keeps MCP quarantined servers and tools distinguishable from ordinary non-callable state", async () => {
    await registerTrustServices({
      tools: {
        listPermissionProfiles: vi.fn(() => []),
        listToolGrants: vi.fn(() => []),
        listActiveLocalOperatorOverrides: vi.fn(() => []),
      },
      capabilities: {
        listCapabilityCatalog: vi.fn(() => []),
      },
      mcp: {
        listMcpServers: vi.fn(() => [
          {
            serverId: "mcp-1",
            label: "Quarantined Browser",
            transport: "stdio",
            enabled: true,
            status: "connected",
            category: "browser",
            trustTier: "quarantined",
            costTier: "unknown",
            policy: {
              requireFirstToolApproval: true,
              redactionMode: "strict",
              allowedToolPatterns: [],
              blockedToolPatterns: ["*"],
            },
            createdAt: "2026-05-18T00:00:00.000Z",
            updatedAt: "2026-05-18T00:00:00.000Z",
          },
        ]),
        listMcpTools: vi.fn(() => [
          {
            serverId: "mcp-1",
            toolName: "browser.navigate",
            enabled: true,
            updatedAt: "2026-05-18T00:01:00.000Z",
          },
        ]),
      },
      skills: {
        listSkills: vi.fn(() => []),
      },
      addons: {
        listAddonsCatalog: vi.fn(() => []),
        listInstalledAddons: vi.fn(async () => []),
      },
    });

    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/trust/policy-snapshot",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mcpServers: [
        {
          serverId: "mcp-1",
          trustTier: "quarantined",
          posture: "quarantined",
          tools: [
            {
              toolName: "browser.navigate",
              posture: "quarantined",
            },
          ],
        },
      ],
      sources: expect.arrayContaining([
        expect.objectContaining({
          key: "mcpTools.mcp-1",
          status: "available",
          itemCount: 1,
        }),
      ]),
    });
  });

  it("returns stable empty states when projection sources are unavailable", async () => {
    await registerTrustServices({});

    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/trust/policy-snapshot",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      readOnly: true,
      permissionProfiles: [],
      toolGrants: [],
      localOperatorOverrides: [],
      capabilities: {
        inspectable: [],
        callable: [],
      },
      mcpServers: [],
      skills: [],
      addons: [],
      lastUseEvidence: [],
    });
    expect(response.json().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "permissionProfiles",
          status: "unavailable",
          itemCount: 0,
        }),
        expect.objectContaining({
          key: "capabilities.callable",
          status: "unavailable",
          itemCount: 0,
        }),
        expect.objectContaining({
          key: "mcpServers",
          status: "unavailable",
          itemCount: 0,
        }),
      ]),
    );
  });

  it("keeps concrete last-use evidence references when sources provide them", async () => {
    await registerTrustServices({
      tools: {
        listPermissionProfiles: vi.fn(() => []),
        listToolGrants: vi.fn(() => []),
        listActiveLocalOperatorOverrides: vi.fn(() => []),
      },
      capabilities: {
        listCapabilityCatalog: vi.fn(() => []),
      },
      mcp: {
        listMcpServers: vi.fn(() => []),
      },
      skills: {
        listSkills: vi.fn(() => [
          {
            skillId: "skill-1",
            name: "Skill one",
            state: "enabled",
            lastUsedAt: "2026-05-30T17:30:00.000Z",
            usageCount: 2,
            lastRunId: "run-skill-1",
            lastApprovalId: "approval-skill-1",
            lastEvidenceRef: "evidence-skill-1",
          },
        ]),
      },
      addons: {
        listAddonsCatalog: vi.fn(() => []),
        listInstalledAddons: vi.fn(async () => []),
      },
    });

    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/trust/policy-snapshot",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().lastUseEvidence).toEqual([
      expect.objectContaining({
        subjectType: "skill",
        subjectId: "skill-1",
        runId: "run-skill-1",
        approvalId: "approval-skill-1",
        evidenceRef: "evidence-skill-1",
      }),
    ]);
  });
});
