import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustRoutes } from "./trust.js";

describe("trust routes", () => {
  let app: FastifyInstance | null = null;
  const tmpRoots: string[] = [];

  function writeSkillBundle(manifestExtra: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "trust-gov-"));
    tmpRoots.push(dir);
    writeFileSync(
      join(dir, "goatcitadel.skill-bundle.json"),
      JSON.stringify({
        manifestVersion: "goatcitadel.skill-bundle.v1",
        scriptDisposition: "review_only_non_callable",
        assets: [{ path: "SKILL.md", sha256: "0".repeat(64), kind: "skill" }],
        ...manifestExtra,
      }),
    );
    return dir;
  }

  afterEach(async () => {
    for (const dir of tmpRoots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("projects inline declared governance metadata and marks elevated skills medium trust", async () => {
    await registerTrustServices({
      tools: {
        listPermissionProfiles: vi.fn(() => []),
        listToolGrants: vi.fn(() => []),
        listActiveLocalOperatorOverrides: vi.fn(() => []),
      },
      capabilities: { listCapabilityCatalog: vi.fn(() => []) },
      mcp: { listMcpServers: vi.fn(() => []) },
      skills: {
        listSkills: vi.fn(() => [
          {
            skillId: "skill-gov",
            name: "Governed Skill",
            state: "enabled",
            callable: true,
            declaredMetadata: {
              requiredEnv: [{ name: "GOVERNED_KEY" }],
              stateDirs: [{ path: "state/cache", writeable: true }],
              dependencies: { capabilities: ["network"] },
            },
            bundleWarnings: ["Skill declares a writeable state directory: state/cache (review before trusting)."],
            missingRequiredEnv: ["GOVERNED_KEY"],
          },
        ]),
      },
      addons: {
        listAddonsCatalog: vi.fn(() => []),
        listInstalledAddons: vi.fn(async () => []),
      },
    });

    const response = await app!.inject({ method: "GET", url: "/api/v1/trust/policy-snapshot" });

    expect(response.statusCode).toBe(200);
    const skill = response.json().skills[0];
    expect(skill.posture).toBe("medium_trust_unverified");
    expect(skill.declaredMetadata.stateDirs[0].path).toBe("state/cache");
    expect(skill.bundleWarnings[0]).toContain("writeable state directory");
    expect(skill.missingRequiredEnv).toEqual(["GOVERNED_KEY"]);
  });

  it("enriches skills from their bundle manifest and flags missing required env", async () => {
    const dir = writeSkillBundle({
      requiredEnv: [{ name: "GOATCITADEL_TRUST_TEST_ENV_DNE", required: true, secret: true }],
      stateDirs: [{ path: "cache", writeable: true }],
      declaredDependencies: { capabilities: ["network"] },
    });
    delete process.env.GOATCITADEL_TRUST_TEST_ENV_DNE;

    await registerTrustServices({
      tools: {
        listPermissionProfiles: vi.fn(() => []),
        listToolGrants: vi.fn(() => []),
        listActiveLocalOperatorOverrides: vi.fn(() => []),
      },
      capabilities: { listCapabilityCatalog: vi.fn(() => []) },
      mcp: { listMcpServers: vi.fn(() => []) },
      skills: {
        listSkills: vi.fn(() => [
          { skillId: "skill-bundle", name: "Bundle Skill", state: "enabled", callable: true, dir },
        ]),
      },
      addons: {
        listAddonsCatalog: vi.fn(() => []),
        listInstalledAddons: vi.fn(async () => []),
      },
    });

    const response = await app!.inject({ method: "GET", url: "/api/v1/trust/policy-snapshot" });

    expect(response.statusCode).toBe(200);
    const skill = response.json().skills[0];
    expect(skill.declaredMetadata.requiredEnv[0].name).toBe("GOATCITADEL_TRUST_TEST_ENV_DNE");
    expect(skill.missingRequiredEnv).toContain("GOATCITADEL_TRUST_TEST_ENV_DNE");
    expect(skill.bundleWarnings.some((warning: string) => warning.includes("secret env var"))).toBe(true);
    expect(skill.posture).toBe("medium_trust_unverified");
  });
});
