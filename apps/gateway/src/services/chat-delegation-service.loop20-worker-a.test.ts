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
      providerId: "anthropic",
      model: "claude-sonnet",
      surfaceMode: "cowork",
    });

    expect(parsedResult).toBe(parsed.response);
    expect(parsed.runSpy).toHaveBeenCalledWith("sess-1", {
      objective: "Stored objective",
      roles: ["Architect", "QA"],
      mode: "sequential",
      providerId: "anthropic",
      model: "claude-sonnet",
      surfaceMode: "cowork",
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
    });
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
    expect(cycleHarness.deps.taskLifecycleService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Run dependency cycle" }),
    );
  });

  it("classifies waiting delegate responses as failed steps with actionable output", async () => {
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
        status: "failed",
        output: "approval gate tripped",
        error: "approval gate tripped",
        failureGuidance: expect.stringContaining("Researcher"),
      }),
    );
    expect(deps.taskLifecycleService.updateTaskSubagent).toHaveBeenCalledWith(
      "delegate-session-1",
      expect.objectContaining({
        status: "failed",
        metadata: expect.objectContaining({ failureClass: "missing_handoff" }),
      }),
    );
    expect(deps.storage.chatDelegationRuns.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "failed", stitchedOutput: expect.stringContaining("FAILED") }),
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
