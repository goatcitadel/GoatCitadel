import type {
  AgenticSubagentMetadata,
  ChatDelegationStepRecord,
  ChatSendMessageResponse,
  ChatSessionPrefsRecord,
  TaskSubagentSession,
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
    citations: [],
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

function buildSubagentRecord(input: {
  agentSessionId: string;
  metadata?: AgenticSubagentMetadata;
}): TaskSubagentSession {
  return {
    subagentSessionId: `sub-${input.agentSessionId}`,
    taskId: "task-parent",
    agentSessionId: input.agentSessionId,
    agentName: "test-agent",
    status: "active",
    metadata: input.metadata,
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
  };
}

function createHarness(
  options: {
    prefs?: ChatSessionPrefsRecord;
    projectId?: string;
    subagentDefaults?: { childTimeoutSeconds: number; maxDepth: number };
    callerSubagentRecord?: TaskSubagentSession;
  } = {},
) {
  const prefs = options.prefs ?? buildPrefs();
  const steps = new Map<string, ChatDelegationStepRecord>();
  let childSessionCounter = 0;

  const deps = {
    getSession: vi.fn(() => ({ sessionId: "sess-1" })),
    listChatMessages: vi.fn(async () => []),
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
        findByAgentSessionId: vi.fn((agentSessionId: string) =>
          options.callerSubagentRecord && options.callerSubagentRecord.agentSessionId === agentSessionId
            ? options.callerSubagentRecord
            : undefined,
        ),
      },
    },
    subagentDefaults: options.subagentDefaults,
  } satisfies ChatDelegationServiceHost;

  return {
    deps,
    service: new ChatDelegationService(deps),
    steps,
  };
}

describe("ChatDelegationService subagent budget enforcement", () => {
  it("rejects a child spawn with max_depth_exceeded when parent depth meets the budget", async () => {
    const { deps, service } = createHarness({
      subagentDefaults: { childTimeoutSeconds: 600, maxDepth: 2 },
    });

    const result = await service.runChatDelegation("sess-1", {
      objective: "Plan deep delegation",
      roles: ["architect"],
      parentSubagentDepth: 2,
    });

    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.stringMatching(/max_depth_exceeded/),
      }),
    );
    expect(deps.agentSendChatMessage).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.updateTaskSubagent).toHaveBeenCalledWith(
      "delegate-session-1",
      expect.objectContaining({ status: "failed" }),
    );
    expect(deps.storage.chatDelegationRuns.patch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("records depth on child subagent metadata using parentSubagentDepth + 1", async () => {
    const { deps, service } = createHarness({
      subagentDefaults: { childTimeoutSeconds: 600, maxDepth: 5 },
    });

    await service.runChatDelegation("sess-1", {
      objective: "Plan with explicit depth",
      roles: ["architect"],
      parentSubagentDepth: 1,
    });

    expect(deps.taskLifecycleService.registerTaskSubagent).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        metadata: expect.objectContaining({ depth: 2 }),
      }),
    );
  });

  it("defaults child depth to 1 when no parent depth is supplied", async () => {
    const { deps, service } = createHarness({
      subagentDefaults: { childTimeoutSeconds: 600, maxDepth: 5 },
    });

    await service.runChatDelegation("sess-1", {
      objective: "Plan without parent depth",
      roles: ["architect"],
    });

    expect(deps.taskLifecycleService.registerTaskSubagent).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        metadata: expect.objectContaining({ depth: 1 }),
      }),
    );
  });

  it("kills a child that runs past childTimeoutSeconds and surfaces timeout_exceeded", async () => {
    const { deps, service } = createHarness({
      subagentDefaults: { childTimeoutSeconds: 0.05, maxDepth: 4 },
    });
    deps.agentSendChatMessage = vi.fn(async (childSessionId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return createChatResponse(childSessionId);
    }) as never;

    const result = await service.runChatDelegation("sess-1", {
      objective: "Run a slow delegate",
      roles: ["researcher"],
    });

    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.stringMatching(/timeout_exceeded/),
      }),
    );
    expect(deps.taskLifecycleService.updateTaskSubagent).toHaveBeenCalledWith(
      "delegate-session-1",
      expect.objectContaining({ status: "failed" }),
    );
    expect(deps.storage.chatDelegationRuns.patch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("rejects depth=4 chain via recursive parent lookup (caller is a subagent at depth 3, maxDepth=4)", async () => {
    const callerSubagentRecord = buildSubagentRecord({
      agentSessionId: "grandchild-session",
      metadata: { depth: 3, profileId: "researcher", runId: "run-parent" },
    });
    const { deps, service } = createHarness({
      subagentDefaults: { childTimeoutSeconds: 600, maxDepth: 4 },
      callerSubagentRecord,
    });

    const result = await service.runChatDelegation("grandchild-session", {
      objective: "Spawn yet another subagent",
      roles: ["architect"],
    });

    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.stringMatching(/max_depth_exceeded/),
      }),
    );
    expect(deps.storage.taskSubagents.findByAgentSessionId).toHaveBeenCalledWith("grandchild-session");
    expect(deps.agentSendChatMessage).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.registerTaskSubagent).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        metadata: expect.objectContaining({ depth: 4 }),
      }),
    );
  });

  it("explicit parentSubagentDepth overrides the recursive lookup", async () => {
    const callerSubagentRecord = buildSubagentRecord({
      agentSessionId: "grandchild-session",
      metadata: { depth: 3 },
    });
    const { deps, service } = createHarness({
      subagentDefaults: { childTimeoutSeconds: 600, maxDepth: 5 },
      callerSubagentRecord,
    });

    await service.runChatDelegation("grandchild-session", {
      objective: "Spawn with explicit depth override",
      roles: ["architect"],
      parentSubagentDepth: 1,
    });

    expect(deps.taskLifecycleService.registerTaskSubagent).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        metadata: expect.objectContaining({ depth: 2 }),
      }),
    );
  });

  it("forwards AbortSignal into agentSendChatMessage when the budget timer fires", async () => {
    const { deps, service } = createHarness({
      subagentDefaults: { childTimeoutSeconds: 0.02, maxDepth: 4 },
    });
    let observedSignal: AbortSignal | undefined;
    deps.agentSendChatMessage = vi.fn(
      async (_childSessionId: string, _request: unknown, options?: { abortSignal?: AbortSignal }) => {
        observedSignal = options?.abortSignal;
        await new Promise<void>((resolve, reject) => {
          if (options?.abortSignal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          const onAbort = (): void => {
            reject(new Error("aborted"));
          };
          options?.abortSignal?.addEventListener("abort", onAbort);
          setTimeout(() => resolve(undefined), 500);
        });
        return createChatResponse("late");
      },
    ) as never;

    const result = await service.runChatDelegation("sess-1", {
      objective: "Run a slow delegate that watches the signal",
      roles: ["researcher"],
    });

    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.stringMatching(/timeout_exceeded/),
      }),
    );
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
  });
});
