import type {
  AgenticSubagentMetadata,
  AgenticTaskContext,
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  ChatSendMessageResponse,
  ChatSessionPrefsRecord,
  TaskActivityRecord,
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
    subagentDefaults?: { childTimeoutSeconds: number; coworkChildTimeoutSeconds?: number | null; maxDepth: number };
    callerSubagentRecord?: TaskSubagentSession;
  } = {},
) {
  const prefs = options.prefs ?? buildPrefs();
  const steps = new Map<string, ChatDelegationStepRecord>();
  const runs = new Map<string, ChatDelegationRunRecord>();
  const dispatchClaims = new Map<string, { token: string; expiresAt: string }>();
  let taskState:
    | {
        taskId: string;
        status: "in_progress" | "review" | "blocked";
        agenticContext?: AgenticTaskContext;
      }
    | undefined;
  const databaseNowIso = "2026-07-11T00:00:00.000Z";
  let childSessionCounter = 0;
  const appendTaskActivity = vi.fn();
  const appendTaskDeliverable = vi.fn();
  const activityReceipts = new Map<string, TaskActivityRecord>();

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
      createTask: vi.fn((input: Parameters<ChatDelegationServiceHost["taskLifecycleService"]["createTask"]>[0]) => {
        taskState = { taskId: "task-1", status: input.status, agenticContext: input.agenticContext };
        return taskState;
      }),
      getTask: vi.fn(() => taskState!),
      lockTaskForDelegationAggregate: vi.fn(() => taskState!),
      lockDelegationSubagentProjection: vi.fn((agentSessionId: string) => ({
        subagentSessionId: `subagent-${agentSessionId}`,
        taskId: "task-1",
        agentSessionId,
        status: "active" as const,
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      })),
      appendTaskActivity,
      appendTaskDeliverable,
      updateTask: vi.fn((_taskId: string, patch: { status: "in_progress" | "review" | "blocked" }) => {
        taskState = { ...taskState!, ...patch };
        return taskState;
      }),
      updateTaskAgenticContext: vi.fn((_taskId: string, patch: Partial<AgenticTaskContext>) => {
        taskState = { ...taskState!, agenticContext: { ...(taskState?.agenticContext ?? {}), ...patch } };
        return taskState;
      }),
      persistDelegationAggregateTask: vi.fn(
        (
          _taskId: string,
          input: { status: "in_progress" | "review" | "blocked"; agenticContext: Partial<AgenticTaskContext> },
        ) => {
          taskState = {
            ...taskState!,
            status: input.status,
            agenticContext: { ...(taskState?.agenticContext ?? {}), ...input.agenticContext },
          };
          return taskState as never;
        },
      ),
      publishDelegationAggregateTask: vi.fn(),
      persistDelegationSubagentProjection: vi.fn((agentSessionId: string, patch) => ({
        subagentSessionId: `subagent-${agentSessionId}`,
        taskId: "task-1",
        agentSessionId,
        status: patch.status,
        metadata: patch.metadata,
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:01.000Z",
        endedAt: patch.endedAt,
      })),
      publishDelegationSubagentProjection: vi.fn(),
      persistDelegationActivity: vi.fn((taskId: string, input, createdAt: string) => {
        appendTaskActivity(taskId, input);
        return { activityId: `activity-${appendTaskActivity.mock.calls.length}`, taskId, ...input, createdAt };
      }),
      persistDelegationActivityOnce: vi.fn((activityId: string, taskId: string, input, createdAt: string) => {
        const existing = activityReceipts.get(activityId);
        if (existing) {
          return { activity: existing, created: false };
        }
        appendTaskActivity(taskId, input);
        const activity = { activityId, taskId, ...input, createdAt };
        activityReceipts.set(activityId, activity);
        return { activity, created: true };
      }),
      publishDelegationActivity: vi.fn(),
      persistDelegationDeliverable: vi.fn((taskId: string, input, createdAt: string) => {
        appendTaskDeliverable(taskId, input);
        return { deliverableId: `deliverable-${appendTaskDeliverable.mock.calls.length}`, taskId, ...input, createdAt };
      }),
      publishDelegationDeliverable: vi.fn(),
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
        create: vi.fn((input: Omit<ChatDelegationRunRecord, "startedAt"> & { startedAt?: string }) => {
          const run = { ...input, startedAt: input.startedAt ?? "2026-07-11T00:00:00.000Z" };
          runs.set(run.runId, run);
          return run;
        }),
        patch: vi.fn((runId: string, patch: Partial<ChatDelegationRunRecord> & { clearFinishedAt?: boolean }) => {
          const { clearFinishedAt, ...persistedPatch } = patch;
          const run = {
            ...runs.get(runId)!,
            ...persistedPatch,
            ...(clearFinishedAt ? { finishedAt: undefined } : {}),
          };
          runs.set(runId, run);
          return run;
        }),
        get: vi.fn((runId: string) => runs.get(runId)!),
        getForUpdate: vi.fn((runId: string) => runs.get(runId)!),
      },
      chatDelegationSteps: {
        readDatabaseNow: vi.fn(() => databaseNowIso),
        get: vi.fn((stepId: string) => {
          const step = steps.get(stepId);
          if (!step) {
            throw new Error(`unknown step ${stepId}`);
          }
          return step;
        }),
        getDispatchClaim: vi.fn((stepId: string) => dispatchClaims.get(stepId)),
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
          const next = {
            ...current,
            ...patch,
            childSessionId:
              patch.childSessionId === null ? undefined : (patch.childSessionId ?? current.childSessionId),
            childTurnId: patch.childTurnId === null ? undefined : (patch.childTurnId ?? current.childTurnId),
          };
          steps.set(stepId, next);
          if (
            patch.status === "completed" ||
            patch.status === "failed" ||
            patch.status === "cancelled" ||
            patch.status === "skipped"
          ) {
            dispatchClaims.delete(stepId);
          }
          return next;
        }),
        listByRun: vi.fn((runId: string) =>
          [...steps.values()].filter((step) => step.runId === runId).sort((left, right) => left.index - right.index),
        ),
        listByRunForUpdate: vi.fn((runId: string) =>
          [...steps.values()].filter((step) => step.runId === runId).sort((left, right) => left.index - right.index),
        ),
        claimPendingForDispatch: vi.fn((stepId: string, token: string, expiresAt: string, startedAt: string) => {
          const current = steps.get(stepId);
          if (!current || current.status !== "pending" || dispatchClaims.has(stepId)) {
            return undefined;
          }
          const next = { ...current, status: "running" as const, startedAt };
          steps.set(stepId, next);
          dispatchClaims.set(stepId, { token, expiresAt });
          return next;
        }),
        reclaimRunningForDispatch: vi.fn(
          (stepId: string, expectedToken: string | undefined, token: string, expiresAt: string, startedAt: string) => {
            const current = steps.get(stepId);
            const claim = dispatchClaims.get(stepId);
            if (
              !current ||
              current.status !== "running" ||
              current.childSessionId ||
              (expectedToken === undefined ? claim !== undefined : claim?.token !== expectedToken)
            ) {
              return undefined;
            }
            const next = { ...current, startedAt };
            steps.set(stepId, next);
            dispatchClaims.set(stepId, { token, expiresAt });
            return next;
          },
        ),
        linkClaimedDispatch: vi.fn(
          (stepId: string, claimToken: string, childSessionId: string, token: string, expiresAt: string) => {
            const current = steps.get(stepId);
            if (!current || dispatchClaims.get(stepId)?.token !== claimToken || current.childSessionId) {
              return undefined;
            }
            const next = { ...current, childSessionId };
            steps.set(stepId, next);
            dispatchClaims.set(stepId, { token, expiresAt });
            return next;
          },
        ),
        claimLinkedForDispatch: vi.fn(
          (
            stepId: string,
            childSessionId: string,
            expectedChildTurnId: string | undefined,
            token: string,
            expiresAt: string,
            startedAt: string,
          ) => {
            const current = steps.get(stepId);
            if (
              !current ||
              current.childSessionId !== childSessionId ||
              current.childTurnId !== expectedChildTurnId ||
              dispatchClaims.has(stepId)
            ) {
              return undefined;
            }
            const next = { ...current, startedAt };
            steps.set(stepId, next);
            dispatchClaims.set(stepId, { token, expiresAt });
            return next;
          },
        ),
        reclaimLinkedDispatch: vi.fn(
          (
            stepId: string,
            childSessionId: string,
            expectedToken: string,
            token: string,
            expiresAt: string,
            startedAt: string,
          ) => {
            const current = steps.get(stepId);
            if (
              !current ||
              current.childSessionId !== childSessionId ||
              dispatchClaims.get(stepId)?.token !== expectedToken
            ) {
              return undefined;
            }
            const next = { ...current, startedAt };
            steps.set(stepId, next);
            dispatchClaims.set(stepId, { token, expiresAt });
            return next;
          },
        ),
        finalizeLinkedDispatch: vi.fn(
          (stepId: string, childSessionId: string, expectedToken: string, childTurnId: string) => {
            const current = steps.get(stepId);
            if (
              !current ||
              current.childSessionId !== childSessionId ||
              dispatchClaims.get(stepId)?.token !== expectedToken
            ) {
              return undefined;
            }
            const next = { ...current, childTurnId };
            steps.set(stepId, next);
            dispatchClaims.delete(stepId);
            return next;
          },
        ),
        ownsLinkedDispatch: vi.fn((stepId: string, childSessionId: string, token: string) => {
          const current = steps.get(stepId);
          const claim = dispatchClaims.get(stepId);
          return Boolean(
            current?.status === "running" &&
            current.childSessionId === childSessionId &&
            claim?.token === token &&
            Date.parse(claim.expiresAt) > Date.parse(databaseNowIso),
          );
        }),
        finishOwnedDispatchWithError: vi.fn(
          (input: {
            stepId: string;
            expectedDispatchToken: string;
            expectedChildSessionId?: string;
            status: "failed" | "cancelled" | "skipped";
            label?: string;
            summary?: string;
            error: string;
            failureGuidance?: string;
            finishedAt: string;
            durationMs: number;
          }) => {
            const current = steps.get(input.stepId);
            const claim = dispatchClaims.get(input.stepId);
            if (
              !current ||
              current.status !== "running" ||
              current.childSessionId !== input.expectedChildSessionId ||
              claim?.token !== input.expectedDispatchToken ||
              Date.parse(claim.expiresAt) <= Date.parse(databaseNowIso)
            ) {
              return undefined;
            }
            const next = {
              ...current,
              status: input.status,
              label: input.label,
              summary: input.summary,
              error: input.error,
              failureGuidance: input.failureGuidance,
              finishedAt: input.finishedAt,
              durationMs: input.durationMs,
            };
            steps.set(input.stepId, next);
            dispatchClaims.delete(input.stepId);
            return next;
          },
        ),
        finishOwnedDispatchWithResponse: vi.fn(
          (input: {
            stepId: string;
            expectedDispatchToken: string;
            childSessionId: string;
            childTurnId: string;
            status: "running" | "completed" | "failed" | "cancelled";
            providerId?: string;
            model?: string;
            label?: string;
            summary?: string;
            output: string;
            error?: string;
            failureGuidance?: string;
            durableRunId?: string;
            citations: ChatCitationRecord[];
            finishedAt?: string;
            durationMs?: number;
          }) => {
            const current = steps.get(input.stepId);
            const claim = dispatchClaims.get(input.stepId);
            if (
              !current ||
              current.status !== "running" ||
              current.childSessionId !== input.childSessionId ||
              (current.childTurnId !== undefined && current.childTurnId !== input.childTurnId) ||
              claim?.token !== input.expectedDispatchToken ||
              Date.parse(claim.expiresAt) <= Date.parse(databaseNowIso)
            ) {
              return undefined;
            }
            const next = {
              ...current,
              status: input.status,
              providerId: input.providerId,
              model: input.model,
              label: input.label,
              summary: input.summary,
              output: input.output,
              error: input.error,
              failureGuidance: input.failureGuidance,
              durableRunId: input.durableRunId ?? current.durableRunId,
              childTurnId: input.childTurnId,
              citations: input.citations,
              finishedAt: input.finishedAt,
              durationMs: input.durationMs,
            };
            steps.set(input.stepId, next);
            if (input.status !== "running") {
              dispatchClaims.delete(input.stepId);
            }
            return next;
          },
        ),
        releaseOwnedWaitingDispatch: vi.fn(
          (input: { stepId: string; expectedDispatchToken: string; childSessionId: string; childTurnId: string }) => {
            const current = steps.get(input.stepId);
            const claim = dispatchClaims.get(input.stepId);
            if (
              !current ||
              current.status !== "running" ||
              current.childSessionId !== input.childSessionId ||
              current.childTurnId !== input.childTurnId ||
              claim?.token !== input.expectedDispatchToken ||
              Date.parse(claim.expiresAt) <= Date.parse(databaseNowIso)
            ) {
              return undefined;
            }
            dispatchClaims.delete(input.stepId);
            return current;
          },
        ),
        finishUnclaimedPendingWithError: vi.fn(
          (input: {
            stepId: string;
            status: "failed" | "cancelled";
            label?: string;
            summary?: string;
            error: string;
            failureGuidance?: string;
            finishedAt: string;
            durationMs: number;
          }) => {
            const current = steps.get(input.stepId);
            if (
              !current ||
              current.status !== "pending" ||
              current.childSessionId !== undefined ||
              current.childTurnId !== undefined ||
              dispatchClaims.has(input.stepId)
            ) {
              return undefined;
            }
            const next = {
              ...current,
              status: input.status,
              label: input.label,
              summary: input.summary,
              error: input.error,
              failureGuidance: input.failureGuidance,
              finishedAt: input.finishedAt,
              durationMs: input.durationMs,
            };
            steps.set(input.stepId, next);
            return next;
          },
        ),
      },
      taskSubagents: {
        findByAgentSessionId: vi.fn((agentSessionId: string) =>
          options.callerSubagentRecord && options.callerSubagentRecord.agentSessionId === agentSessionId
            ? options.callerSubagentRecord
            : undefined,
        ),
      },
      runImmediateTransaction: <T>(callback: () => T): T => callback(),
    },
    subagentDefaults: options.subagentDefaults,
  } satisfies ChatDelegationServiceHost;

  return {
    deps,
    service: new ChatDelegationService(deps),
    steps,
    dispatchClaims,
  };
}

