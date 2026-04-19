import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { chatRoutes } from "./chat.js";

describe("chat routes additional coverage", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("creates sessions and returns pagination cursors", async () => {
    const listChatSessions = vi.fn(() => [
      {
        sessionId: "sess-2",
        updatedAt: "2026-03-05T10:00:02.000Z",
      },
      {
        sessionId: "sess-1",
        updatedAt: "2026-03-05T10:00:01.000Z",
      },
    ]);
    const createChatSession = vi.fn(() => ({
      sessionId: "sess-new",
      title: "Fresh chat",
    }));
    app = Fastify();
    app.decorate("gateway", {
      listChatSessions,
      createChatSession,
    } as never);
    await app.register(chatRoutes);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions?limit=2&includeHidden=true",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({
      nextCursor: "2026-03-05T10:00:01.000Z|sess-1",
    });
    expect(listChatSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        includeHidden: true,
        limit: 2,
      }),
    );

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions",
      payload: {
        title: "Fresh chat",
        mode: "cowork",
        origin: "prompt_pack",
        includeInHistory: false,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createChatSession).toHaveBeenCalledWith({
      title: "Fresh chat",
      mode: "cowork",
      origin: "prompt_pack",
      includeInHistory: false,
    });
  });

  it("archives workspace chat sessions through the bulk archive route", async () => {
    const archiveChatSessionsBulk = vi.fn(async () => ({
      workspaceId: "default",
      scope: "mission",
      includeHidden: false,
      archivedCount: 4,
      skippedCount: 1,
      failedCount: 0,
      archivedSessionIds: ["sess-1", "sess-2", "sess-3", "sess-4"],
      failures: [],
    }));
    app = Fastify();
    app.decorate("gateway", {
      archiveChatSessionsBulk,
    } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/archive-bulk",
      payload: {
        workspaceId: "default",
        scope: "mission",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(archiveChatSessionsBulk).toHaveBeenCalledWith({
      workspaceId: "default",
      scope: "mission",
    });
    expect(response.json()).toMatchObject({
      archivedCount: 4,
      skippedCount: 1,
      failedCount: 0,
    });
  });

  it("serves session-scoped workbench routes", async () => {
    const getChatSessionWorkbench = vi.fn(async () => ({
      sessionId: "sess-1",
      projectId: "proj-1",
      worktreeStatus: "uninitialized",
      validationStatus: "idle",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
    }));
    const createChatSessionWorkbenchWorktree = vi.fn(async () => ({
      sessionId: "sess-1",
      projectId: "proj-1",
      baseRef: "main",
      worktreePath: "./.worktrees/sess-1",
      worktreeStatus: "ready",
      validationStatus: "idle",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:01:00.000Z",
    }));
    const getChatSessionWorkbenchTree = vi.fn(async () => ({
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "idle",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      },
      rootPath: "demo",
      changedFiles: ["index.ts"],
      items: [{ path: "index.ts", name: "index.ts", kind: "file", changed: true, depth: 0 }],
    }));
    const getChatSessionWorkbenchFile = vi.fn(async () => ({
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "idle",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      },
      path: "index.ts",
      sizeBytes: 32,
      modifiedAt: "2026-04-10T00:01:00.000Z",
      contentType: "text/typescript",
      language: "ts",
      changed: true,
      content: "export const demo = true;",
    }));
    const getChatSessionWorkbenchDiff = vi.fn(async () => ({
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "idle",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      },
      scopePath: "demo",
      changedFiles: ["index.ts"],
      summary: { changedFiles: 1, additions: 4, deletions: 1 },
      diff: "diff --git a/index.ts b/index.ts",
    }));
    const getChatSessionWorkbenchOutput = vi.fn(async () => ({
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "passed",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      },
      helperRuns: [],
      output: "No validation output yet.",
    }));

    app = Fastify();
    app.decorate("gateway", {
      getChatSessionWorkbench,
      createChatSessionWorkbenchWorktree,
      getChatSessionWorkbenchTree,
      getChatSessionWorkbenchFile,
      getChatSessionWorkbenchDiff,
      getChatSessionWorkbenchOutput,
    } as never);
    await app.register(chatRoutes);

    const stateResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/workbench",
    });
    expect(stateResponse.statusCode).toBe(200);
    expect(getChatSessionWorkbench).toHaveBeenCalledWith("sess-1");

    const worktreeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/workbench/worktree",
      payload: { baseRef: "main" },
    });
    expect(worktreeResponse.statusCode).toBe(200);
    expect(createChatSessionWorkbenchWorktree).toHaveBeenCalledWith("sess-1", { baseRef: "main" });

    const treeResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/workbench/tree",
    });
    expect(treeResponse.statusCode).toBe(200);
    expect(treeResponse.json()).toMatchObject({
      changedFiles: ["index.ts"],
    });

    const fileResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/workbench/file?path=index.ts",
    });
    expect(fileResponse.statusCode).toBe(200);
    expect(getChatSessionWorkbenchFile).toHaveBeenCalledWith("sess-1", "index.ts");

    const diffResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/workbench/diff",
    });
    expect(diffResponse.statusCode).toBe(200);
    expect(diffResponse.json()).toMatchObject({
      summary: { changedFiles: 1 },
    });

    const outputResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/workbench/output",
    });
    expect(outputResponse.statusCode).toBe(200);
    expect(outputResponse.json()).toMatchObject({
      output: "No validation output yet.",
    });
  });

  it("deletes chat sessions through the gateway", async () => {
    const deleteChatSession = vi.fn(async () => ({
      deleted: true,
      sessionId: "sess-1",
    }));
    app = Fastify();
    app.decorate("gateway", {
      deleteChatSession,
    } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/chat/sessions/sess-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deleted: true,
      sessionId: "sess-1",
    });
    expect(deleteChatSession).toHaveBeenCalledWith("sess-1");
  });

  it("streams branch-aware chat message chunks over SSE", async () => {
    const agentSendChatMessageStream = vi.fn(async function* () {
      yield { type: "delta", value: "Hello" };
      yield { type: "done" };
    });
    app = Fastify();
    app.decorate("gateway", {
      agentSendChatMessageStream,
    } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send/stream",
      payload: {
        content: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('"type":"delta"');
    expect(agentSendChatMessageStream).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ content: "Hello" }),
      expect.any(AbortSignal),
    );
  });

  it("emits an error chunk without a fabricated done chunk when SSE streaming fails", async () => {
    const agentSendChatMessageStream = vi.fn(async function* () {
      yield* [];
      throw new Error("stream exploded");
    });
    app = Fastify();
    app.decorate("gateway", {
      agentSendChatMessageStream,
    } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send/stream",
      payload: {
        content: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"error"');
    expect(response.body).toContain("Check gateway diagnostics and retry");
    expect(response.body).not.toContain("stream exploded");
    expect(response.body).not.toContain('"type":"done"');
  });

  it("streams progressive delegation chunks over SSE", async () => {
    const runChatDelegationStream = vi.fn(async function* () {
      yield {
        type: "status" as const,
        runId: "run-1",
        taskId: "task-1",
        message: "Delegation started.",
      };
      yield {
        type: "step" as const,
        runId: "run-1",
        taskId: "task-1",
        step: {
          stepId: "step-2",
          runId: "run-1",
          role: "qa",
          status: "completed",
          index: 1,
          startedAt: "2026-03-11T20:00:02.000Z",
          finishedAt: "2026-03-11T20:00:03.000Z",
          output: "Validation complete.",
        },
      };
      yield {
        type: "step" as const,
        runId: "run-1",
        taskId: "task-1",
        step: {
          stepId: "step-1",
          runId: "run-1",
          role: "architect",
          status: "completed",
          index: 0,
          startedAt: "2026-03-11T20:00:00.000Z",
          finishedAt: "2026-03-11T20:00:04.000Z",
          output: "Design locked.",
        },
      };
      yield {
        type: "done" as const,
        runId: "run-1",
        taskId: "task-1",
        result: {
          runId: "run-1",
          taskId: "task-1",
          executionPlanId: "plan-1",
          steps: [
            {
              stepId: "step-1",
              runId: "run-1",
              role: "architect",
              status: "completed",
              index: 0,
              startedAt: "2026-03-11T20:00:00.000Z",
              finishedAt: "2026-03-11T20:00:04.000Z",
              childSessionId: "sess-child-1",
              childTurnId: "turn-child-1",
              durableRunId: "durable-child-1",
              output: "Design locked.",
            },
            {
              stepId: "step-2",
              runId: "run-1",
              role: "qa",
              status: "completed",
              index: 1,
              startedAt: "2026-03-11T20:00:02.000Z",
              finishedAt: "2026-03-11T20:00:03.000Z",
              childSessionId: "sess-child-2",
              childTurnId: "turn-child-2",
              durableRunId: "durable-child-2",
              output: "Validation complete.",
            },
          ],
          stitchedOutput: "### Architect\nDesign locked.\n\n### QA\nValidation complete.",
          citations: [],
        },
      };
    });
    app = Fastify();
    app.decorate("gateway", {
      runChatDelegationStream,
    } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/delegate/stream",
      payload: {
        objective: "Implement the fix",
        roles: ["Architect", "QA"],
        mode: "parallel",
        steps: [
          {
            stepId: "step-1",
            index: 0,
            role: "Architect",
            parallelizable: true,
          },
          {
            stepId: "step-2",
            index: 1,
            role: "QA",
            parallelizable: true,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('"type":"status"');
    expect(response.body).toContain('"type":"step"');
    expect(response.body).toContain('"type":"done"');
    expect(runChatDelegationStream).toHaveBeenCalledWith("sess-1", {
      objective: "Implement the fix",
      roles: ["Architect", "QA"],
      mode: "parallel",
      steps: [
        {
          stepId: "step-1",
          index: 0,
          role: "Architect",
          parallelizable: true,
        },
        {
          stepId: "step-2",
          index: 1,
          role: "QA",
          parallelizable: true,
        },
      ],
    });
    expect(response.body.indexOf('"stepId":"step-2"')).toBeLessThan(response.body.indexOf('"stepId":"step-1"'));
    expect(response.body).toContain('"durableRunId":"durable-child-1"');
  });

  it("accepts dependency-aware delegation steps over the route stack", async () => {
    const runChatDelegation = vi.fn(async () => ({
      runId: "run-2",
      taskId: "task-2",
      executionPlanId: "plan-2",
      steps: [
        {
          stepId: "step-1",
          runId: "run-2",
          role: "architect",
          status: "completed",
          index: 0,
          startedAt: "2026-03-11T20:10:00.000Z",
          finishedAt: "2026-03-11T20:10:04.000Z",
          childSessionId: "sess-child-a",
          childTurnId: "turn-child-a",
          durableRunId: "durable-child-a",
          output: "Design complete.",
        },
        {
          stepId: "step-2",
          runId: "run-2",
          role: "coder",
          status: "skipped",
          index: 1,
          startedAt: "2026-03-11T20:10:05.000Z",
          error: "Skipped because architect failed dependency checks.",
        },
      ],
      stitchedOutput: "### Architect\nDesign complete.",
      citations: [],
    }));
    app = Fastify();
    app.decorate("gateway", {
      runChatDelegation,
    } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/delegate",
      payload: {
        objective: "Implement the fix",
        roles: ["Architect", "Coder"],
        mode: "parallel",
        steps: [
          {
            stepId: "step-1",
            index: 0,
            role: "Architect",
            parallelizable: true,
          },
          {
            stepId: "step-2",
            index: 1,
            role: "Coder",
            dependsOnStepIds: ["step-1"],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runChatDelegation).toHaveBeenCalledWith("sess-1", {
      objective: "Implement the fix",
      roles: ["Architect", "Coder"],
      mode: "parallel",
      steps: [
        {
          stepId: "step-1",
          index: 0,
          role: "Architect",
          parallelizable: true,
        },
        {
          stepId: "step-2",
          index: 1,
          role: "Coder",
          dependsOnStepIds: ["step-1"],
        },
      ],
    });
    expect(response.json()).toMatchObject({
      executionPlanId: "plan-2",
      steps: [
        {
          stepId: "step-1",
          childSessionId: "sess-child-a",
          childTurnId: "turn-child-a",
          durableRunId: "durable-child-a",
        },
        {
          stepId: "step-2",
          status: "skipped",
        },
      ],
    });
  });

  it("sanitizes delegation SSE failures without a fabricated done chunk", async () => {
    const runChatDelegationStream = vi.fn(async function* () {
      yield* [];
      throw new Error("delegate exploded");
    });
    app = Fastify();
    app.decorate("gateway", {
      runChatDelegationStream,
    } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/delegate/stream",
      payload: {
        objective: "Implement the fix",
        roles: ["Architect"],
        mode: "sequential",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"error"');
    expect(response.body).toContain("Check gateway diagnostics and retry");
    expect(response.body).not.toContain("delegate exploded");
    expect(response.body).not.toContain('"type":"done"');
  });

  it("rejects removed legacy chat write routes", async () => {
    app = Fastify();
    app.decorate("gateway", {} as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/messages",
      payload: {
        content: "Hello",
      },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("/agent-send"),
    });
  });

  it("wires thread routes and planning-mode prefs through the gateway", async () => {
    const getChatThread = vi.fn(async () => ({
      sessionId: "sess-1",
      activeLeafTurnId: "turn-2",
      selectedTurnId: "turn-2",
      turns: [],
    }));
    const selectChatBranchTurn = vi.fn(async () => ({
      sessionId: "sess-1",
      activeLeafTurnId: "turn-3",
      selectedTurnId: "turn-3",
      turns: [],
    }));
    const updateChatSessionPrefs = vi.fn(() => ({
      sessionId: "sess-1",
      mode: "chat",
      planningMode: "advisory",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      visionFallbackModel: undefined,
      proactiveMode: "off",
      autonomyBudget: {
        maxActionsPerHour: 2,
        maxActionsPerTurn: 1,
        cooldownSeconds: 60,
      },
      retrievalMode: "standard",
      reflectionMode: "off",
      createdAt: "2026-03-07T00:00:00.000Z",
      updatedAt: "2026-03-07T00:00:00.000Z",
    }));
    app = Fastify();
    app.decorate("gateway", {
      getChatThread,
      selectChatBranchTurn,
      updateChatSessionPrefs,
    } as never);
    await app.register(chatRoutes);

    const threadResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/thread",
    });
    expect(threadResponse.statusCode).toBe(200);
    expect(getChatThread).toHaveBeenCalledWith("sess-1");

    const selectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-2/select",
    });
    expect(selectResponse.statusCode).toBe(200);
    expect(selectChatBranchTurn).toHaveBeenCalledWith("sess-1", "turn-2");

    const prefsResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/chat/sessions/sess-1/prefs",
      payload: {
        planningMode: "advisory",
      },
    });
    expect(prefsResponse.statusCode).toBe(200);
    expect(updateChatSessionPrefs).toHaveBeenCalledWith("sess-1", { planningMode: "advisory" });
  });

  it("answers pending user-input prompts through the gateway", async () => {
    const answerChatUserInputPrompt = vi.fn(async () => ({
      ok: true,
      sessionId: "sess-1",
      turnId: "turn-2",
      promptId: "prompt-1",
      resumed: false,
    }));
    app = Fastify();
    app.decorate("gateway", {
      answerChatUserInputPrompt,
    } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-2/user-input/prompt-1/respond",
      payload: {
        response: {
          kind: "single_select",
          optionId: "opt-1",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(answerChatUserInputPrompt).toHaveBeenCalledWith("sess-1", "turn-2", "prompt-1", {
      kind: "single_select",
      optionId: "opt-1",
    });
  });

  it("lists, creates, and updates specialist candidates through the gateway", async () => {
    const listChatSessionSpecialistCandidates = vi.fn(() => ({
      items: [
        {
          candidateId: "cand-1",
          sessionId: "sess-1",
          title: "Research Specialist",
          role: "researcher",
          summary: "Reusable researcher persona",
          reason: "Repeated research gap",
          source: "runtime_gap",
          status: "drafted",
          routingMode: "manual_only",
          confidence: 0.74,
          requiresApproval: true,
          routingHints: { preferredModes: ["cowork"] },
          evidence: [],
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T00:00:00.000Z",
        },
      ],
    }));
    const createChatSessionSpecialistCandidate = vi.fn(() => ({
      candidateId: "cand-2",
      sessionId: "sess-1",
      title: "Research Specialist",
      role: "researcher",
      summary: "Reusable researcher persona",
      reason: "Repeated research gap",
      source: "runtime_gap",
      status: "drafted",
      routingMode: "manual_only",
      confidence: 0.74,
      requiresApproval: true,
      routingHints: { preferredModes: ["cowork"] },
      evidence: [],
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:00.000Z",
    }));
    const updateChatSessionSpecialistCandidate = vi.fn(() => ({
      candidateId: "cand-2",
      sessionId: "sess-1",
      title: "Research Specialist",
      role: "researcher",
      summary: "Reusable researcher persona",
      reason: "Repeated research gap",
      source: "runtime_gap",
      status: "active",
      routingMode: "strong_match_only",
      confidence: 0.74,
      requiresApproval: true,
      routingHints: { preferredModes: ["cowork"] },
      evidence: [],
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:05:00.000Z",
      activatedAt: "2026-03-12T00:05:00.000Z",
    }));
    app = Fastify();
    app.decorate("gateway", {
      listChatSessionSpecialistCandidates,
      createChatSessionSpecialistCandidate,
      updateChatSessionSpecialistCandidate,
    } as never);
    await app.register(chatRoutes);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/specialist-candidates?limit=50",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listChatSessionSpecialistCandidates).toHaveBeenCalledWith("sess-1", 50);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/specialist-candidates",
      payload: {
        turnId: "turn-1",
        suggestion: {
          candidateId: "suggestion-1",
          title: "Research Specialist",
          role: "researcher",
          summary: "Reusable researcher persona",
          reason: "Repeated research gap",
          source: "runtime_gap",
          confidence: 0.74,
          suggestedStatus: "suggested",
          suggestedRoutingMode: "manual_only",
          requiresApproval: true,
          routingHints: { preferredModes: ["cowork"] },
          evidence: [],
        },
      },
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createChatSessionSpecialistCandidate).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        turnId: "turn-1",
        suggestion: expect.objectContaining({
          title: "Research Specialist",
        }),
      }),
    );

    const patchResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/chat/sessions/sess-1/specialist-candidates/cand-2",
      payload: {
        status: "active",
        routingMode: "strong_match_only",
      },
    });
    expect(patchResponse.statusCode).toBe(200);
    expect(updateChatSessionSpecialistCandidate).toHaveBeenCalledWith("sess-1", "cand-2", {
      status: "active",
      routingMode: "strong_match_only",
    });
  });

  it("cancels active turns through the gateway", async () => {
    const cancelChatTurn = vi.fn(async () => ({
      sessionId: "sess-1",
      turnId: "turn-9",
      cancelled: true,
      trace: {
        turnId: "turn-9",
        sessionId: "sess-1",
        userMessageId: "msg-user-9",
        branchKind: "append",
        status: "cancelled",
        mode: "chat",
        startedAt: "2026-03-11T20:00:00.000Z",
        finishedAt: "2026-03-11T20:00:02.000Z",
        citations: [],
        toolRuns: [],
        routing: {},
      },
    }));
    app = Fastify();
    app.decorate("gateway", {
      cancelChatTurn,
    } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-9/cancel",
      payload: {
        cancelledBy: "mission-control",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(cancelChatTurn).toHaveBeenCalledWith("sess-1", "turn-9", "mission-control");
    expect(response.json()).toMatchObject({
      sessionId: "sess-1",
      turnId: "turn-9",
      cancelled: true,
      trace: {
        status: "cancelled",
      },
    });
  });

  it("returns persisted turn context manifests", async () => {
    const getTurnContextManifestForSession = vi.fn(() => ({
      manifest: {
        manifestId: "manifest-1",
        scope: "chat_turn",
        turnId: "turn-9",
        sessionId: "sess-1",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:01.000Z",
        entryCount: 2,
      },
      entries: [
        {
          entryId: "entry-1",
          manifestId: "manifest-1",
          kind: "system_message",
          entryIndex: 0,
          sourceRef: "system:0",
          contentText: "System instructions",
          contentHash: "hash-1",
          metadata: {},
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        {
          entryId: "entry-2",
          manifestId: "manifest-1",
          kind: "memory_context",
          entryIndex: 1,
          sourceRef: "memory-1",
          contentText: "Relevant memory context",
          contentHash: "hash-2",
          metadata: { status: "generated" },
          createdAt: "2026-04-01T00:00:01.000Z",
        },
      ],
    }));
    app = Fastify();
    app.decorate("gateway", {
      getTurnContextManifestForSession,
    } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-9/context-manifest",
    });

    expect(response.statusCode).toBe(200);
    expect(getTurnContextManifestForSession).toHaveBeenCalledWith("sess-1", "turn-9");
    expect(response.json()).toMatchObject({
      manifest: {
        manifestId: "manifest-1",
        turnId: "turn-9",
      },
      entries: [{ kind: "system_message" }, { kind: "memory_context" }],
    });
  });

  it("returns 409 for branch-write conflicts on agent send", async () => {
    const agentSendChatMessage = vi.fn(async () => {
      const error = new Error("chat turn conflict");
      error.name = "ChatTurnWriteConflictError";
      throw error;
    });
    app = Fastify();
    app.decorate("gateway", {
      agentSendChatMessage,
    } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "Hello",
      },
    });

    expect(response.statusCode).toBe(409);
  });

  it("sanitizes non-conflict agent-send failures", async () => {
    const agentSendChatMessage = vi.fn(async () => {
      throw new Error("database exploded");
    });
    app = Fastify();
    app.decorate("gateway", {
      agentSendChatMessage,
    } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "Hello",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Check gateway diagnostics and retry");
    expect(response.body).not.toContain("database exploded");
  });
});
