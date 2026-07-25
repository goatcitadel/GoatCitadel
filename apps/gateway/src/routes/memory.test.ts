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
        runMaintenanceNow: gateway.runMaintenanceNow ?? gateway.runMemoryMaintenanceNow,
        getContext: gateway.getContext ?? gateway.getMemoryContext,
      },
    } as never);
    return { app: built, requireOperatorAuth };
  }

  // HX-402 P1: mutation verbs answer with a pending memory.lifecycle approval.
  const pendingApprovalFixture = (overrides: Record<string, unknown> = {}) => ({
    approvalId: "11111111-2222-3333-4444-555555555555",
    status: "pending",
    kind: "memory.lifecycle",
    action: "items_forgotten",
    subjectKind: "memory_item",
    subjectId: "memory-1",
    workspaceId: "workspace-a",
    requestSha256: "a".repeat(64),
    expectedStateSha256: "b".repeat(64),
    createdAt: "2026-07-22T00:00:00.000Z",
    replayed: false,
    itemIds: ["memory-1"],
    ...overrides,
  });

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

    const response = await app.inject({ method: "GET", url: "/api/v1/memory/items?workspaceId=workspace-a" });

    expect(response.statusCode).toBe(200);
    expect(listItems).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", status: "active" }));
  });

  it("requests a memory.lifecycle approval with commit callbacks and authenticated requester for single-item forget", async () => {
    const requestForgetApproval = vi.fn(() => ({ pendingApproval: pendingApprovalFixture() }));
    const built = buildApp({ requestForgetApproval });
    app = built.app;
    app.decorateRequest("authActorId", "operator:single-forget");
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/items/memory-1/forget",
      payload: {
        actionId: "single-forget-action",
        source: "route-proof",
      },
    });

    // The verb never mutates: it answers 202 with the pending approval.
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      pendingApproval: { approvalId: "11111111-2222-3333-4444-555555555555", status: "pending" },
    });
    expect(requestForgetApproval).toHaveBeenCalledWith(
      {
        itemIds: ["memory-1"],
        actionId: "single-forget-action",
        requesterId: "operator:single-forget",
      },
      {
        onCommit: expect.any(Function),
        afterCommit: expect.any(Function),
      },
    );
  });

  it("answers 200 with a zero-mutation outcome when a forget request needs no approval", async () => {
    const requestForgetApproval = vi.fn(() => ({
      pendingApproval: null,
      noMutationRequired: true,
      matchedCount: 1,
      alreadyForgottenCount: 1,
    }));
    const built = buildApp({ requestForgetApproval });
    app = built.app;
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/items/memory-1/forget",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ pendingApproval: null, noMutationRequired: true });
  });

  it("rejects bulk forget without any criteria", async () => {
    const requestForgetApproval = vi.fn();
    const built = buildApp({
      requestForgetApproval,
    });
    app = built.app;
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(requestForgetApproval).not.toHaveBeenCalled();
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

  it("forwards scoped bulk-forget criteria and the authenticated requester into the approval request", async () => {
    const requestForgetApproval = vi.fn(() => ({
      pendingApproval: pendingApprovalFixture({
        subjectKind: "memory_item_batch",
        subjectId: undefined,
        itemIds: ["mem_1", "mem_2"],
      }),
    }));
    const built = buildApp({
      requestForgetApproval,
    });
    app = built.app;
    app.decorateRequest("authActorId", "operator:route-test");
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      payload: {
        namespace: "project.alpha",
        workspaceId: "workspace-a",
        includeGlobal: true,
        actionId: "forget-action-1",
        source: "route-test",
        actorId: "untrusted-payload-actor",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(requestForgetApproval).toHaveBeenCalledTimes(1);
    expect(requestForgetApproval).toHaveBeenCalledWith(
      {
        itemIds: undefined,
        namespace: "project.alpha",
        query: undefined,
        workspaceId: "workspace-a",
        includeGlobal: true,
        actionId: "forget-action-1",
        requesterId: "operator:route-test",
      },
      {
        onCommit: expect.any(Function),
        afterCommit: expect.any(Function),
      },
    );
    expect(response.json()).toMatchObject({
      pendingApproval: { action: "items_forgotten", itemIds: ["mem_1", "mem_2"] },
    });
    expect(built.requireOperatorAuth).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized explicit bulk-forget target set before calling the service", async () => {
    const requestForgetApproval = vi.fn();
    const built = buildApp({ requestForgetApproval });
    app = built.app;
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      payload: {
        itemIds: Array.from({ length: 2_001 }, (_, index) => `memory-${index}`),
        workspaceId: "workspace-a",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(requestForgetApproval).not.toHaveBeenCalled();
    expect(built.requireOperatorAuth).toHaveBeenCalledTimes(1);
  });

  it("rejects includeGlobal without an explicit workspace before calling the service", async () => {
    const requestForgetApproval = vi.fn();
    const built = buildApp({ requestForgetApproval });
    app = built.app;
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      payload: {
        namespace: "project.alpha",
        includeGlobal: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        fieldErrors: {
          workspaceId: expect.arrayContaining([expect.stringMatching(/workspace/i)]),
        },
      },
    });
    expect(requestForgetApproval).not.toHaveBeenCalled();
    expect(built.requireOperatorAuth).toHaveBeenCalledTimes(1);
  });

  it("preserves operator authorization before bulk forget", async () => {
    const requestForgetApproval = vi.fn();
    const requireOperatorAuth = vi.fn(
      async (_request: unknown, reply: { code: (status: number) => { send: (body: { error: string }) => unknown } }) =>
        reply.code(401).send({ error: "Operator authentication required." }),
    );
    const built = buildApp({ requestForgetApproval }, requireOperatorAuth);
    app = built.app;
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      payload: {
        itemIds: ["memory-1"],
        workspaceId: "workspace-a",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Operator authentication required." });
    expect(requireOperatorAuth).toHaveBeenCalledTimes(1);
    expect(requestForgetApproval).not.toHaveBeenCalled();
  });

  it("routes item patches into the approval request surface", async () => {
    const requestItemPatchApproval = vi.fn(() => ({
      pendingApproval: pendingApprovalFixture({ action: "item_updated" }),
    }));
    const built = buildApp({ requestItemPatchApproval });
    app = built.app;
    app.decorateRequest("authActorId", "operator:patch-test");
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/memory/items/memory-1",
      payload: { title: "Updated title", pinned: true },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ pendingApproval: { action: "item_updated" } });
    expect(requestItemPatchApproval).toHaveBeenCalledWith(
      "memory-1",
      {
        title: "Updated title",
        content: undefined,
        metadata: undefined,
        pinned: true,
        ttlOverrideSeconds: undefined,
      },
      "operator:patch-test",
    );
    expect(built.requireOperatorAuth).toHaveBeenCalledTimes(1);
  });

  it("routes atomic memory item batch mutations into one batch approval request", async () => {
    const requestBatchMutationApproval = vi.fn(() => ({
      pendingApproval: pendingApprovalFixture({
        action: "batch_mutated",
        subjectKind: "memory_item_batch",
        subjectId: undefined,
        itemIds: ["mem-1", "mem-2"],
      }),
    }));
    const built = buildApp({
      requestBatchMutationApproval,
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

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      pendingApproval: { action: "batch_mutated", itemIds: ["mem-1", "mem-2"] },
    });
    expect(requestBatchMutationApproval).toHaveBeenCalledWith(
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
