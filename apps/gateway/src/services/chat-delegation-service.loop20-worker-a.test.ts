import type {
  ChatDelegateResponse,
  ChatDelegationStepRecord,
  ChatSendMessageResponse,
  ChatSessionPrefsRecord,
} from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { ChatDelegationService, type ChatDelegationServiceHost } from "./chat-delegation-service.js";

function buildPrefs(overrides: Partial<ChatSessionPrefsRecord> = {}): ChatSessionPrefsRecord {
  return {
    sessionId: "sess-1",
    mode: "cowork",
    planningMode: "off",
    providerId: "openai",
    model: "gpt-5.4",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    orchestrationEnabled: true,
    orchestrationIntensity: "balanced",
    orchestrationVisibility: "explicit",
    orchestrationProviderPreference: "balanced",
    orchestrationReviewDepth: "standard",
    orchestrationParallelism: "parallel",
    codeAutoApply: "manual",
    proactiveMode: "off",
    retrievalMode: "layered",
    reflectionMode: "off",
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    ...overrides,
  };
}

function createStepRecord(
  input: Partial<ChatDelegationStepRecord> &
    Pick<ChatDelegationStepRecord, "stepId" | "runId" | "role" | "index" | "startedAt">,
): ChatDelegationStepRecord {
  return {
    stepId: input.stepId,
    runId: input.runId,
    role: input.role,
    status: input.status ?? "pending",
    label: input.label,
    index: input.index,
    providerId: input.providerId,
    model: input.model,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    summary: input.summary,
    output: input.output,
    error: input.error,
    failureGuidance: input.failureGuidance,
    durableRunId: input.durableRunId,
    childSessionId: input.childSessionId,
    childTurnId: input.childTurnId,
    citations: input.citations,
  };
}

function createChatResponse(
  childSessionId: string,
  overrides: Partial<ChatSendMessageResponse> = {},
): ChatSendMessageResponse {
  return {
    sessionId: childSessionId,
    transport: "llm",
    userMessage: {
      messageId: `user-${childSessionId}`,
      sessionId: childSessionId,
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "delegate task",
      timestamp: "2026-05-14T00:00:00.000Z",
    },
    assistantMessage: {
      messageId: `assistant-${childSessionId}`,
      sessionId: childSessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: `${childSessionId} output`,
      timestamp: "2026-05-14T00:00:01.000Z",
    },
    model: "gpt-5.4",
    turnId: `turn-${childSessionId}`,
    citations: [{ citationId: `cite-${childSessionId}`, title: "Delegate source" }],
    routing: { effectiveProviderId: "openai", effectiveModel: "gpt-5.4" },
    trace: {
      turnId: `turn-${childSessionId}`,
      sessionId: childSessionId,
      userMessageId: `user-${childSessionId}`,
      branchKind: "append",
      status: "completed",
      mode: "cowork",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      startedAt: "2026-05-14T00:00:00.000Z",
      finishedAt: "2026-05-14T00:00:01.000Z",
      toolRuns: [],
      citations: [],
      routing: { effectiveProviderId: "openai", effectiveModel: "gpt-5.4" },
      durable: { runId: `durable-${childSessionId}`, status: "completed" },
    },
    ...overrides,
  };
}

