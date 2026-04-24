import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { skillsRoutes } from "./skills.js";

describe("skills routes bankr migration", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns 410 migration guidance when Bankr built-in is disabled", async () => {
    app = Fastify();
    app.decorate("services", {
      skills: {
        isBankrBuiltinEnabled: vi.fn(() => false),
        getBankrOptionalMigrationMessage: vi.fn(() => "Bankr built-in is disabled. Install optional skill."),
      },
    } as never);
    await app.register(skillsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/skills/bankr/policy",
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({
      code: "bankr_builtin_disabled",
      docsPath: "docs/OPTIONAL_BANKR_SKILL.md",
      templatePath: "templates/skills/bankr-optional/SKILL.md",
    });
  });

  it("delegates to gateway Bankr handlers when built-in feature is enabled", async () => {
    const getPolicy = vi.fn(() => ({
      enabled: true,
      mode: "read_only",
      dailyUsdCap: 100,
      perActionUsdCap: 25,
      requireApprovalEveryWrite: true,
      allowedChains: ["base"],
      allowedActionTypes: ["read"],
      blockedSymbols: [],
    }));

    app = Fastify();
    app.decorate("services", {
      skills: {
        isBankrBuiltinEnabled: vi.fn(() => true),
        getBankrOptionalMigrationMessage: vi.fn(() => ""),
        getBankrSafetyPolicy: getPolicy,
      },
    } as never);
    await app.register(skillsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/skills/bankr/policy",
    });

    expect(response.statusCode).toBe(200);
    expect(getPolicy).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({
      enabled: true,
      mode: "read_only",
    });
  });

  it("delegates skill lookup queries to the gateway", async () => {
    const lookup = vi.fn(async () => ({
      query: "notebooklm",
      generatedAt: new Date().toISOString(),
      providers: [],
      bestMatch: {
        canonicalKey: "github.com/example/notebooklm-skill",
        sourceProvider: "skillsmp",
        sourceUrl: "https://skillsmp.com/skills/example-notebooklm-skill",
        upstreamUrl: "https://github.com/example/notebooklm-skill",
        name: "NotebookLM Skill",
        description: "NotebookLM lookup",
        tags: ["notebooklm", "research"],
        alternateProviders: [],
        qualityScore: 0.8,
        freshnessScore: 0.7,
        trustScore: 0.7,
        combinedScore: 0.9,
        sourceKind: "marketplace_listing",
        installability: "review_only",
        matchReason: "Direct listing match",
      },
      items: [],
    }));

    app = Fastify();
    app.decorate("services", {
      skills: {
        isBankrBuiltinEnabled: vi.fn(() => true),
        getBankrOptionalMigrationMessage: vi.fn(() => ""),
        lookupSkillSources: lookup,
      },
    } as never);
    await app.register(skillsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/skills/lookup?q=notebooklm",
    });

    expect(response.statusCode).toBe(200);
    expect(lookup).toHaveBeenCalledWith("notebooklm", undefined);
    expect(response.json()).toMatchObject({
      query: "notebooklm",
      bestMatch: {
        name: "NotebookLM Skill",
        matchReason: "Direct listing match",
      },
    });
  });
});
