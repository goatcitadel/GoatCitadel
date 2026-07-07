import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { memoryRoutes } from "./memory.js";

describe("memory routes", () => {
  let app: FastifyInstance | null = null;

  function buildApp(gateway: Record<string, unknown>, requireOperatorAuth = vi.fn(async () => undefined)) {
    const built = Fastify();
    built.decorate("requireOperatorAuth", requireOperatorAuth as never);
    built.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "none",
        },
      },
    } as never);
    built.decorate("services", {
      memory: {
        ...gateway,
        forget: gateway.forget ?? gateway.forgetMemory,
        runMaintenanceNow: gateway.runMaintenanceNow ?? gateway.runMemoryMaintenanceNow,
        getContext: gateway.getContext ?? gateway.getMemoryContext,
      },
    } as never);
    return { app: built, requireOperatorAuth };
  }

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("defaults the item-list status to active so forgotten content is not returned by default", async () => {
    const listItems = vi.fn(() => []);
    const built = buildApp({ listItems });
    app = built.app;
    await app.register(memoryRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/memory/items" });

    expect(response.statusCode).toBe(200);
    expect(listItems).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
  });

  it("rejects bulk forget without any criteria", async () => {
    const forgetMemory = vi.fn();
    const built = buildApp({
      forgetMemory,
    });
    app = built.app;
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(forgetMemory).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      error: {
        fieldErrors: {
          itemIds: expect.arrayContaining(["Provide at least one criterion: itemIds, namespace, or query."]),
        },
      },
    });
    expect(response.json()).not.toMatchObject({
      error: {
        formErrors: expect.arrayContaining(["Provide at least one criterion: itemIds, namespace, or query."]),
      },
    });
  });

  it("forgets matching memory rows when criteria are provided", async () => {
    const forgetMemory = vi.fn(() => ({
      forgottenCount: 1,
      itemIds: ["mem_1"],
    }));
    const built = buildApp({
      forgetMemory,
    });
    app = built.app;
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      payload: {
        namespace: "project.alpha",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(forgetMemory).toHaveBeenCalledTimes(1);
    expect(forgetMemory).toHaveBeenCalledWith({
      itemIds: undefined,
      namespace: "project.alpha",
      query: undefined,
      actorId: expect.stringMatching(/^ip:/),
    });
    expect(response.json()).toEqual({
      forgottenCount: 1,
      itemIds: ["mem_1"],
    });
    expect(built.requireOperatorAuth).toHaveBeenCalledTimes(1);
  });

  it("routes atomic memory item batch mutations through the memory service", async () => {
    const batchMutateItems = vi.fn(() => ({
      actionId: "batch-1",
      status: "applied",
      appliedCount: 2,
      targetItemIds: ["mem-1", "mem-2"],
      results: [],
      ledger: {
        actionId: "batch-1",
        ownerId: "operator",
        source: "route-test",
        timestamp: "2026-06-20T00:00:00.000Z",
        status: "applied",
        targetItemIds: ["mem-1", "mem-2"],
        operationKind: "mixed",
        operationCount: 2,
        reversal: { feasible: true, note: "reverse" },
        reapply: { feasible: false, note: "reapply" },
        evidence: { storesRawContent: false, redactionNote: "raw content excluded" },
      },
    }));
    const built = buildApp({
      batchMutateItems,
    });
    app = built.app;
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/items/batch-mutate",
      payload: {
        actionId: "batch-1",
        source: "route-test",
        operations: [
          {
            kind: "patch_item",
            itemId: "mem-1",
            patch: {
              title: "Updated title",
              pinned: true,
            },
          },
          {
            kind: "forget_item",
            itemId: "mem-2",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      actionId: "batch-1",
      ledger: {
        evidence: { storesRawContent: false },
      },
    });
    expect(batchMutateItems).toHaveBeenCalledWith(
      {
        actionId: "batch-1",
        source: "route-test",
        operations: [
          {
            kind: "patch_item",
            itemId: "mem-1",
            patch: {
              title: "Updated title",
              pinned: true,
            },
          },
          {
            kind: "forget_item",
            itemId: "mem-2",
          },
        ],
      },
      expect.stringMatching(/^ip:/),
    );
    expect(built.requireOperatorAuth).toHaveBeenCalledTimes(1);
  });

  it("validates memory context route params", async () => {
    const getMemoryContext = vi.fn(() => ({ contextId: "ctx-1", scope: "chat" }));
    app = Fastify();
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "none",
        },
      },
    } as never);
    app.decorate("services", {
      memory: {
        getContext: getMemoryContext,
      },
    } as never);
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/memory/context/",
    });
    expect(response.statusCode).toBe(400);

    const malformed = await app.inject({
      method: "GET",
      url: "/api/v1/memory/context/%20",
    });
    expect(malformed.statusCode).toBe(400);
    expect(getMemoryContext).not.toHaveBeenCalled();

    const valid = await app.inject({
      method: "GET",
      url: "/api/v1/memory/context/ctx-1",
    });
    expect(valid.statusCode).toBe(200);
    expect(getMemoryContext).toHaveBeenCalledWith("ctx-1");
  });

  it("passes explicit memory relation scope through context composition", async () => {
    const composeContext = vi.fn((input) => ({
      contextId: "ctx-compose",
      scope: input.scope,
      relationScope: input.relationScope,
    }));
    const built = buildApp({ composeContext });
    app = built.app;
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/context/compose",
      payload: {
        scope: "chat",
        prompt: "Find browser governance memory.",
        relationScope: "project",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(composeContext).toHaveBeenCalledWith({
      scope: "chat",
      prompt: "Find browser governance memory.",
      relationScope: "project",
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/memory/context/compose",
      payload: {
        scope: "chat",
        prompt: "Find browser governance memory.",
        relationScope: "global",
      },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("returns additive memory retrieval status truth", async () => {
    const getRetrievalStatus = vi.fn(() => ({
      checkedAt: "2026-06-06T12:00:00.000Z",
      enabled: true,
      retrievalMode: "hybrid_rank",
      rerankAvailable: true,
      rerankMode: "hybrid_rank",
      fallbackMode: "available",
      lastRefresh: "2026-06-06T11:59:00.000Z",
      qmd: {
        enabled: true,
        applyToChat: true,
        applyToOrchestration: true,
        minPromptChars: 12,
        cacheTtlSeconds: 300,
        distillerTimeoutMs: 12_000,
      },
      recent: {
        totalRuns: 3,
        generatedRuns: 1,
        cacheHitRuns: 1,
        fallbackRuns: 1,
        failedRuns: 0,
        retrievalStrategies: ["hybrid_rank"],
      },
    }));
    const built = buildApp({ getRetrievalStatus });
    app = built.app;
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/memory/retrieval/status",
    });

    expect(response.statusCode).toBe(200);
    expect(getRetrievalStatus).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({
      retrievalMode: "hybrid_rank",
      rerankAvailable: true,
      fallbackMode: "available",
      recent: {
        retrievalStrategies: ["hybrid_rank"],
      },
    });
  });

  it("routes explicit recall, feedback, and trace-memory candidate flows through the memory service", async () => {
    const recall = vi.fn(async () => ({ mode: "summary", feedback: [], traceCandidates: [] }));
    const listFeedback = vi.fn(() => [{ feedbackId: "fb-1" }]);
    const recordFeedback = vi.fn(() => ({ feedbackId: "fb-2" }));
    const listQualityIssues = vi.fn(() => [{ issueId: "quality-1" }]);
    const runQualityScan = vi.fn(() => ({ issueCount: 1, issues: [{ issueId: "quality-1" }] }));
    const patchQualityIssue = vi.fn(() => ({ issueId: "quality-1", status: "resolved" }));
    const listTraceCandidates = vi.fn(() => [{ candidateId: "trace-1" }]);
    const proposeTraceCandidate = vi.fn(() => ({ candidateId: "trace-2", status: "proposed" }));
    const promoteTraceCandidate = vi.fn(() => ({ learningId: "learn-1" }));
    const built = buildApp({
      recall,
      listFeedback,
      recordFeedback,
      listQualityIssues,
      runQualityScan,
      patchQualityIssue,
      listTraceCandidates,
      proposeTraceCandidate,
      promoteTraceCandidate,
    });
    app = built.app;
    await app.register(memoryRoutes);

    const recallResponse = await app.inject({
      method: "POST",
      url: "/api/v1/memory/recall",
      payload: {
        mode: "summary",
        workspaceId: "default",
      },
    });
    const feedbackResponse = await app.inject({
      method: "POST",
      url: "/api/v1/memory/feedback",
      payload: {
        kind: "useful",
        targetKind: "citation",
        targetRef: "mem-1",
      },
    });
    const feedbackListResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memory/feedback?status=open",
    });
    const qualityScanResponse = await app.inject({
      method: "POST",
      url: "/api/v1/memory/quality/scan",
      payload: {
        workspaceId: "default",
        dryRun: true,
      },
    });
    const qualityListResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memory/quality/issues?status=open&kind=source_drift",
    });
    const qualityPatchResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/memory/quality/issues/quality-1",
      payload: {
        status: "resolved",
        resolutionNote: "Checked by route test.",
      },
    });
    const candidateResponse = await app.inject({
      method: "POST",
      url: "/api/v1/memory/trace-candidates",
      payload: {
        candidateType: "tool_outcome",
        sourceText: "Tool outcome summary.",
        proposedInsight: "Tool outcome summary is useful.",
      },
    });
    const candidateListResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memory/trace-candidates",
    });
    const promoteResponse = await app.inject({
      method: "POST",
      url: "/api/v1/memory/trace-candidates/trace-2/promote",
    });

    expect(recallResponse.statusCode).toBe(200);
    expect(feedbackResponse.statusCode).toBe(201);
    expect(feedbackListResponse.statusCode).toBe(200);
    expect(qualityScanResponse.statusCode).toBe(200);
    expect(qualityListResponse.statusCode).toBe(200);
    expect(qualityPatchResponse.statusCode).toBe(200);
    expect(candidateResponse.statusCode).toBe(202);
    expect(candidateListResponse.statusCode).toBe(200);
    expect(promoteResponse.statusCode).toBe(200);
    expect(recall).toHaveBeenCalledWith({ mode: "summary", workspaceId: "default" });
    expect(listFeedback).toHaveBeenCalledWith({ limit: 100, status: "open" });
    expect(runQualityScan).toHaveBeenCalledWith(
      {
        workspaceId: "default",
        dryRun: true,
      },
      expect.stringMatching(/^ip:/),
    );
    expect(listQualityIssues).toHaveBeenCalledWith({ limit: 100, status: "open", kind: "source_drift" });
    expect(patchQualityIssue).toHaveBeenCalledWith(
      "quality-1",
      {
        status: "resolved",
        resolutionNote: "Checked by route test.",
      },
      expect.stringMatching(/^ip:/),
    );
    expect(recordFeedback).toHaveBeenCalledWith(
      {
        kind: "useful",
        targetKind: "citation",
        targetRef: "mem-1",
      },
      expect.stringMatching(/^ip:/),
    );
    expect(listTraceCandidates).toHaveBeenCalledWith({ limit: 100 });
    expect(proposeTraceCandidate).toHaveBeenCalledWith(
      {
        candidateType: "tool_outcome",
        sourceText: "Tool outcome summary.",
        proposedInsight: "Tool outcome summary is useful.",
      },
      expect.stringMatching(/^ip:/),
    );
    expect(promoteTraceCandidate).toHaveBeenCalledWith("trace-2", expect.stringMatching(/^ip:/));
  });

  it("accepts memory maintenance run-now on both the canonical and compatibility paths", async () => {
    const runMemoryMaintenanceNow = vi.fn(() => ({
      runId: "mmrun_123",
      workspaceId: "default",
      triggerSource: "manual",
      status: "queued",
    }));
    const built = buildApp({
      runMemoryMaintenanceNow,
    });
    app = built.app;
    await app.register(memoryRoutes);

    const canonical = await app.inject({
      method: "POST",
      url: "/api/v1/memory/maintenance/run-now",
      payload: {
        workspaceId: "default",
        triggerSource: "manual",
      },
    });
    const compatibility = await app.inject({
      method: "POST",
      url: "/api/v1/memory/maintenance/run",
      payload: {
        workspaceId: "default",
      },
    });

    expect(canonical.statusCode).toBe(200);
    expect(compatibility.statusCode).toBe(200);
    expect(runMemoryMaintenanceNow).toHaveBeenNthCalledWith(1, {
      workspaceId: "default",
      triggerSource: "manual",
    });
    expect(runMemoryMaintenanceNow).toHaveBeenNthCalledWith(2, {
      workspaceId: "default",
    });
    expect(built.requireOperatorAuth).toHaveBeenCalledTimes(2);
  });
});