function createHarness(options: { prefs?: ChatSessionPrefsRecord; projectId?: string } = {}) {
  const prefs = options.prefs ?? buildPrefs();
  const steps = new Map<string, ChatDelegationStepRecord>();
  let childSessionCounter = 0;

  const deps = {
    getSession: vi.fn(() => ({ sessionId: "sess-1" })),
    listChatMessages: vi.fn(async () => [
      { role: "assistant", content: "Previous answer" },
      { role: "user", content: "Need architecture, implementation, QA, ops, and handoff coverage." },
    ]),
    normalizeWorkspaceId: vi.fn((workspaceId?: string) => workspaceId ?? "default"),
    ensureChatSessionModelDefaults: vi.fn((_sessionId: string, nextPrefs: ChatSessionPrefsRecord) => nextPrefs),
    createChatSession: vi.fn((input: { title?: string }) => {
      childSessionCounter += 1;
      return {
        sessionId: `delegate-session-${childSessionCounter}`,
        title: input.title,
      };
    }),
    inheritDelegatedSessionToolGrants: vi.fn(),
    updateChatSessionPrefs: vi.fn(),
    resolveToolPolicyContext: undefined,
    agentSendChatMessage: vi.fn(async (childSessionId: string) => createChatResponse(childSessionId)),
    extractAndPersistLearnedMemory: vi.fn(),
    scheduleChatMemoryContextPrewarm: vi.fn(),
    gatewaySql: {
      prepare: vi.fn(() => ({
        get: vi.fn(() => undefined),
      })),
    },
    taskLifecycleService: {
      createTask: vi.fn(() => ({ taskId: "task-1" })),
      appendTaskActivity: vi.fn(),
      appendTaskDeliverable: vi.fn(),
      updateTask: vi.fn(),
      updateTaskAgenticContext: vi.fn(),
      registerTaskSubagent: vi.fn(),
      updateTaskSubagent: vi.fn(),
    },
    storage: {
      chatSessionPrefs: {
        ensure: vi.fn(() => prefs),
      },
      chatSessionMeta: {
        ensure: vi.fn(() => ({ workspaceId: "default" })),
      },
      chatSessionProjects: {
        get: vi.fn(() =>
          options.projectId === undefined ? { projectId: "project-1" } : { projectId: options.projectId },
        ),
      },
      chatDelegationRuns: {
        create: vi.fn(),
        patch: vi.fn(),
      },
      chatDelegationSteps: {
        create: vi.fn(
          (
            input: Partial<ChatDelegationStepRecord> &
              Pick<ChatDelegationStepRecord, "stepId" | "runId" | "role" | "index" | "startedAt">,
          ) => {
            const record = createStepRecord(input);
            steps.set(record.stepId, record);
            return record;
          },
        ),
        patch: vi.fn((stepId: string, patch: Partial<ChatDelegationStepRecord>) => {
          const current = steps.get(stepId);
          if (!current) {
            throw new Error(`unknown step ${stepId}`);
          }
          const next = { ...current, ...patch };
          steps.set(stepId, next);
          return next;
        }),
        listByRun: vi.fn((runId: string) =>
          [...steps.values()].filter((step) => step.runId === runId).sort((left, right) => left.index - right.index),
        ),
      },
      taskSubagents: {
        findByAgentSessionId: vi.fn(() => undefined),
      },
    },
  } satisfies ChatDelegationServiceHost;

  return {
    deps,
    service: new ChatDelegationService(deps),
    steps,
  };
}

function createAcceptHarness(argsJson: string | undefined) {
  const { deps, service } = createHarness();
  deps.gatewaySql.prepare = vi.fn(() => ({
    get: vi.fn(() => (argsJson === undefined ? undefined : { args_json: argsJson })),
  })) as never;
  const response: ChatDelegateResponse = {
    runId: "run-accepted",
    taskId: "task-accepted",
    steps: [],
    stitchedOutput: "",
    citations: [],
  };
  const runSpy = vi.spyOn(service, "runChatDelegation").mockResolvedValue(response);
  return { deps, service, response, runSpy };
}

