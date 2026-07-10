import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { skillsRoutes } from "./skills.js";

describe("skills routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
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

  it("rejects a leading-dash git_url source ref before reaching the service", async () => {
    const validateSkillImport = vi.fn();
    app = Fastify();
    app.decorate("services", { skills: { validateSkillImport } } as never);
    await app.register(skillsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/import/validate",
      payload: { sourceRef: "--upload-pack=x", sourceType: "git_url" },
    });

    expect(response.statusCode).toBe(400);
    expect(validateSkillImport).not.toHaveBeenCalled();
  });

  it("accepts an ordinary git_url source ref through the validate route", async () => {
    const validateSkillImport = vi.fn(async () => ({ valid: true }));
    app = Fastify();
    app.decorate("services", { skills: { validateSkillImport } } as never);
    await app.register(skillsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/import/validate",
      payload: { sourceRef: "https://github.com/owner/repo.git", sourceType: "git_url" },
    });

    expect(response.statusCode).toBe(200);
    expect(validateSkillImport).toHaveBeenCalledWith({
      sourceRef: "https://github.com/owner/repo.git",
      sourceType: "git_url",
    });
  });

  it("projects import provenance URLs across source and import responses while preserving raw inputs and prose", async () => {
    const rawSourceUrl =
      "https://skill-user:skill-provenance-secret@example.test/private-skill.git?token=skill-provenance-secret";
    const skillMarkdown = [
      "---",
      "name: Private Skill",
      "---",
      "",
      "Operator-authored example: Authorization: Bearer prose-must-remain-byte-identical",
    ].join("\n");
    const candidate = {
      canonicalKey: "example.test/private-skill",
      sourceProvider: "github",
      sourceType: "git_url",
      sourceRef: rawSourceUrl,
      sourceUrl: rawSourceUrl,
      repositoryUrl: rawSourceUrl,
      skillMarkdown,
    };
    const sourceItem = {
      sourceProvider: "github",
      sourceUrl: rawSourceUrl,
      repositoryUrl: rawSourceUrl,
      upstreamUrl: rawSourceUrl,
      name: "Private Skill",
      description: skillMarkdown,
      tags: ["private"],
      sourceKind: "upstream_repo",
      installability: "direct",
      matchReason: "Direct source match",
      matchedTerms: [rawSourceUrl],
    };
    const sourcesResult = {
      query: rawSourceUrl,
      generatedAt: "2026-07-09T12:00:00.000Z",
      providers: [],
      items: [sourceItem],
    };
    const lookupResult = {
      query: rawSourceUrl,
      generatedAt: "2026-07-09T12:00:00.000Z",
      providers: [],
      parsedSource: {
        sourceProvider: "github",
        sourceKind: "upstream_repo",
        sourceUrl: rawSourceUrl,
        repositoryUrl: rawSourceUrl,
        installability: "direct",
      },
      bestMatch: sourceItem,
      items: [sourceItem],
    };
    const validationResult = {
      valid: true,
      candidate,
      provenance: {
        sourceProvider: "github",
        sourceType: "git_url",
        sourceRef: rawSourceUrl,
        sourceUrl: rawSourceUrl,
        repositoryUrl: rawSourceUrl,
        capturedAt: "2026-07-09T12:00:00.000Z",
        nonCallableUntilActivated: true,
      },
      instructionPreview: skillMarkdown,
    };
    const installResult = {
      validation: validationResult,
      installedPath: "skills/extra/private-skill",
      sourceManifestPath: "skills/extra/private-skill/source.json",
    };
    const historyRecord = {
      importId: "history-private",
      action: "install",
      outcome: "accepted",
      sourceProvider: "github",
      sourceRef: rawSourceUrl,
      sourceType: "git_url",
      canonicalKey: "example.test/private-skill",
      details: {
        provenance: validationResult.provenance,
        operatorNote: skillMarkdown,
      },
      createdAt: "2026-07-09T12:00:00.000Z",
    };
    const listSkillSources = vi.fn(async () => sourcesResult);
    const lookupSkillSources = vi.fn(async () => lookupResult);
    const validateSkillImport = vi.fn(async () => validationResult);
    const installSkillImport = vi.fn(async () => installResult);
    const listSkillImportHistory = vi.fn(() => [historyRecord]);
    app = Fastify();
    app.decorate("services", {
      skills: {
        listSkillSources,
        lookupSkillSources,
        validateSkillImport,
        installSkillImport,
        listSkillImportHistory,
      },
    } as never);
    await app.register(skillsRoutes);

    const encodedSourceUrl = encodeURIComponent(rawSourceUrl);
    const sourcesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/skills/sources?q=${encodedSourceUrl}`,
    });
    const lookupResponse = await app.inject({
      method: "GET",
      url: `/api/v1/skills/lookup?q=${encodedSourceUrl}`,
    });
    const validateResponse = await app.inject({
      method: "POST",
      url: "/api/v1/skills/import/validate",
      payload: { sourceRef: rawSourceUrl, sourceType: "git_url" },
    });
    const installResponse = await app.inject({
      method: "POST",
      url: "/api/v1/skills/import/install",
      payload: { sourceRef: rawSourceUrl, sourceType: "git_url" },
    });
    const historyResponse = await app.inject({ method: "GET", url: "/api/v1/skills/import/history" });

    expect(listSkillSources).toHaveBeenCalledWith(rawSourceUrl, undefined);
    expect(lookupSkillSources).toHaveBeenCalledWith(rawSourceUrl, undefined);
    expect(validateSkillImport).toHaveBeenCalledWith({ sourceRef: rawSourceUrl, sourceType: "git_url" });
    expect(installSkillImport).toHaveBeenCalledWith({ sourceRef: rawSourceUrl, sourceType: "git_url" });
    expect([
      sourcesResponse.statusCode,
      lookupResponse.statusCode,
      validateResponse.statusCode,
      installResponse.statusCode,
      historyResponse.statusCode,
    ]).toEqual([200, 200, 200, 201, 200]);
    const publicBodies = [
      sourcesResponse.json(),
      lookupResponse.json(),
      validateResponse.json(),
      installResponse.json(),
      historyResponse.json(),
    ];
    for (const body of publicBodies) {
      expect(JSON.stringify(body)).not.toContain("skill-provenance-secret");
      expect(JSON.stringify(body)).toContain("[REDACTED]");
    }
    expect(sourcesResponse.json().items[0].description).toBe(skillMarkdown);
    expect(validateResponse.json().instructionPreview).toBe(skillMarkdown);
    expect(installResponse.json().validation.instructionPreview).toBe(skillMarkdown);
    expect(historyResponse.json().items[0].details.operatorNote).toBe(skillMarkdown);

    expect(candidate.sourceRef).toBe(rawSourceUrl);
    expect(validationResult.provenance.sourceRef).toBe(rawSourceUrl);
    expect(historyRecord.sourceRef).toBe(rawSourceUrl);
    expect(skillMarkdown).toContain("prose-must-remain-byte-identical");
  });

  it("returns all skills when no workspaceId is provided (non-breaking default)", async () => {
    const listSkills = vi.fn(() => [
      { skillId: "skill-a", name: "Skill A" },
      { skillId: "skill-b", name: "Skill B" },
    ]);

    app = Fastify();
    app.decorate("services", {
      skills: { listSkills },
      capabilityScope: {},
    } as never);
    await app.register(skillsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/skills" });

    expect(response.statusCode).toBe(200);
    // no workspaceId → listSkills called with no args (uses service default "ALL")
    expect(listSkills).toHaveBeenCalledWith();
    expect(response.json().items).toHaveLength(2);
  });

  it("scopes skills by workspace when ?workspaceId is provided", async () => {
    const effectiveSet = new Set(["skill-a"]);
    const resolveEffectiveSkills = vi.fn(() => effectiveSet);
    const listSkills = vi.fn((effective?: unknown) => {
      if (effective instanceof Set) {
        return [{ skillId: "skill-a", name: "Skill A" }];
      }
      return [
        { skillId: "skill-a", name: "Skill A" },
        { skillId: "skill-b", name: "Skill B" },
      ];
    });

    app = Fastify();
    app.decorate("services", {
      skills: { listSkills },
      capabilityScope: { resolveEffectiveSkills },
    } as never);
    await app.register(skillsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/skills?workspaceId=ws-scoped",
    });

    expect(response.statusCode).toBe(200);
    expect(resolveEffectiveSkills).toHaveBeenCalledWith("ws-scoped");
    expect(listSkills).toHaveBeenCalledWith(effectiveSet);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0].skillId).toBe("skill-a");
  });

  it("resolves the effective set per workspace and does not bleed across calls", async () => {
    const resolveEffectiveSkillsForA = new Set(["skill-a"]);
    const resolveEffectiveSkillsForB = new Set(["skill-b"]);
    const resolveEffectiveSkills = vi.fn((workspaceId: string) =>
      workspaceId === "ws-a" ? resolveEffectiveSkillsForA : resolveEffectiveSkillsForB,
    );
    const listSkills = vi.fn((effective?: unknown) => {
      if (effective === resolveEffectiveSkillsForA) return [{ skillId: "skill-a", name: "A" }];
      if (effective === resolveEffectiveSkillsForB) return [{ skillId: "skill-b", name: "B" }];
      return [];
    });

    app = Fastify();
    app.decorate("services", {
      skills: { listSkills },
      capabilityScope: { resolveEffectiveSkills },
    } as never);
    await app.register(skillsRoutes);

    const resA = await app.inject({ method: "GET", url: "/api/v1/skills?workspaceId=ws-a" });
    const resB = await app.inject({ method: "GET", url: "/api/v1/skills?workspaceId=ws-b" });

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    expect(resA.json().items[0].skillId).toBe("skill-a");
    expect(resB.json().items[0].skillId).toBe("skill-b");
  });
});
