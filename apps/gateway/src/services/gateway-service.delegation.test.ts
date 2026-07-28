import { describe, expect, it, vi } from "vitest";
import type {
  AgenticTaskContext,
  ChatCitationRecord,
  ChatDelegateResponse,
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  ChatSendMessageResponse,
  ChatSessionPrefsRecord,
  TaskActivityRecord,
  TaskRecord,
  TaskSubagentSession,
} from "@goatcitadel/contracts";
import { GatewayService } from "./gateway-service.js";
import { ChatDelegationService } from "./chat-delegation-service.js";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

function buildPrefs(): ChatSessionPrefsRecord {
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
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
  };
}

function createDelegationHarness() {
  const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, unknown>;
  gateway.config = { assistant: { deploymentProfile: "local_dev" } };
  const prefs = buildPrefs();
  const runs = new Map<string, ChatDelegationRunRecord>();
  const steps = new Map<string, ChatDelegationStepRecord>();
  const dispatchClaims = new Map<string, { token: string; expiresAt: string }>();
  const tasks = new Map<string, TaskRecord>();
  const subagents = new Map<string, TaskSubagentSession>();
  const activityReceipts = new Map<string, TaskActivityRecord>();
  const sessionRoles = new Map<string, string>();
  const databaseNow = "2026-04-19T00:00:00.000Z";
  let childSessionCounter = 0;

  const createStepRecord = (
    input: Partial<ChatDelegationStepRecord> &
      Pick<ChatDelegationStepRecord, "stepId" | "runId" | "role" | "index" | "startedAt">,
  ): ChatDelegationStepRecord => ({
    stepId: input.stepId,
    runId: input.runId,
    role: input.role,
    status: input.status ?? "pending",
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
  });

  const buildResponse = (role: string, childSessionId: string, failed = false): ChatSendMessageResponse => ({
    sessionId: childSessionId,
    transport: "llm",
    userMessage: {
      messageId: `user-${role}`,
      sessionId: childSessionId,
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "delegate task",
      timestamp: "2026-04-19T00:00:00.000Z",
    },
    assistantMessage: {
      messageId: `assistant-${role}`,
      sessionId: childSessionId,
      role: "assistant",
      actorType: "agent",
      actorId: role,
      content: `${role} output`,
      timestamp: "2026-04-19T00:00:01.000Z",
    },
    model: "gpt-5.4",
    turnId: `child-turn-${role}`,
    citations: [],
    routing: {
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5.4",
    },
    trace: {
      turnId: `child-turn-${role}`,
      sessionId: childSessionId,
      userMessageId: `user-${role}`,
      branchKind: "append",
      status: failed ? "failed" : "completed",
      mode: "cowork",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      startedAt: "2026-04-19T00:00:00.000Z",
      finishedAt: "2026-04-19T00:00:01.000Z",
      toolRuns: [],
      citations: [],
      routing: {
        effectiveProviderId: "openai",
        effectiveModel: "gpt-5.4",
      },
      failure: failed
        ? {
            failureClass: "delegate_error",
            message: `${role} failed`,
            retryable: false,
          }
        : undefined,
      durable: {
        runId: `durable-${role}`,
        status: failed ? "failed" : "completed",
      },
    },
  });

  gateway.getSession = vi.fn(() => ({ sessionId: "sess-1" }));
  gateway.ensureChatSessionModelDefaults = vi.fn((_sessionId: string, nextPrefs: ChatSessionPrefsRecord) => nextPrefs);
  gateway.normalizeWorkspaceId = vi.fn((workspaceId?: string) => workspaceId ?? "default");
  gateway.resolveDelegatedFilesystemScope = vi.fn(() => undefined);
  const appendTaskActivity = vi.fn();
  const appendTaskDeliverable = vi.fn();
  gateway.taskLifecycleService = {
    createTask: vi.fn(
      (
        input: {
          workspaceId?: string;
          title: string;
          description?: string;
          status: TaskRecord["status"];
          priority: TaskRecord["priority"];
          createdBy?: string;
          agenticContext?: AgenticTaskContext;
        },
        options?: { taskId?: string },
      ) => {
        const task: TaskRecord = {
          taskId: options?.taskId ?? "task-1",
          workspaceId: input.workspaceId,
          title: input.title,
          description: input.description,
          status: input.status,
          priority: input.priority,
          createdBy: input.createdBy,
          agenticContext: input.agenticContext,
          createdAt: databaseNow,
          updatedAt: databaseNow,
        };
        tasks.set(task.taskId, task);
        return task;
      },
    ),
    getTask: vi.fn((taskId: string) => tasks.get(taskId)),
    lockTaskForDelegationAggregate: vi.fn((taskId: string) => tasks.get(taskId)!),
    lockDelegationSubagentProjection: vi.fn((agentSessionId: string) => subagents.get(agentSessionId)!),
    appendTaskActivity,
    appendTaskDeliverable,
    updateTask: vi.fn((taskId: string, patch: Partial<TaskRecord>) => {
      const current = tasks.get(taskId)!;
      const next = { ...current, ...patch, updatedAt: databaseNow };
      tasks.set(taskId, next);
      return next;
    }),
    updateTaskAgenticContext: vi.fn((taskId: string, patch: Partial<AgenticTaskContext>) => {
      const current = tasks.get(taskId)!;
      const next = {
        ...current,
        agenticContext: { ...(current.agenticContext ?? {}), ...patch } as AgenticTaskContext,
        updatedAt: databaseNow,
      };
      tasks.set(taskId, next);
      return next;
    }),
    persistDelegationAggregateTask: vi.fn(
      (taskId: string, input: { status: TaskRecord["status"]; agenticContext: Partial<AgenticTaskContext> }) => {
        const current = tasks.get(taskId)!;
        const next: TaskRecord = {
          ...current,
          status: input.status,
          agenticContext: { ...(current.agenticContext ?? {}), ...input.agenticContext } as AgenticTaskContext,
          updatedAt: databaseNow,
        };
        tasks.set(taskId, next);
        return next;
      },
    ),
    publishDelegationAggregateTask: vi.fn(),
    registerTaskSubagent: vi.fn(
      (
        taskId: string,
        input: { agentSessionId: string; agentName: string; metadata?: TaskSubagentSession["metadata"] },
      ) => {
        const record: TaskSubagentSession = {
          subagentSessionId: `subagent-${input.agentSessionId}`,
          taskId,
          agentSessionId: input.agentSessionId,
          agentName: input.agentName,
          status: "active",
          metadata: input.metadata,
          createdAt: databaseNow,
          updatedAt: databaseNow,
        };
        subagents.set(input.agentSessionId, record);
        return record;
      },
    ),
    updateTaskSubagent: vi.fn(),
    persistDelegationSubagentProjection: vi.fn(
      (
        agentSessionId: string,
        patch: Pick<TaskSubagentSession, "status"> & Partial<Pick<TaskSubagentSession, "metadata" | "endedAt">>,
      ) => {
        const current = subagents.get(agentSessionId)!;
        const next: TaskSubagentSession = {
          ...current,
          ...patch,
          updatedAt: databaseNow,
        };
        subagents.set(agentSessionId, next);
        return next;
      },
    ),
    publishDelegationSubagentProjection: vi.fn(),
    persistDelegationActivity: vi.fn(
      (taskId: string, input: Omit<TaskActivityRecord, "activityId" | "taskId" | "createdAt">, createdAt: string) => {
        appendTaskActivity(taskId, input);
        return {
          activityId: `activity-${appendTaskActivity.mock.calls.length}`,
          taskId,
          ...input,
          createdAt,
        } satisfies TaskActivityRecord;
      },
    ),
    persistDelegationActivityOnce: vi.fn(
      (
        activityId: string,
        taskId: string,
        input: Omit<TaskActivityRecord, "activityId" | "taskId" | "createdAt">,
        createdAt: string,
      ) => {
        const existing = activityReceipts.get(activityId);
        if (existing) {
          const payloadMatches =
            existing.taskId === taskId &&
            existing.agentId === input.agentId &&
            existing.activityType === input.activityType &&
            existing.message === input.message &&
            JSON.stringify(existing.metadata) === JSON.stringify(input.metadata);
          if (!payloadMatches) {
            throw new Error(`Task activity ${activityId} already exists with conflicting payload`);
          }
          return { activity: existing, created: false };
        }
        appendTaskActivity(taskId, input);
        const activity = { activityId, taskId, ...input, createdAt } satisfies TaskActivityRecord;
        activityReceipts.set(activityId, activity);
        return { activity, created: true };
      },
    ),
    publishDelegationActivity: vi.fn(),
    persistDelegationDeliverable: vi.fn((taskId: string, input, createdAt: string) => {
      appendTaskDeliverable(taskId, input);
      return {
        deliverableId: `deliverable-${appendTaskDeliverable.mock.calls.length}`,
        taskId,
        ...input,
        createdAt,
      };
    }),
    publishDelegationDeliverable: vi.fn(),
  };
  gateway.extractAndPersistLearnedMemory = vi.fn();
  gateway.scheduleChatMemoryContextPrewarm = vi.fn();
  gateway.createChatSession = vi.fn((input: { title: string }) => {
    childSessionCounter += 1;
    const sessionId = `delegate-session-${childSessionCounter}`;
    const role = input.title
      .replace(/^Delegate · /, "")
      .trim()
      .toLowerCase();
    sessionRoles.set(sessionId, role);
    return { sessionId };
  });
  gateway.inheritDelegatedSessionToolGrants = vi.fn();
  gateway.updateChatSessionPrefs = vi.fn();
  gateway.agentSendChatMessage = vi.fn(async (childSessionId: string): Promise<ChatSendMessageResponse> => {
    const role = sessionRoles.get(childSessionId) ?? "delegate";
    return buildResponse(role, childSessionId);
  });
  gateway.storage = {
    chatSessionPrefs: {
      ensure: vi.fn(() => prefs),
    },
    chatSessionMeta: {
      ensure: vi.fn(() => ({ workspaceId: "default" })),
    },
    chatSessionProjects: {
      get: vi.fn(() => ({ projectId: "proj-1" })),
    },
    permissionProfiles: {
      resolveContext: vi.fn(() => ({ permissionProfile: { profileId: "safe" } })),
    },
    chatDelegationRuns: {
      create: vi.fn((input: Omit<ChatDelegationRunRecord, "startedAt"> & { startedAt?: string }) => {
        const record: ChatDelegationRunRecord = {
          ...input,
          startedAt: input.startedAt ?? databaseNow,
        };
        runs.set(record.runId, record);
        return record;
      }),
      patch: vi.fn((runId: string, patch: Partial<ChatDelegationRunRecord> & { clearFinishedAt?: boolean }) => {
        const current = runs.get(runId)!;
        const { clearFinishedAt, ...persistedPatch } = patch;
        const next: ChatDelegationRunRecord = {
          ...current,
          ...persistedPatch,
          ...(clearFinishedAt ? { finishedAt: undefined } : {}),
        };
        runs.set(runId, next);
        return next;
      }),
      get: vi.fn((runId: string) => runs.get(runId)!),
      getForUpdate: vi.fn((runId: string) => runs.get(runId)!),
    },
    chatDelegationSteps: {
      readDatabaseNow: vi.fn(() => databaseNow),
      get: vi.fn((stepId: string) => steps.get(stepId)!),
      getDispatchClaim: vi.fn((stepId: string) => dispatchClaims.get(stepId)),
      create: vi.fn(
        (input: {
          stepId: string;
          runId: string;
          role: string;
          index: number;
          status: ChatDelegationStepRecord["status"];
          startedAt: string;
          finishedAt?: string;
          durationMs?: number;
          error?: string;
          failureGuidance?: string;
        }) => {
          const record = createStepRecord(input);
          steps.set(record.stepId, record);
          return record;
        },
      ),
      patch: vi.fn((stepId: string, patch: Partial<ChatDelegationStepRecord>) => {
        const current = steps.get(stepId)!;
        const next = {
          ...current,
          ...patch,
        };
        steps.set(stepId, next);
        return next;
      }),
      listByRun: vi.fn((runId: string) =>
        [...steps.values()].filter((step) => step.runId === runId).sort((a, b) => a.index - b.index),
      ),
      listByRunForUpdate: vi.fn((runId: string) =>
        [...steps.values()].filter((step) => step.runId === runId).sort((a, b) => a.index - b.index),
      ),
      claimPendingForDispatch: vi.fn(
        (stepId: string, claimToken: string, claimExpiresAt: string, startedAt: string) => {
          const current = steps.get(stepId);
          if (!current || current.status !== "pending") return undefined;
          const next = { ...current, status: "running" as const, startedAt };
          steps.set(stepId, next);
          dispatchClaims.set(stepId, { token: claimToken, expiresAt: claimExpiresAt });
          return next;
        },
      ),
      reclaimRunningForDispatch: vi.fn(
        (
          stepId: string,
          expectedClaimToken: string | undefined,
          claimToken: string,
          claimExpiresAt: string,
          startedAt: string,
        ) => {
          const current = steps.get(stepId);
          const existing = dispatchClaims.get(stepId);
          if (
            !current ||
            current.status !== "running" ||
            (expectedClaimToken !== undefined && existing?.token !== expectedClaimToken)
          ) {
            return undefined;
          }
          const next = { ...current, startedAt };
          steps.set(stepId, next);
          dispatchClaims.set(stepId, { token: claimToken, expiresAt: claimExpiresAt });
          return next;
        },
      ),
      linkClaimedDispatch: vi.fn(
        (
          stepId: string,
          claimToken: string,
          childSessionId: string,
          dispatchToken: string,
          dispatchExpiresAt: string,
        ) => {
          const current = steps.get(stepId);
          if (!current || dispatchClaims.get(stepId)?.token !== claimToken) return undefined;
          const next = { ...current, childSessionId };
          steps.set(stepId, next);
          dispatchClaims.set(stepId, { token: dispatchToken, expiresAt: dispatchExpiresAt });
          return next;
        },
      ),
      claimLinkedForDispatch: vi.fn(
        (
          stepId: string,
          childSessionId: string,
          expectedChildTurnId: string | undefined,
          dispatchToken: string,
          dispatchExpiresAt: string,
          startedAt: string,
        ) => {
          const current = steps.get(stepId);
          if (
            !current ||
            current.childSessionId !== childSessionId ||
            (expectedChildTurnId !== undefined && current.childTurnId !== expectedChildTurnId)
          ) {
            return undefined;
          }
          const next = { ...current, status: "running" as const, startedAt };
          steps.set(stepId, next);
          dispatchClaims.set(stepId, { token: dispatchToken, expiresAt: dispatchExpiresAt });
          return next;
        },
      ),
      reclaimLinkedDispatch: vi.fn(
        (
          stepId: string,
          childSessionId: string,
          expectedDispatchToken: string,
          dispatchToken: string,
          dispatchExpiresAt: string,
          startedAt: string,
        ) => {
          const current = steps.get(stepId);
          if (
            !current ||
            current.childSessionId !== childSessionId ||
            dispatchClaims.get(stepId)?.token !== expectedDispatchToken
          ) {
            return undefined;
          }
          const next = { ...current, startedAt };
          steps.set(stepId, next);
          dispatchClaims.set(stepId, { token: dispatchToken, expiresAt: dispatchExpiresAt });
          return next;
        },
      ),
      finalizeLinkedDispatch: vi.fn(
        (stepId: string, childSessionId: string, expectedDispatchToken: string, childTurnId: string) => {
          const current = steps.get(stepId);
          if (
            !current ||
            current.childSessionId !== childSessionId ||
            dispatchClaims.get(stepId)?.token !== expectedDispatchToken
          ) {
            return undefined;
          }
          const next = { ...current, childTurnId };
          steps.set(stepId, next);
          dispatchClaims.delete(stepId);
          return next;
        },
      ),
      ownsLinkedDispatch: vi.fn((stepId: string, childSessionId: string, dispatchToken: string) => {
        const claim = dispatchClaims.get(stepId);
        return Boolean(
          steps.get(stepId)?.status === "running" &&
          steps.get(stepId)?.childSessionId === childSessionId &&
          claim?.token === dispatchToken &&
          Date.parse(claim.expiresAt) > Date.parse(databaseNow),
        );
      }),
      finishOwnedDispatchWithError: vi.fn(
        (input: {
          stepId: string;
          expectedDispatchToken: string;
          expectedChildSessionId?: string;
          status: "failed" | "cancelled";
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
            Date.parse(claim.expiresAt) <= Date.parse(databaseNow)
          ) {
            return undefined;
          }
          const next: ChatDelegationStepRecord = {
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
            Date.parse(claim.expiresAt) <= Date.parse(databaseNow)
          ) {
            return undefined;
          }
          const next: ChatDelegationStepRecord = {
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
            Date.parse(claim.expiresAt) <= Date.parse(databaseNow)
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
          status: "failed" | "cancelled" | "skipped";
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
          const next: ChatDelegationStepRecord = { ...current, ...input, status: input.status };
          steps.set(input.stepId, next);
          return next;
        },
      ),
    },
    taskSubagents: {
      findByAgentSessionId: vi.fn((agentSessionId: string) => subagents.get(agentSessionId)),
    },
    runImmediateTransaction: vi.fn(<T>(callback: () => T) => callback()),
  };

  const service = new ChatDelegationService(gateway as never);

  return {
    service,
    gateway: gateway as GatewayService & {
      storage: {
        chatSessionPrefs: { ensure: ReturnType<typeof vi.fn> };
        chatSessionMeta: { ensure: ReturnType<typeof vi.fn> };
        chatSessionProjects: { get: ReturnType<typeof vi.fn> };
        permissionProfiles: { resolveContext: ReturnType<typeof vi.fn> };
        chatDelegationRuns: {
          create: ReturnType<typeof vi.fn>;
          patch: ReturnType<typeof vi.fn>;
          get: ReturnType<typeof vi.fn>;
          getForUpdate: ReturnType<typeof vi.fn>;
        };
        chatDelegationSteps: {
          readDatabaseNow: ReturnType<typeof vi.fn>;
          get: ReturnType<typeof vi.fn>;
          getDispatchClaim: ReturnType<typeof vi.fn>;
          create: ReturnType<typeof vi.fn>;
          patch: ReturnType<typeof vi.fn>;
          listByRun: ReturnType<typeof vi.fn>;
          listByRunForUpdate: ReturnType<typeof vi.fn>;
          claimPendingForDispatch: ReturnType<typeof vi.fn>;
          reclaimRunningForDispatch: ReturnType<typeof vi.fn>;
          linkClaimedDispatch: ReturnType<typeof vi.fn>;
          claimLinkedForDispatch: ReturnType<typeof vi.fn>;
          reclaimLinkedDispatch: ReturnType<typeof vi.fn>;
          finalizeLinkedDispatch: ReturnType<typeof vi.fn>;
          ownsLinkedDispatch: ReturnType<typeof vi.fn>;
          finishOwnedDispatchWithError: ReturnType<typeof vi.fn>;
          finishOwnedDispatchWithResponse: ReturnType<typeof vi.fn>;
          releaseOwnedWaitingDispatch: ReturnType<typeof vi.fn>;
          finishUnclaimedPendingWithError: ReturnType<typeof vi.fn>;
        };
      };
      createChatSession: ReturnType<typeof vi.fn>;
      inheritDelegatedSessionToolGrants: ReturnType<typeof vi.fn>;
      updateChatSessionPrefs: ReturnType<typeof vi.fn>;
      agentSendChatMessage: ReturnType<typeof vi.fn>;
      taskLifecycleService: {
        appendTaskActivity: ReturnType<typeof vi.fn>;
        appendTaskDeliverable: ReturnType<typeof vi.fn>;
        createTask: ReturnType<typeof vi.fn>;
        registerTaskSubagent: ReturnType<typeof vi.fn>;
        updateTask: ReturnType<typeof vi.fn>;
        updateTaskAgenticContext: ReturnType<typeof vi.fn>;
        updateTaskSubagent: ReturnType<typeof vi.fn>;
        persistDelegationAggregateTask: ReturnType<typeof vi.fn>;
      };
    },
    steps,
    sessionRoles,
    buildResponse,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("condition not met");
}

describe("GatewayService.runChatDelegation", () => {
  it("uses a real child session runtime and persists truthful lineage for sequential delegation", async () => {
    const { gateway, service } = createDelegationHarness();

    const result = (await service.runChatDelegation("sess-1", {
      objective: "Design the change",
      roles: ["architect"],
      mode: "sequential",
    })) as ChatDelegateResponse;

    expect(gateway.createChatSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "default",
        projectId: "proj-1",
        mode: "chat",
      }),
    );
    expect(gateway.taskLifecycleService.registerTaskSubagent).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        agentSessionId: "delegate-session-1",
        agentName: "architect",
        metadata: expect.objectContaining({
          parentRunId: result.runId,
          profileId: "architect",
          contextMode: "isolated",
        }),
      }),
    );
    expect(gateway.inheritDelegatedSessionToolGrants).toHaveBeenCalledWith("sess-1", "delegate-session-1");
    expect(gateway.agentSendChatMessage).toHaveBeenCalledWith(
      "delegate-session-1",
      expect.objectContaining({
        mode: "chat",
        providerId: "openai",
        model: "gpt-5.4",
      }),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        status: "completed",
        childSessionId: "delegate-session-1",
        childTurnId: "child-turn-architect",
        durableRunId: "durable-architect",
      }),
    );
  });

  it("runs parallel delegation with a worker cap of four and starts dependency-gated steps only after prerequisites settle", async () => {
    const { gateway, service, sessionRoles, buildResponse } = createDelegationHarness();
    const starts: string[] = [];
    let active = 0;
    let maxActive = 0;
    let synthStartedAfterDependencies = false;
    const pending = new Map<string, () => void>();
    const completed = new Set<string>();

    gateway.agentSendChatMessage.mockImplementation((childSessionId: string) => {
      const role = sessionRoles.get(childSessionId) ?? "delegate";
      starts.push(role);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (role === "synth") {
        synthStartedAfterDependencies = ["architect", "researcher", "qa", "ops", "coder", "writer"].every((item) =>
          completed.has(item),
        );
      }
      return new Promise<ChatSendMessageResponse>((resolve) => {
        pending.set(role, () => {
          active -= 1;
          completed.add(role);
          resolve(buildResponse(role, childSessionId));
        });
      });
    });

    const runPromise = service.runChatDelegation("sess-1", {
      objective: "Ship the plan",
      roles: ["architect", "researcher", "qa", "ops", "coder", "writer", "synth"],
      mode: "parallel",
      steps: [
        { stepId: "architect-step", index: 0, role: "architect", parallelizable: true },
        { stepId: "researcher-step", index: 1, role: "researcher", parallelizable: true },
        { stepId: "qa-step", index: 2, role: "qa", parallelizable: true },
        { stepId: "ops-step", index: 3, role: "ops", parallelizable: true },
        { stepId: "coder-step", index: 4, role: "coder", parallelizable: true },
        { stepId: "writer-step", index: 5, role: "writer", parallelizable: true },
        {
          stepId: "synth-step",
          index: 6,
          role: "synth",
          parallelizable: false,
          dependsOnStepIds: ["architect-step", "researcher-step", "qa-step", "ops-step", "coder-step", "writer-step"],
        },
      ],
    }) as Promise<ChatDelegateResponse>;

    await waitFor(() => starts.length === 4);
    expect(maxActive).toBe(4);
    expect(starts).not.toContain("synth");

    for (const role of ["architect", "researcher", "qa", "ops"]) {
      pending.get(role)?.();
    }
    await waitFor(() => starts.length >= 6);

    pending.get("coder")?.();
    pending.get("writer")?.();
    await waitFor(() => starts.includes("synth"));
    expect(synthStartedAfterDependencies).toBe(true);

    pending.get("synth")?.();
    const result = await runPromise;

    expect(maxActive).toBe(4);
    expect(result.steps.map((step) => step.role)).toEqual([
      "architect",
      "researcher",
      "qa",
      "ops",
      "coder",
      "writer",
      "synth",
    ]);
    expect(result.stitchedOutput).toContain("### Architect");
    expect(result.stitchedOutput).toContain("### Synth");
    expect(gateway.storage.chatDelegationRuns.patch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("marks downstream dependents as skipped and the run as partial when a prerequisite fails", async () => {
    const { gateway, service, sessionRoles, buildResponse } = createDelegationHarness();

    gateway.agentSendChatMessage.mockImplementation(async (childSessionId: string) => {
      const role = sessionRoles.get(childSessionId) ?? "delegate";
      return buildResponse(role, childSessionId, role === "architect");
    });

    const result = (await service.runChatDelegation("sess-1", {
      objective: "Run the split",
      roles: ["architect", "qa", "synth"],
      mode: "parallel",
      steps: [
        { stepId: "architect-step", index: 0, role: "architect", parallelizable: true },
        { stepId: "qa-step", index: 1, role: "qa", parallelizable: true },
        { stepId: "synth-step", index: 2, role: "synth", parallelizable: false, dependsOnStepIds: ["architect-step"] },
      ],
    })) as ChatDelegateResponse;

    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "architect", status: "failed" }),
        expect.objectContaining({ role: "qa", status: "completed" }),
        expect.objectContaining({ role: "synth", status: "skipped" }),
      ]),
    );
    expect(gateway.storage.chatDelegationRuns.patch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "partial" }),
    );
    expect(gateway.taskLifecycleService.persistDelegationAggregateTask).toHaveBeenLastCalledWith(
      "task-1",
      expect.objectContaining({
        status: "blocked",
        agenticContext: expect.objectContaining({
          status: "failed",
          failureClass: "missing_handoff",
        }),
      }),
    );
  });
});