describe("ChatDelegationService loop 20 coverage", () => {
  it("suggests delegation from the latest user message and falls back to default roles for blank explicit roles", async () => {
    const { deps, service } = createHarness();

    const inferred = await service.suggestChatDelegation("sess-1");
    const explicitFallback = await service.suggestChatDelegation("sess-1", {
      objective: "Triage this vague task",
      roles: ["   "],
    });

    expect(deps.listChatMessages).toHaveBeenCalledWith("sess-1", 40);
    expect(inferred.suggestion.objective).toBe("Need architecture, implementation, QA, ops, and handoff coverage.");
    expect(inferred.suggestion.roles).toEqual(expect.arrayContaining(["architect", "coder", "qa", "ops"]));
    expect(inferred.suggestion.confidence).toBeGreaterThan(0.9);
    expect(explicitFallback.suggestion.roles).toEqual(["product", "architect", "coder", "qa", "ops"]);
    expect(explicitFallback.suggestion.confidence).toBe(0.84);
  });

  it("accepts proactive suggestions from stored JSON and falls back to request input on malformed JSON", async () => {
    const parsed = createAcceptHarness(JSON.stringify({ objective: "Stored objective", roles: ["Architect", "QA"] }));

    const parsedResult = await parsed.service.acceptChatDelegation("sess-1", {
      suggestionId: "action-1",
      objective: "Request objective",
      roles: ["coder"],
      mode: "parallel",
      steps: [
        { stepId: "architect-step", role: "Architect", index: 0, parallelizable: true },
        { stepId: "qa-step", role: "QA", index: 1, dependsOnStepIds: ["architect-step"] },
      ],
      providerId: "anthropic",
      model: "claude-sonnet",
      surfaceMode: "cowork",
      policyRunId: "parent-run-1",
      policyTaskId: "parent-task-1",
    });

    expect(parsedResult).toBe(parsed.response);
    expect(parsed.runSpy).toHaveBeenCalledWith("sess-1", {
      objective: "Stored objective",
      roles: ["Architect", "QA"],
      mode: "parallel",
      providerId: "anthropic",
      model: "claude-sonnet",
      surfaceMode: "cowork",
      steps: [
        { stepId: "architect-step", role: "Architect", index: 0, parallelizable: true },
        { stepId: "qa-step", role: "QA", index: 1, dependsOnStepIds: ["architect-step"] },
      ],
      policyRunId: "parent-run-1",
      policyTaskId: "parent-task-1",
    });

    const malformed = createAcceptHarness("{not-json");
    await malformed.service.acceptChatDelegation("sess-1", {
      suggestionId: "action-bad",
      objective: "Request objective",
      roles: ["researcher"],
    });

    expect(malformed.runSpy).toHaveBeenCalledWith("sess-1", {
      objective: "Request objective",
      roles: ["researcher"],
      mode: "sequential",
      providerId: undefined,
      model: undefined,
      surfaceMode: undefined,
      steps: undefined,
      policyRunId: undefined,
      policyTaskId: undefined,
    });
  });

  it("marks the run and task failed when inherited policy resolution fails before dispatch", async () => {
    const { deps, service } = createHarness();
    deps.resolveToolPolicyContext = vi.fn(() => {
      throw new Error("permission profile is no longer active");
    }) as never;

    await expect(
      service.runChatDelegation("sess-1", {
        objective: "Review the permission profile boundary",
        roles: ["Runtime Policy"],
        mode: "sequential",
        surfaceMode: "cowork",
        operatorId: "operator-1",
        permissionProfileId: "profile-stale",
      }),
    ).rejects.toThrow("permission profile is no longer active");

    expect(deps.agentSendChatMessage).not.toHaveBeenCalled();
    expect(deps.storage.chatDelegationRuns.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: "failed",
        stitchedOutput: "FAILED: permission profile is no longer active",
        citations: [],
        finishedAt: expect.any(String),
      }),
    );
    expect(deps.taskLifecycleService.updateTask).toHaveBeenCalledWith("task-1", { status: "blocked" });
    expect(deps.taskLifecycleService.updateTaskAgenticContext).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        activeChildCount: 0,
        failureClass: "other",
      }),
    );
  });

  it("validates objective, code project binding, and custom step dependencies before creating work", async () => {
    const earlyValidationHarness = createHarness();
    const { deps, service } = earlyValidationHarness;

    await expect(service.runChatDelegation("sess-1", { objective: "  ", roles: ["qa"] })).rejects.toThrow(
      /objective is required/,
    );
    await expect(
      service.runChatDelegation("sess-1", {
        objective: "Run invalid role",
        roles: ["architect"],
        steps: [{ stepId: "qa-step", role: "qa", index: 0 }],
      }),
    ).rejects.toThrow(/must also appear in roles/);
    await expect(
      service.runChatDelegation("sess-1", {
        objective: "Run unknown dependency",
        roles: ["architect"],
        steps: [{ stepId: "architect-step", role: "architect", index: 0, dependsOnStepIds: ["missing-step"] }],
      }),
    ).rejects.toThrow(/depends on unknown step/);
    await expect(
      service.runChatDelegation("sess-1", {
        objective: "Run self dependency",
        roles: ["architect"],
        steps: [{ stepId: "architect-step", role: "architect", index: 0, dependsOnStepIds: ["architect-step"] }],
      }),
    ).rejects.toThrow(/cannot depend on itself/);
    await expect(
      service.runChatDelegation("sess-1", {
        objective: "Run duplicate step ids",
        roles: ["architect", "qa"],
        mode: "parallel",
        steps: [
          { stepId: "shared-step", role: "architect", index: 0 },
          { stepId: "shared-step", role: "qa", index: 1 },
        ],
      }),
    ).rejects.toThrow(/duplicated/);
    const codeHarness = createHarness({ prefs: buildPrefs({ mode: "code" }), projectId: undefined });
    codeHarness.deps.storage.chatSessionProjects.get = vi.fn(() => undefined);
    await expect(
      codeHarness.service.runChatDelegation("sess-1", {
        objective: "Run code delegation",
        roles: ["coder"],
        surfaceMode: "code",
      }),
    ).rejects.toThrow(/project-bound parent session/);
    expect(deps.taskLifecycleService.createTask).not.toHaveBeenCalled();

    const cycleHarness = createHarness();
    await expect(
      cycleHarness.service.runChatDelegation("sess-1", {
        objective: "Run dependency cycle",
        roles: ["architect", "qa"],
        mode: "parallel",
        steps: [
          { stepId: "architect-step", role: "architect", index: 0, dependsOnStepIds: ["qa-step"] },
          { stepId: "qa-step", role: "qa", index: 1, dependsOnStepIds: ["architect-step"] },
        ],
      }),
    ).rejects.toThrow(/dependency cycle/);
    expect(cycleHarness.deps.taskLifecycleService.createTask).not.toHaveBeenCalled();
    expect(cycleHarness.deps.storage.chatDelegationRuns.create).not.toHaveBeenCalled();
  });

  it("normalizes caller-supplied plan step ids into unique persisted delegation step ids", async () => {
    const { deps, service } = createHarness();

    const result = await service.runChatDelegation("sess-1", {
      objective: "Split a planned turn into persisted delegation steps",
      roles: ["architect", "qa"],
      mode: "parallel",
      steps: [
        { stepId: "plan-step-1", role: "architect", index: 0, parallelizable: true },
        { stepId: "plan-step-2", role: "qa", index: 1, parallelizable: false, dependsOnStepIds: ["plan-step-1"] },
      ],
    });

    const actualStepIds = result.steps.map((step) => step.stepId);
    expect(actualStepIds).toHaveLength(2);
    expect(new Set(actualStepIds).size).toBe(2);
    expect(actualStepIds).not.toEqual(expect.arrayContaining(["plan-step-1", "plan-step-2"]));
    expect(deps.storage.chatDelegationSteps.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ stepId: result.steps[0]?.stepId, role: "architect" }),
    );
    expect(deps.taskLifecycleService.registerTaskSubagent).toHaveBeenNthCalledWith(
      2,
      "task-1",
      expect.objectContaining({
        agentName: "qa",
        metadata: expect.objectContaining({ dependsOnStepIds: [result.steps[0]?.stepId] }),
      }),
    );
    expect(deps.extractAndPersistLearnedMemory).toHaveBeenCalledWith(
      "sess-1",
      expect.stringContaining("delegate-session-1 output"),
      expect.objectContaining({ role: "assistant", sourceRef: result.runId }),
    );
    expect(deps.scheduleChatMemoryContextPrewarm).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        prompt: expect.stringContaining("delegate-session-1 output"),
      }),
    );
  });

  it("treats cancelled dependency steps as terminal blockers for downstream delegation", async () => {
    const { deps, service } = createHarness();
    deps.agentSendChatMessage = vi.fn(async (childSessionId: string) => {
      const response = createChatResponse(childSessionId);
      return {
        ...response,
        assistantMessage: {
          ...response.assistantMessage,
          content: "",
        },
        trace: {
          ...response.trace,
          status: "cancelled",
          failure: { message: "operator cancelled child run" },
        },
      } as ChatSendMessageResponse;
    }) as never;

    const result = await service.runChatDelegation("sess-1", {
      objective: "Do not run downstream work after cancellation",
      roles: ["architect", "qa"],
      mode: "parallel",
      steps: [
        { stepId: "architect-step", role: "architect", index: 0 },
        { stepId: "qa-step", role: "qa", index: 1, dependsOnStepIds: ["architect-step"] },
      ],
    });

    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failed");
    expect(result.steps.map((step) => step.status)).toEqual(["cancelled", "skipped"]);
    expect(result.stitchedOutput).toContain("CANCELLED: operator cancelled child run");
    expect(result.stitchedOutput).toContain("SKIPPED: Skipped because dependency did not complete: architect");
    expect(deps.storage.chatDelegationRuns.patch).toHaveBeenCalledWith(
      result.runId,
      expect.objectContaining({ status: "failed", stitchedOutput: expect.stringContaining("CANCELLED") }),
    );
    expect(deps.taskLifecycleService.appendTaskActivity).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        metadata: expect.objectContaining({
          cancelledSteps: 1,
          skippedSteps: 1,
        }),
      }),
    );
  });

  it("carries the parent permission profile and override into delegated child turns", async () => {
    const { deps, service } = createHarness();
    deps.resolveToolPolicyContext = vi.fn((input) => ({
      operatorId: input.operatorId,
      authActorId: input.authActorId,
      authActorSource: input.authActorSource,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      surface: input.surface,
      permissionProfileId: "profile-parent",
      localOperatorOverrideId: "override-parent",
    }));

    const result = await service.runChatDelegation("sess-1", {
      objective: "Delegate under parent policy",
      roles: ["researcher"],
      mode: "sequential",
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "token",
      permissionProfileId: "profile-parent",
      localOperatorOverrideId: "override-parent",
    });

    expect(deps.resolveToolPolicyContext).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "operator-1",
        workspaceId: "default",
        sessionId: "sess-1",
        taskId: "task-1",
        runId: result.runId,
        surface: "cowork",
        permissionProfileId: "profile-parent",
        localOperatorOverrideId: "override-parent",
      }),
    );
    expect(deps.agentSendChatMessage).toHaveBeenCalledWith(
      "delegate-session-1",
      expect.objectContaining({
        permissionProfileId: "profile-parent",
        localOperatorOverrideId: "override-parent",
        policyRunId: result.runId,
        policyTaskId: "task-1",
      }),
      expect.any(Object),
    );
  });

  it("keeps waiting delegate responses active with actionable output", async () => {
    const { deps, service } = createHarness();
    deps.agentSendChatMessage = vi.fn(async (childSessionId: string) =>
      createChatResponse(childSessionId, {
        assistantMessage: undefined,
        citations: [],
        trace: {
          ...createChatResponse(childSessionId).trace!,
          status: "waiting_for_approval",
          failure: {
            failureClass: "approval_required",
            message: "approval gate tripped",
            retryable: true,
          },
          pendingApprovalSummary: {
            approvalId: "approval-1",
            reason: "Needs filesystem approval.",
          },
        },
      }),
    ) as never;

    const result = await service.runChatDelegation("sess-1", {
      objective: "Read a local project file",
      roles: ["researcher"],
      mode: "sequential",
    });

    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        status: "running",
        output: "approval gate tripped",
        error: undefined,
        failureGuidance: undefined,
      }),
    );
    expect(deps.taskLifecycleService.updateTaskSubagent).toHaveBeenCalledWith(
      "delegate-session-1",
      expect.objectContaining({
        status: "paused",
        metadata: expect.objectContaining({ failureClass: undefined }),
      }),
    );
    expect(deps.storage.chatDelegationRuns.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "running", stitchedOutput: expect.stringContaining("WAITING") }),
    );
    expect(deps.taskLifecycleService.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ status: "in_progress" }),
    );
    expect(deps.extractAndPersistLearnedMemory).toHaveBeenCalledTimes(1);
    expect(deps.extractAndPersistLearnedMemory).toHaveBeenCalledWith(
      "sess-1",
      "Read a local project file",
      expect.objectContaining({ role: "user" }),
    );
    expect(deps.scheduleChatMemoryContextPrewarm).not.toHaveBeenCalled();
  });

  it("treats child tool budget failures as partial delegation truth with continuation guidance", async () => {
    const { deps, service } = createHarness();
    deps.agentSendChatMessage = vi.fn(async (childSessionId: string) => {
      const response = createChatResponse(childSessionId, {
        assistantMessage: {
          ...createChatResponse(childSessionId).assistantMessage!,
          content: "Strong leads so far: Store A, Store B. Hours and emails still need verification.",
        },
      });
      return {
        ...response,
        trace: {
          ...response.trace!,
          status: "completed",
          failure: {
            failureClass: "tool_run_budget_exceeded",
            message: "Tool run budget exceeded for this turn after 7 tool calls.",
            retryable: true,
            recommendedAction: "retry_narrower",
          },
        },
      } as ChatSendMessageResponse;
    }) as never;

    const result = await service.runChatDelegation("sess-1", {
      objective: "Find boardgame stores within 10 miles of 91303 with address, hours, and email.",
      roles: ["researcher"],
    });

    expect(result.status).toBe("partial");
    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error: "Tool run budget exceeded for this turn after 7 tool calls.",
        output: expect.stringContaining("Strong leads so far"),
        failureGuidance: expect.stringContaining("Continue from gathered leads"),
      }),
    );
    expect(result.stitchedOutput).toContain("FAILED: Tool run budget exceeded");
    expect(result.stitchedOutput).toContain("Strong leads so far");
    expect(deps.taskLifecycleService.updateTaskSubagent).toHaveBeenCalledWith(
      "delegate-session-1",
      expect.objectContaining({
        status: "failed",
        metadata: expect.objectContaining({ failureClass: "repeated_tool_loop" }),
      }),
    );
    expect(deps.storage.chatDelegationRuns.patch).toHaveBeenLastCalledWith(
      result.runId,
      expect.objectContaining({ status: "partial" }),
    );
  });

  it("records thrown delegate failures as crashed subagents and blocked runs", async () => {
    const { deps, service } = createHarness();
    deps.agentSendChatMessage = vi.fn(async () => {
      throw new Error("provider transport crashed");
    }) as never;

    const result = await service.runChatDelegation("sess-1", {
      objective: "Run a fragile delegated task",
      roles: ["ops"],
    });

    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error: "provider transport crashed",
        failureGuidance: expect.stringContaining("ops"),
      }),
    );
    expect(result.stitchedOutput).toContain("provider transport crashed");
    expect(deps.taskLifecycleService.updateTaskSubagent).toHaveBeenCalledWith(
      "delegate-session-1",
      expect.objectContaining({
        status: "failed",
        metadata: expect.objectContaining({ failureClass: "crash" }),
      }),
    );
    expect(deps.taskLifecycleService.appendTaskActivity).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        activityType: "diagnostic",
        message: expect.stringContaining("provider transport crashed"),
      }),
    );
    expect(deps.extractAndPersistLearnedMemory).toHaveBeenCalledTimes(1);
    expect(deps.extractAndPersistLearnedMemory).toHaveBeenCalledWith(
      "sess-1",
      "Run a fragile delegated task",
      expect.objectContaining({ role: "user" }),
    );
    expect(deps.scheduleChatMemoryContextPrewarm).not.toHaveBeenCalled();
  });

  it("propagates stream errors after draining already queued chunks", async () => {
    const service = Object.create(ChatDelegationService.prototype) as ChatDelegationService & {
      runChatDelegation: ReturnType<typeof vi.fn>;
    };
    service.runChatDelegation = vi.fn(async (_sessionId, _input, callbacks) => {
      await callbacks?.onStatus?.({ runId: "run-1", taskId: "task-1", message: "Delegation started." });
      throw new Error("delegation failed mid-stream");
    });

    const stream = ChatDelegationService.prototype.runChatDelegationStream.call(service, "sess-1", {
      objective: "stream failure",
      roles: ["qa"],
    });

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "status", runId: "run-1", taskId: "task-1" },
      done: false,
    });
    await expect(stream.next()).rejects.toThrow(/delegation failed mid-stream/);
  });
});
