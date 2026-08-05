import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ConflictError } from "@goatcitadel/contracts";
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
    // HX-402 P2: state verbs answer with a pending skill.lifecycle approval.
    const setSkillState = vi.fn(() => ({
      pendingApproval: {
        approvalId: "11111111-2222-3333-4444-555555555555",
        status: "pending",
        kind: "skill.lifecycle",
        action: "skill_state_set",
        subjectKind: "skill",
        subjectId: "bundled:agentic-skill-architect",
        requestSha256: "a".repeat(64),
        expectedStateSha256: "b".repeat(64),
        createdAt: "2026-05-04T00:00:00.000Z",
        replayed: false,
        skillIds: ["bundled:agentic-skill-architect"],
      },
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
      payload: { skillId, state: "sleep", note: "review", expectedRevision: 7 },
    });

    expect(preview.statusCode).toBe(200);
    expect(run.statusCode).toBe(201);
    expect(list.statusCode).toBe(200);
    // Approval-first: the state verb answers 202 with the pending envelope.
    expect(state.statusCode).toBe(202);
    expect(state.json().pendingApproval).toMatchObject({ kind: "skill.lifecycle", action: "skill_state_set" });
    expect(previewSkillEvaluation).toHaveBeenCalledWith(skillId, {});
    expect(runSkillEvaluation).toHaveBeenCalledWith(skillId, {});
    expect(listSkillEvaluationRuns).toHaveBeenCalledWith(skillId);
    expect(setSkillState).toHaveBeenCalledWith(skillId, "sleep", "review", {
      expectedRevision: 7,
      requesterId: "ip:127.0.0.1",
    });
  });

  it("requires and forwards skill aggregate revisions and projects stale writes as 409 conflicts", async () => {
    const setSkillState = vi.fn(() => {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "runtime_skill skill-a changed since revision 2",
        details: {
          resourceKind: "runtime_skill",
          resourceId: "skill-a",
          expectedRevision: 2,
          currentRevision: 3,
        },
      });
    });
    const bulkSetSkillState = vi.fn(() => ({
      pendingApproval: null,
      noMutationRequired: true,
      skillStates: [],
    }));
    const updateSkillActivationPolicy = vi.fn(() => ({
      pendingApproval: null,
      noMutationRequired: true,
      policy: { revision: 5, guardedAutoThreshold: 0.8, requireFirstUseConfirmation: true },
    }));
    app = Fastify();
    app.decorate("services", {
      skills: { setSkillState, bulkSetSkillState, updateSkillActivationPolicy },
    } as never);
    await app.register(skillsRoutes);

    const missingRevision = await app.inject({
      method: "PATCH",
      url: "/api/v1/skills/by-id/state",
      payload: { skillId: "skill-a", state: "sleep" },
    });
    const stale = await app.inject({
      method: "PATCH",
      url: "/api/v1/skills/by-id/state",
      payload: { skillId: "skill-a", state: "sleep", expectedRevision: 2 },
    });
    const bulk = await app.inject({
      method: "POST",
      url: "/api/v1/skills/bulk-state",
      payload: {
        skillIds: ["skill-b", "skill-a"],
        state: "disabled",
        expectedRevisionsBySkillId: { "skill-a": 4, "skill-b": 9 },
      },
    });
    const policy = await app.inject({
      method: "PATCH",
      url: "/api/v1/skills/activation-policies",
      payload: { expectedRevision: 4, guardedAutoThreshold: 0.8 },
    });

    expect(missingRevision.statusCode).toBe(400);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      error: "runtime_skill skill-a changed since revision 2",
      code: "WRITE_CONFLICT",
      details: {
        resourceKind: "runtime_skill",
        resourceId: "skill-a",
        expectedRevision: 2,
        currentRevision: 3,
      },
    });
    expect(bulk.statusCode).toBe(200);
    expect(bulkSetSkillState).toHaveBeenCalledWith(["skill-b", "skill-a"], "disabled", undefined, {
      expectedRevisionsBySkillId: { "skill-a": 4, "skill-b": 9 },
      requesterId: "ip:127.0.0.1",
    });
    expect(policy.statusCode).toBe(200);
    expect(updateSkillActivationPolicy).toHaveBeenCalledWith(
      { guardedAutoThreshold: 0.8 },
      { expectedRevision: 4, requesterId: "ip:127.0.0.1" },
    );
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
      disposition: "redirected_to_skill_hub",
      validation: validationResult,
      redirect: {
        owner: "skill_hub",
        reviewRoute: "/api/v1/skills/hub/reviews",
        sourceRef: rawSourceUrl,
        sourceType: "git_url",
        eligible: true,
      },
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
    const listSkillImportHistory = vi.fn(async () => [historyRecord]);
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
    ]).toEqual([200, 200, 200, 200, 200]);
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
    const listSkills = vi.fn(async () => [
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

  it("awaits packaged skill exports before sending the response", async () => {
    const packageSkillExport = vi.fn(async () => ({
      packageId: "skill-package-1",
      target: "codex",
      files: [{ path: "skills/example/SKILL.md", content: "# Example" }],
    }));
    app = Fastify();
    app.decorate("services", { skills: { packageSkillExport } } as never);
    await app.register(skillsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/export/package",
      payload: { skillIds: ["skill-a"], target: "codex" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ packageId: "skill-package-1", target: "codex" });
  });

  it("scopes skills by workspace when ?workspaceId is provided", async () => {
    const effectiveSet = new Set(["skill-a"]);
    const resolveEffectiveSkills = vi.fn(() => effectiveSet);
    const listSkills = vi.fn(async (effective?: unknown) => {
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
    const listSkills = vi.fn(async (effective?: unknown) => {
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

  it("keeps Skill Hub provenance and lifecycle mutations operator-only with request-derived actors", async () => {
    const listSkillHub = vi.fn(async () => ({
      schemaVersion: "goatcitadel.skill-hub-operator.v1",
      workspaceId: "workspace-1",
      items: [],
    }));
    const createSkillHubApproval = vi.fn(async () => ({
      schemaVersion: "goatcitadel.skill-hub-operator.v1",
      reused: false,
      operatorMessage: "Approval created.",
      approval: {
        approvalId: "approval-1",
        operationId: "operation-1",
        operationKind: "install_inactive",
        status: "pending",
        createdAt: "2026-07-14T01:00:00.000Z",
      },
    }));
    const reviewSkillHubSource = vi.fn(async () => ({
      schemaVersion: "goatcitadel.skill-hub-review.v1",
      replayed: false,
      snapshot: { snapshotId: "snapshot-reviewed" },
      artifact: { artifactId: "artifact-reviewed" },
      journeyEvent: { eventId: "journey-reviewed" },
    }));
    const prepareSkillHubRollbackReview = vi.fn(async () => ({
      schemaVersion: "goatcitadel.skill-hub-review.v1",
      replayed: true,
      snapshot: { snapshotId: "snapshot-rollback" },
      artifact: { artifactId: "artifact-rollback" },
      journeyEvent: { eventId: "journey-rollback" },
    }));
    app = Fastify();
    app.decorateRequest("authActorId", "anonymous");
    app.decorateRequest("authActorSource", "none");
    app.addHook("onRequest", async (request) => {
      const rawSource = request.headers["x-test-auth-source"];
      const source = Array.isArray(rawSource) ? rawSource[0] : rawSource;
      if (source === "token" || source === "device" || source === "companion") {
        request.authActorSource = source;
      } else {
        request.authActorSource = "none";
      }
      const rawActor = request.headers["x-test-auth-actor"];
      const actor = Array.isArray(rawActor) ? rawActor[0] : rawActor;
      request.authActorId = typeof actor === "string" && actor.trim() ? actor.trim() : "anonymous";
    });
    app.decorate(
      "requireOperatorAuth",
      vi.fn(async (request: FastifyRequest, reply: FastifyReply) => {
        if (["token", "basic", "loopback"].includes(request.authActorSource)) return;
        return reply.code(403).send({ error: "Operator authentication is required." });
      }) as never,
    );
    app.decorate("services", {
      skills: {
        listSkillHub,
        createSkillHubApproval,
        reviewSkillHubSource,
        prepareSkillHubRollbackReview,
      },
    } as never);
    await app.register(skillsRoutes);

    for (const source of [undefined, "device", "companion"]) {
      const headers = source ? { "x-test-auth-source": source } : {};
      const listResponse = await app.inject({
        method: "GET",
        url: "/api/v1/skills/hub?workspaceId=workspace-1",
        headers,
      });
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/skills/hub/operations",
        headers,
        payload: {
          workspaceId: "workspace-1",
          snapshotId: "snapshot-1",
          operationKind: "install_inactive",
        },
      });
      const reviewResponse = await app.inject({
        method: "POST",
        url: "/api/v1/skills/hub/reviews",
        headers,
        payload: {
          workspaceId: "workspace-1",
          sourceRef: "https://github.com/example/review-skill.git",
          sourceType: "git_url",
          idempotencyKey: "review-1",
        },
      });
      const rollbackResponse = await app.inject({
        method: "POST",
        url: "/api/v1/skills/hub/rollback-reviews",
        headers,
        payload: {
          workspaceId: "workspace-1",
          snapshotId: "snapshot-1",
          idempotencyKey: "rollback-1",
        },
      });
      expect([
        listResponse.statusCode,
        createResponse.statusCode,
        reviewResponse.statusCode,
        rollbackResponse.statusCode,
      ]).toEqual([403, 403, 403, 403]);
    }
    expect(listSkillHub).not.toHaveBeenCalled();
    expect(createSkillHubApproval).not.toHaveBeenCalled();
    expect(reviewSkillHubSource).not.toHaveBeenCalled();
    expect(prepareSkillHubRollbackReview).not.toHaveBeenCalled();

    const operatorHeaders = {
      "x-test-auth-source": "token",
      "x-test-auth-actor": "operator:request-derived",
    };
    const listResponse = await app.inject({
      method: "GET",
      url: "/api/v1/skills/hub?workspaceId=workspace-1",
      headers: operatorHeaders,
    });
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/skills/hub/operations",
      headers: operatorHeaders,
      payload: {
        workspaceId: "workspace-1",
        snapshotId: "snapshot-1",
        operationKind: "install_inactive",
        actorId: "operator:body-forgery",
      },
    });
    const reviewResponse = await app.inject({
      method: "POST",
      url: "/api/v1/skills/hub/reviews",
      headers: operatorHeaders,
      payload: {
        workspaceId: "workspace-1",
        sourceRef: "https://github.com/example/review-skill.git",
        sourceType: "git_url",
        idempotencyKey: "review-1",
      },
    });
    const rollbackResponse = await app.inject({
      method: "POST",
      url: "/api/v1/skills/hub/rollback-reviews",
      headers: operatorHeaders,
      payload: {
        workspaceId: "workspace-1",
        snapshotId: "snapshot-1",
        idempotencyKey: "rollback-1",
      },
    });

    expect([
      listResponse.statusCode,
      createResponse.statusCode,
      reviewResponse.statusCode,
      rollbackResponse.statusCode,
    ]).toEqual([200, 201, 201, 200]);
    expect(listResponse.headers["cache-control"]).toBe("no-store");
    expect(createResponse.headers["cache-control"]).toBe("no-store");
    expect(reviewResponse.headers["cache-control"]).toBe("no-store");
    expect(rollbackResponse.headers["cache-control"]).toBe("no-store");
    expect(listResponse.json()).toMatchObject({
      schemaVersion: "goatcitadel.skill-hub-operator.v1",
      workspaceId: "workspace-1",
      items: [],
    });
    expect(listSkillHub).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
    expect(createSkillHubApproval).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      snapshotId: "snapshot-1",
      operationKind: "install_inactive",
      actorId: "operator:request-derived",
    });
    expect(reviewSkillHubSource).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceRef: "https://github.com/example/review-skill.git",
      sourceType: "git_url",
      idempotencyKey: "review-1",
      actorId: "operator:request-derived",
    });
    expect(prepareSkillHubRollbackReview).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      snapshotId: "snapshot-1",
      idempotencyKey: "rollback-1",
      actorId: "operator:request-derived",
    });

    const forgedReviewResponse = await app.inject({
      method: "POST",
      url: "/api/v1/skills/hub/reviews",
      headers: operatorHeaders,
      payload: {
        workspaceId: "workspace-1",
        sourceRef: "https://github.com/example/review-skill.git",
        sourceType: "git_url",
        idempotencyKey: "review-forged",
        actorId: "operator:body-forgery",
        trustDisposition: "candidate",
      },
    });
    expect(forgedReviewResponse.statusCode).toBe(400);
    expect(reviewSkillHubSource).toHaveBeenCalledTimes(1);

    const orphanedTurnResponse = await app.inject({
      method: "POST",
      url: "/api/v1/skills/hub/operations",
      headers: operatorHeaders,
      payload: {
        workspaceId: "workspace-1",
        snapshotId: "snapshot-1",
        operationKind: "install_inactive",
        turnId: "turn-orphaned",
      },
    });
    expect(orphanedTurnResponse.statusCode).toBe(400);
    expect(orphanedTurnResponse.json()).toMatchObject({
      error: { fieldErrors: { turnId: ["Skill Hub turn lineage requires a session ID."] } },
    });
    expect(createSkillHubApproval).toHaveBeenCalledTimes(1);
  });
});
