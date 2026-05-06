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

  it("previews and stores skill evaluation runs through the skill route service", async () => {
    const previewSkillEvaluation = vi.fn(() => ({
      run: {
        runId: "skill-eval-1",
        skillId: "skill-1",
        skillName: "Skill",
        status: "preview",
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
        scenarios: [],
        criteria: [],
        baselineResult: { score: { total: 0, passed: 0, passRate: 0 }, scenarioResults: [], instructionHash: "" },
        accepted: false,
        improvementDelta: 0,
        targetPassRate: 0.85,
        maxRounds: 3,
        warnings: [],
        operatorTruth: { executesScripts: false, writesSkillFile: false, proposalOnly: true },
      },
    }));
    const runSkillEvaluation = vi.fn(() => ({
      run: {
        runId: "skill-eval-2",
        skillId: "skill-1",
        skillName: "Skill",
        status: "completed",
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
        scenarios: [],
        criteria: [],
        baselineResult: { score: { total: 1, passed: 0, passRate: 0 }, scenarioResults: [], instructionHash: "" },
        candidateResult: { score: { total: 1, passed: 1, passRate: 1 }, scenarioResults: [], instructionHash: "" },
        accepted: true,
        improvementDelta: 1,
        targetPassRate: 0.85,
        maxRounds: 3,
        warnings: [],
        operatorTruth: { executesScripts: false, writesSkillFile: false, proposalOnly: true },
      },
    }));

    app = Fastify();
    app.decorate("services", {
      skills: {
        isBankrBuiltinEnabled: vi.fn(() => true),
        getBankrOptionalMigrationMessage: vi.fn(() => ""),
        previewSkillEvaluation,
        runSkillEvaluation,
      },
    } as never);
    await app.register(skillsRoutes);

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/skills/skill-1/evaluations/preview",
      payload: {
        scenarios: [{ title: "A", prompt: "B", expectedOutcome: "C" }],
        criteria: [{ label: "Pass", description: "Must pass" }],
      },
    });
    const run = await app.inject({
      method: "POST",
      url: "/api/v1/skills/skill-1/evaluations/run",
      payload: {},
    });

    expect(preview.statusCode).toBe(200);
    expect(previewSkillEvaluation).toHaveBeenCalledWith(
      "skill-1",
      expect.objectContaining({
        scenarios: [{ title: "A", prompt: "B", expectedOutcome: "C" }],
      }),
    );
    expect(run.statusCode).toBe(201);
    expect(runSkillEvaluation).toHaveBeenCalledWith("skill-1", {});
    expect(run.json().run).toMatchObject({ status: "completed", accepted: true });
  });

  it("supports path-safe skill id routes for source-qualified skills", async () => {
    const previewSkillEvaluation = vi.fn(() => ({
      run: { runId: "skill-eval-1", skillId: "bundled:agentic-skill-architect", status: "preview" },
    }));
    const runSkillEvaluation = vi.fn(() => ({
      run: { runId: "skill-eval-2", skillId: "bundled:agentic-skill-architect", status: "completed" },
    }));
    const listSkillEvaluationRuns = vi.fn(() => ({ items: [] }));
    const setSkillState = vi.fn(() => ({
      skillId: "bundled:agentic-skill-architect",
      state: "sleep",
      note: "review",
      updatedAt: "2026-05-04T00:00:00.000Z",
    }));

    app = Fastify();
    app.decorate("services", {
      skills: {
        isBankrBuiltinEnabled: vi.fn(() => true),
        getBankrOptionalMigrationMessage: vi.fn(() => ""),
        previewSkillEvaluation,
        runSkillEvaluation,
        listSkillEvaluationRuns,
        setSkillState,
      },
    } as never);
    await app.register(skillsRoutes);

    const skillId = "bundled:agentic-skill-architect";
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/skills/by-id/evaluations/preview",
      payload: { skillId },
    });
    const run = await app.inject({
      method: "POST",
      url: "/api/v1/skills/by-id/evaluations/run",
      payload: { skillId },
    });
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/skills/by-id/evaluations?skillId=${encodeURIComponent(skillId)}`,
    });
    const state = await app.inject({
      method: "PATCH",
      url: "/api/v1/skills/by-id/state",
      payload: { skillId, state: "sleep", note: "review" },
    });

    expect(preview.statusCode).toBe(200);
    expect(run.statusCode).toBe(201);
    expect(list.statusCode).toBe(200);
    expect(state.statusCode).toBe(200);
    expect(previewSkillEvaluation).toHaveBeenCalledWith(skillId, {});
    expect(runSkillEvaluation).toHaveBeenCalledWith(skillId, {});
    expect(listSkillEvaluationRuns).toHaveBeenCalledWith(skillId);
    expect(setSkillState).toHaveBeenCalledWith(skillId, "sleep", "review");
  });

  it("creates skill evaluation proposals from accepted runs", async () => {
    const createSkillEvaluationProposal = vi.fn(() => ({
      run: { runId: "skill-eval-1", status: "proposal_created" },
      proposal: { proposalId: "proposal-1", status: "proposed" },
    }));
    app = Fastify();
    app.decorate("services", {
      skills: {
        isBankrBuiltinEnabled: vi.fn(() => true),
        getBankrOptionalMigrationMessage: vi.fn(() => ""),
        createSkillEvaluationProposal,
      },
    } as never);
    await app.register(skillsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/evaluations/skill-eval-1/proposal",
      payload: {},
    });

    expect(response.statusCode).toBe(201);
    expect(createSkillEvaluationProposal).toHaveBeenCalledWith("skill-eval-1");
    expect(response.json()).toMatchObject({ proposal: { proposalId: "proposal-1" } });
  });
});