describe("ChatDelegationService subagent budget enforcement", () => {
  it("rejects max_depth_exceeded before child side effects while preserving failed step evidence", async () => {
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
    expect(result.stitchedOutput).toContain("FAILED: max_depth_exceeded");
    expect(result.steps[0]?.childSessionId).toBeUndefined();
    expect(deps.createChatSession).not.toHaveBeenCalled();
    expect(deps.inheritDelegatedSessionToolGrants).not.toHaveBeenCalled();
    expect(deps.updateChatSessionPrefs).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.registerTaskSubagent).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.updateTaskSubagent).not.toHaveBeenCalled();
    expect(deps.agentSendChatMessage).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.appendTaskActivity).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        activityType: "diagnostic",
        message: expect.stringContaining("max_depth_exceeded"),
        metadata: expect.objectContaining({ diagnosticCode: "max_depth_exceeded" }),
      }),
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

  it("kills a non-Cowork child that runs past childTimeoutSeconds and surfaces timeout_exceeded", async () => {
    const { deps, service } = createHarness({
      prefs: buildPrefs({ mode: "chat" }),
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
    expect(deps.taskLifecycleService.persistDelegationSubagentProjection).toHaveBeenCalledWith(
      "delegate-session-1",
      expect.objectContaining({ status: "failed" }),
    );
    expect(deps.storage.chatDelegationRuns.patch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("buffers a child rejection fired synchronously by timeout abort until the failure CAS wins", async () => {
    const { deps, service } = createHarness({
      prefs: buildPrefs({ mode: "chat" }),
      subagentDefaults: { childTimeoutSeconds: 0.01, maxDepth: 4 },
    });
    deps.agentSendChatMessage = vi.fn(
      async (_childSessionId: string, _request: unknown, options?: { abortSignal?: AbortSignal }) =>
        new Promise<ChatSendMessageResponse>((_resolve, reject) => {
          const rejectOnAbort = (): void => reject(new Error("synchronous child abort rejection"));
          if (options?.abortSignal?.aborted) {
            rejectOnAbort();
            return;
          }
          options?.abortSignal?.addEventListener("abort", rejectOnAbort, { once: true });
        }),
    ) as never;

    const result = await service.runChatDelegation("sess-1", {
      objective: "Preserve the synchronous timeout-abort diagnostic",
      roles: ["researcher"],
    });
    await flushSettledPromises();

    expect(result.steps[0]).toEqual(
      expect.objectContaining({ status: "failed", error: expect.stringMatching(/timeout_exceeded/) }),
    );
    expect(deps.taskLifecycleService.appendTaskActivity).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        activityType: "diagnostic",
        message: expect.stringContaining("synchronous child abort rejection"),
        metadata: expect.objectContaining({ lateStatus: "failed", ignoredAsDeliverableTruth: true }),
      }),
    );
    expect(deps.taskLifecycleService.updateTaskSubagent).toHaveBeenLastCalledWith(
      "delegate-session-1",
      expect.objectContaining({
        status: "failed",
        metadata: expect.objectContaining({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: "timeout_exceeded" }),
            expect.objectContaining({ code: "child_timeout", title: "Subagent failed after timeout" }),
          ]),
        }),
      }),
    );
    expect(
      deps.taskLifecycleService.updateTaskSubagent.mock.calls.filter(([, patch]) =>
        patch.metadata?.diagnostics?.some((diagnostic) => diagnostic.code === "child_timeout"),
      ),
    ).toHaveLength(1);
    expect(
      deps.taskLifecycleService.appendTaskActivity.mock.calls.filter(([, activity]) =>
        activity.message.includes("synchronous child abort rejection"),
      ),
    ).toHaveLength(1);
  });

  it("applies the default child timeout to legacy Cowork children", async () => {
    const { deps, service } = createHarness({
      subagentDefaults: { childTimeoutSeconds: 0.01, coworkChildTimeoutSeconds: null, maxDepth: 4 },
    });
    deps.agentSendChatMessage = vi.fn(async (childSessionId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return createChatResponse(childSessionId, {
        assistantMessage: {
          ...createChatResponse(childSessionId).assistantMessage!,
          content: "slow cowork child completed",
        },
      });
    }) as never;

    const result = await service.runChatDelegation("sess-1", {
      objective: "Run a slow Cowork delegate",
      roles: ["researcher"],
    });

    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.stringMatching(/timeout_exceeded/),
      }),
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
    expect(deps.createChatSession).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.registerTaskSubagent).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.updateTaskSubagent).not.toHaveBeenCalled();
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
      prefs: buildPrefs({ mode: "chat" }),
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

  it("forwards streamed delegation aborts into child chat execution", async () => {
    const { deps, service } = createHarness({
      subagentDefaults: { childTimeoutSeconds: 600, maxDepth: 4 },
    });
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let agentStarted = () => undefined;
    const agentStartedPromise = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    deps.agentSendChatMessage = vi.fn(
      async (_childSessionId: string, _request: unknown, options?: { abortSignal?: AbortSignal }) => {
        observedSignal = options?.abortSignal;
        agentStarted();
        await new Promise<never>((_resolve, reject) => {
          const signal = options?.abortSignal;
          if (signal?.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
            { once: true },
          );
        });
      },
    ) as never;

    const stream = service.runChatDelegationStream(
      "sess-1",
      {
        objective: "Run a streaming delegate",
        roles: ["researcher"],
      },
      { abortSignal: controller.signal },
    );

    const first = await stream.next();
    expect(first.value?.type).toBe("status");
    await agentStartedPromise;
    controller.abort(new Error("stream disconnected"));

    await expect.poll(() => observedSignal?.aborted).toBe(true);
    await stream.return?.(undefined);
  });

  it("records late child timeout success as diagnostics without promoting it to deliverable truth", async () => {
    const { deps, service } = createHarness({
      prefs: buildPrefs({ mode: "chat" }),
      subagentDefaults: { childTimeoutSeconds: 0.01, maxDepth: 4 },
    });
    let resolveChild: (response: ChatSendMessageResponse) => void = () => undefined;
    deps.agentSendChatMessage = vi.fn(async (childSessionId: string) =>
      new Promise<ChatSendMessageResponse>((resolve) => {
        resolveChild = resolve;
      }).then(() =>
        createChatResponse(childSessionId, {
          assistantMessage: {
            ...createChatResponse(childSessionId).assistantMessage!,
            content: "late child success that must not become truth",
          },
          citations: [{ citationId: "late-cite", title: "Late source" }],
        }),
      ),
    ) as never;

    const result = await service.runChatDelegation("sess-1", {
      objective: "Run a slow delegate that eventually succeeds",
      roles: ["researcher"],
    });

    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.stringMatching(/timeout_exceeded/),
        output: undefined,
      }),
    );
    expect(result.stitchedOutput).toContain("FAILED: timeout_exceeded");
    expect(result.stitchedOutput).not.toContain("late child success");
    expect(result.citations).toEqual([]);
    expect(deps.taskLifecycleService.appendTaskDeliverable).not.toHaveBeenCalled();

    resolveChild(createChatResponse("delegate-session-1"));
    await flushSettledPromises();

    expect(deps.taskLifecycleService.appendTaskDeliverable).not.toHaveBeenCalled();
    expect(deps.storage.chatDelegationSteps.patch).not.toHaveBeenCalledWith(
      result.steps[0]?.stepId,
      expect.objectContaining({ status: "completed" }),
    );
    expect(deps.taskLifecycleService.appendTaskActivity).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        activityType: "diagnostic",
        message: expect.stringContaining("completed after its timeout"),
        metadata: expect.objectContaining({
          lateStatus: "completed",
          ignoredAsDeliverableTruth: true,
          citationCount: 1,
          outputPreview: "late child success that must not become truth",
        }),
      }),
    );
    expect(deps.taskLifecycleService.updateTaskSubagent).toHaveBeenLastCalledWith(
      "delegate-session-1",
      expect.objectContaining({
        status: "failed",
        metadata: expect.objectContaining({
          failureClass: "timeout",
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: "timeout_exceeded" }),
            expect.objectContaining({ code: "child_timeout", title: "Subagent completed after timeout" }),
          ]),
        }),
      }),
    );
  });

  it("ignores late settlement when the timed-out attempt loses its canonical failure fence", async () => {
    const { deps, service, steps, dispatchClaims } = createHarness({
      prefs: buildPrefs({ mode: "chat" }),
      subagentDefaults: { childTimeoutSeconds: 0.01, maxDepth: 4 },
    });
    let resolveChild: (response: ChatSendMessageResponse) => void = () => undefined;
    deps.agentSendChatMessage = vi.fn(
      async () =>
        new Promise<ChatSendMessageResponse>((resolve) => {
          resolveChild = resolve;
        }),
    ) as never;
    deps.storage.chatDelegationSteps.finishOwnedDispatchWithError.mockImplementation((input) => {
      dispatchClaims.set(input.stepId, {
        token: "replacement-timeout-owner",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      return undefined;
    });

    const result = await service.runChatDelegation("sess-1", {
      objective: "Race a timeout against a replacement owner",
      roles: ["researcher"],
    });
    const racedStep = result.steps[0]!;
    expect(racedStep.status).toBe("running");
    expect(steps.get(racedStep.stepId)?.status).toBe("running");
    expect(dispatchClaims.get(racedStep.stepId)?.token).toBe("replacement-timeout-owner");
    expect(deps.taskLifecycleService.updateTaskSubagent).not.toHaveBeenCalled();
    const activityCountBeforeLateSettle = deps.taskLifecycleService.appendTaskActivity.mock.calls.length;

    resolveChild(createChatResponse("delegate-session-1"));
    await flushSettledPromises();

    expect(deps.taskLifecycleService.updateTaskSubagent).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.appendTaskActivity).toHaveBeenCalledTimes(activityCountBeforeLateSettle);
    expect(deps.taskLifecycleService.appendTaskActivity).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ message: expect.stringContaining("completed after its timeout") }),
    );
  });

  it("records late child timeout failure as diagnostics without replacing timeout truth", async () => {
    const { deps, service } = createHarness({
      prefs: buildPrefs({ mode: "chat" }),
      subagentDefaults: { childTimeoutSeconds: 0.01, maxDepth: 4 },
    });
    let rejectChild: (error: Error) => void = () => undefined;
    deps.agentSendChatMessage = vi.fn(
      async () =>
        new Promise<ChatSendMessageResponse>((_resolve, reject) => {
          rejectChild = reject;
        }),
    ) as never;

    const result = await service.runChatDelegation("sess-1", {
      objective: "Run a slow delegate that eventually fails",
      roles: ["researcher"],
    });

    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.stringMatching(/timeout_exceeded/),
      }),
    );

    rejectChild(new Error("late provider crash"));
    await flushSettledPromises();

    expect(deps.taskLifecycleService.appendTaskActivity).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        activityType: "diagnostic",
        message: expect.stringContaining("late provider crash"),
        metadata: expect.objectContaining({
          lateStatus: "failed",
          ignoredAsDeliverableTruth: true,
          error: "late provider crash",
        }),
      }),
    );
    expect(deps.taskLifecycleService.updateTaskSubagent).toHaveBeenLastCalledWith(
      "delegate-session-1",
      expect.objectContaining({
        status: "failed",
        metadata: expect.objectContaining({
          failureClass: "timeout",
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: "timeout_exceeded" }),
            expect.objectContaining({ code: "child_timeout", title: "Subagent failed after timeout" }),
          ]),
        }),
      }),
    );
    expect(deps.storage.chatDelegationRuns.patch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "failed", stitchedOutput: expect.stringContaining("timeout_exceeded") }),
    );
  });
});

async function flushSettledPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}
