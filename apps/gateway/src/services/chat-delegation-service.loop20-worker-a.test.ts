import { createHash } from "node:crypto";
import type {
  AgenticTaskContext,
  ChatDelegateResponse,
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSessionPrefsRecord,
  DurableRunRecord,
  TaskActivityRecord,
} from "@goatcitadel/contracts";
import { canonicalJsonString, NotFoundError } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  assertEligibleReadOnlyExplorerDurableParent,
  ChatDelegationService,
  READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE,
  type ChatDelegationServiceHost,
} from "./chat-delegation-service.js";
import { buildDeterministicAgentDurableRunId } from "./chat-turn-entry-service.js";

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
    parallelizable: input.parallelizable,
    dependsOnStepIds: input.dependsOnStepIds,
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
    workResult: input.workResult,
    scopeControl: input.scopeControl,
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

interface TestAgentTurnIdentity {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
}

function createIdentifiedChatResponse(
  childSessionId: string,
  identity: TestAgentTurnIdentity,
  overrides: Partial<ChatSendMessageResponse> = {},
): ChatSendMessageResponse {
  const base = createChatResponse(childSessionId);
  return {
    ...base,
    turnId: identity.turnId,
    userMessage: { ...base.userMessage, messageId: identity.userMessageId },
    assistantMessage: { ...base.assistantMessage!, messageId: identity.assistantMessageId },
    trace: {
      ...base.trace!,
      turnId: identity.turnId,
      userMessageId: identity.userMessageId,
      assistantMessageId: identity.assistantMessageId,
    },
    ...overrides,
  };
}

function buildPersistedChildDurableRun(input: {
  runId: string;
  sessionId: string;
  workspaceId: string;
  identity: TestAgentTurnIdentity;
  request: ChatSendMessageRequest & { policyContext?: unknown };
}): DurableRunRecord {
  const {
    signal: _signal,
    operatorId,
    authActorId,
    authActorSource,
    contextRefs: _contextRefs,
    ...serializable
  } = input.request;
  const request = JSON.parse(canonicalJsonString({ ...serializable, content: input.request.content.trim() })) as Record<
    string,
    unknown
  >;
  const admissionMaterialSha256 = createHash("sha256")
    .update(canonicalJsonString({ version: 2, request }), "utf8")
    .digest("hex");
  return {
    runId: input.runId,
    workflowKey: "chat.turn.execute",
    status: "completed",
    attemptCount: 1,
    maxAttempts: 3,
    version: 1,
    payload: {
      version: "chat.turn.execute.v2",
      admissionId: `admission-${input.identity.turnId}`,
      sessionIncarnationId: `incarnation-${input.sessionId}`,
      admissionMaterialSha256,
      workspaceId: input.workspaceId,
      admissionAggregateRevision: 1,
      admissionControllerGeneration: 1,
      effectiveRequestMaterialSha256: createHash("sha256")
        .update(canonicalJsonString({ version: 1, admissionMaterialSha256, request }), "utf8")
        .digest("hex"),
      requestActor: {
        actorKind: "operator",
        actorId: authActorId ?? operatorId ?? "operator:local",
        ...(operatorId ? { operatorId } : {}),
        ...(authActorId ? { authActorId } : {}),
        ...(authActorSource ? { authActorSource } : {}),
      },
      sessionId: input.sessionId,
      turnId: input.identity.turnId,
      userMessageId: input.identity.userMessageId,
      assistantMessageId: input.identity.assistantMessageId,
      branchKind: "append",
      threadEventType: "chat_thread_turn_appended",
      request,
    },
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:01.000Z",
  };
}

function buildExplorerParentDurableRun(
  input: {
    runId?: string;
    operatorId?: string;
  } = {},
): DurableRunRecord {
  const runId = input.runId ?? "durable-parent-explorer";
  const operatorId = input.operatorId ?? "operator-1";
  const request = { content: "Prepare a bounded workspace exploration." };
  const admissionMaterialSha256 = createHash("sha256")
    .update(canonicalJsonString({ version: 2, request }), "utf8")
    .digest("hex");
  return {
    runId,
    workflowKey: "chat.turn.execute",
    status: "completed",
    attemptCount: 1,
    maxAttempts: 3,
    version: 1,
    payload: {
      version: "chat.turn.execute.v2",
      admissionId: `admission-${runId}`,
      sessionIncarnationId: "incarnation-sess-1",
      admissionMaterialSha256,
      workspaceId: "default",
      admissionAggregateRevision: 1,
      admissionControllerGeneration: 1,
      effectiveRequestMaterialSha256: createHash("sha256")
        .update(canonicalJsonString({ version: 1, admissionMaterialSha256, request }), "utf8")
        .digest("hex"),
      policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId },
      requestActor: { actorKind: "operator", actorId: operatorId, operatorId },
      sessionId: "sess-1",
      turnId: `turn-${runId}`,
      userMessageId: `user-${runId}`,
      assistantMessageId: `assistant-${runId}`,
      branchKind: "append",
      threadEventType: "chat_thread_turn_appended",
      request,
    },
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:01.000Z",
  };
}

function buildStableTestDelegationId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => `${part.length}:${part}`).join("|"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

function createHarness(options: { prefs?: ChatSessionPrefsRecord; projectId?: string } = {}) {
  const prefs = options.prefs ?? buildPrefs();
  const runs = new Map<string, ChatDelegationRunRecord>();
  const durableRuns = new Map<string, DurableRunRecord>();
  const steps = new Map<string, ChatDelegationStepRecord>();
  const dispatchClaims = new Map<string, { token: string; expiresAt: string }>();
  const tasks = new Map<
    string,
    {
      taskId: string;
      workspaceId?: string;
      title?: string;
      description?: string;
      status: "in_progress" | "review" | "blocked";
      agenticContext?: Parameters<ChatDelegationServiceHost["taskLifecycleService"]["createTask"]>[0]["agenticContext"];
    }
  >();
  const traces = new Map<string, ChatSendMessageResponse["trace"]>();
  const stableChildSessions = new Map<string, { sessionId: string; title?: string }>();
  let databaseNowIso = "2026-07-11T00:00:00.000Z";
  let childSessionCounter = 0;
  const appendTaskActivity = vi.fn();
  const appendTaskDeliverable = vi.fn();
  const activityReceipts = new Map<string, TaskActivityRecord>();

  const deps = {
    getSession: vi.fn(() => ({ sessionId: "sess-1" })),
    getDurableRun: vi.fn((runId: string) => durableRuns.get(runId)),
    listChatMessages: vi.fn(async () => [
      { role: "assistant", content: "Previous answer" },
      { role: "user", content: "Need architecture, implementation, QA, ops, and handoff coverage." },
    ]),
    normalizeWorkspaceId: vi.fn((workspaceId?: string) => workspaceId ?? "default"),
    ensureChatSessionModelDefaults: vi.fn((_sessionId: string, nextPrefs: ChatSessionPrefsRecord) => nextPrefs),
    createChatSession: vi.fn((input: { stableKey?: string; title?: string }) => {
      if (input.stableKey) {
        const existing = stableChildSessions.get(input.stableKey);
        if (existing) {
          return existing;
        }
      }
      childSessionCounter += 1;
      const created = {
        sessionId: `delegate-session-${childSessionCounter}`,
        title: input.title,
      };
      if (input.stableKey) {
        stableChildSessions.set(input.stableKey, created);
      }
      return created;
    }),
    inheritDelegatedSessionToolGrants: vi.fn(),
    ensureSessionInternalToolGrant: vi.fn(),
    resolveDelegatedFilesystemScope: vi.fn(async () => undefined),
    assertDelegatedFilesystemScopeBinding: vi.fn(),
    updateChatSessionPrefs: vi.fn(),
    resolveToolPolicyContext: undefined,
    agentSendChatMessage: vi.fn(async (childSessionId: string) => createChatResponse(childSessionId)),
    extractAndPersistLearnedMemory: vi.fn(),
    scheduleChatMemoryContextPrewarm: vi.fn(),
    validateReadOnlyExplorerParent: vi.fn(async ({ sessionId, policyRunId }) => {
      const parentRun = durableRuns.get(policyRunId);
      if (parentRun) {
        const authority = assertEligibleReadOnlyExplorerDurableParent({
          parentRun,
          sessionId,
          workspaceId: "default",
        });
        return { workspaceId: "default", requestActor: authority.requestActor };
      }
      return {
        workspaceId: "default",
        requestActor: { actorKind: "operator" as const, actorId: "operator-1" },
      };
    }),
    watchDurableChildRun: vi.fn(),
    gatewaySql: {
      prepare: vi.fn(() => ({
        get: vi.fn(() => undefined),
      })),
    },
    taskLifecycleService: {
      createTask: vi.fn(
        (
          input: Parameters<ChatDelegationServiceHost["taskLifecycleService"]["createTask"]>[0],
          options?: { taskId?: string },
        ) => {
          const task = {
            taskId: options?.taskId ?? "task-1",
            workspaceId: input.workspaceId,
            title: input.title,
            description: input.description,
            status: input.status,
            agenticContext: input.agenticContext,
          };
          if (tasks.has(task.taskId)) {
            throw new Error(`duplicate task ${task.taskId}`);
          }
          tasks.set(task.taskId, task);
          return task;
        },
      ),
      getTask: vi.fn((taskId: string) => tasks.get(taskId)),
      lockTaskForDelegationAggregate: vi.fn((taskId: string) => tasks.get(taskId)!),
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
      updateTask: vi.fn((taskId: string, patch: { status: "in_progress" | "review" | "blocked" }) => {
        const current = tasks.get(taskId)!;
        const next = { ...current, ...patch };
        tasks.set(taskId, next);
        return next;
      }),
      updateTaskAgenticContext: vi.fn((taskId: string, patch: Partial<AgenticTaskContext>) => {
        const current = tasks.get(taskId)!;
        const next = { ...current, agenticContext: { ...(current.agenticContext ?? {}), ...patch } };
        tasks.set(taskId, next);
        return next;
      }),
      persistDelegationAggregateTask: vi.fn(
        (
          taskId: string,
          input: { status: "in_progress" | "review" | "blocked"; agenticContext: Partial<AgenticTaskContext> },
        ) => {
          const current = tasks.get(taskId)!;
          const next = {
            ...current,
            status: input.status,
            agenticContext: { ...(current.agenticContext ?? {}), ...input.agenticContext },
          };
          tasks.set(taskId, next);
          return next as never;
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
          if (runs.has(input.runId)) {
            throw new Error(`duplicate run ${input.runId}`);
          }
          const record: ChatDelegationRunRecord = {
            ...input,
            startedAt: input.startedAt ?? "2026-05-14T00:00:00.000Z",
          };
          runs.set(record.runId, record);
          return record;
        }),
        patch: vi.fn((runId: string, patch: Partial<ChatDelegationRunRecord> & { clearFinishedAt?: boolean }) => {
          const current = runs.get(runId);
          if (!current) {
            throw new Error(`unknown run ${runId}`);
          }
          const { clearFinishedAt, ...persistedPatch } = patch;
          const next = {
            ...current,
            ...persistedPatch,
            ...(clearFinishedAt ? { finishedAt: undefined } : {}),
          };
          runs.set(runId, next);
          return next;
        }),
        get: vi.fn((runId: string) => runs.get(runId)!),
        getForUpdate: vi.fn((runId: string) => runs.get(runId)!),
        listRecent: vi.fn((input: { sessionId?: string; parentRunId?: string; limit?: number }) =>
          [...runs.values()]
            .filter(
              (run) =>
                (!input.sessionId || run.sessionId === input.sessionId) &&
                (!input.parentRunId || run.parentRunId === input.parentRunId),
            )
            .slice(0, input.limit ?? 100),
        ),
      },
      chatTurnTraces: {
        get: vi.fn((turnId: string) => {
          const trace = traces.get(turnId);
          if (!trace) {
            throw new NotFoundError({ entity: "Chat turn trace", id: turnId });
          }
          return trace;
        }),
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
        patch: vi.fn(
          (
            stepId: string,
            patch: Omit<Partial<ChatDelegationStepRecord>, "childSessionId" | "childTurnId"> & {
              childSessionId?: string | null;
              childTurnId?: string | null;
            },
          ) => {
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
          },
        ),
        listByRun: vi.fn((runId: string) =>
          [...steps.values()].filter((step) => step.runId === runId).sort((left, right) => left.index - right.index),
        ),
        listByRunForUpdate: vi.fn((runId: string) =>
          [...steps.values()].filter((step) => step.runId === runId).sort((left, right) => left.index - right.index),
        ),
        claimPendingForDispatch: vi.fn(
          (stepId: string, claimToken: string, claimExpiresAt: string, startedAt: string) => {
            const current = steps.get(stepId);
            if (!current || current.status !== "pending" || current.childSessionId || dispatchClaims.has(stepId)) {
              return undefined;
            }
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
            const currentClaim = dispatchClaims.get(stepId);
            if (
              !current ||
              current.status !== "running" ||
              current.childSessionId !== undefined ||
              (expectedClaimToken === undefined
                ? currentClaim !== undefined
                : currentClaim?.token !== expectedClaimToken)
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
            if (
              !current ||
              current.status !== "running" ||
              dispatchClaims.get(stepId)?.token !== claimToken ||
              current.childSessionId !== undefined ||
              current.childTurnId !== undefined
            ) {
              return undefined;
            }
            const next = { ...current, childSessionId };
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
              current.status !== "running" ||
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
              current.status !== "running" ||
              current.childSessionId !== childSessionId ||
              current.childTurnId !== expectedChildTurnId ||
              dispatchClaims.has(stepId)
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
              current.status !== "running" ||
              current.childSessionId !== childSessionId ||
              (current.childTurnId !== undefined && current.childTurnId !== childTurnId) ||
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
          const current = steps.get(stepId);
          const claim = dispatchClaims.get(stepId);
          return Boolean(
            current?.status === "running" &&
            current.childSessionId === childSessionId &&
            claim?.token === dispatchToken &&
            Date.parse(claim.expiresAt) > Date.parse(databaseNowIso),
          );
        }),
        bindOwnedDurableRun: vi.fn(
          (input: { stepId: string; expectedDispatchToken: string; childSessionId: string; durableRunId: string }) => {
            const current = steps.get(input.stepId);
            const claim = dispatchClaims.get(input.stepId);
            if (
              !current ||
              current.status !== "running" ||
              current.childSessionId !== input.childSessionId ||
              claim?.token !== input.expectedDispatchToken ||
              Date.parse(claim.expiresAt) <= Date.parse(databaseNowIso) ||
              (current.durableRunId !== undefined && current.durableRunId !== input.durableRunId)
            ) {
              return undefined;
            }
            const next = { ...current, durableRunId: input.durableRunId };
            steps.set(input.stepId, next);
            return next;
          },
        ),
        extendOwnedDispatchLease: vi.fn(
          (input: {
            stepId: string;
            expectedDispatchToken: string;
            childSessionId: string;
            leaseExpiresAt: string;
          }) => {
            const current = steps.get(input.stepId);
            const claim = dispatchClaims.get(input.stepId);
            if (
              !current ||
              current.childSessionId !== input.childSessionId ||
              claim?.token !== input.expectedDispatchToken ||
              !current.durableRunId
            ) {
              return undefined;
            }
            dispatchClaims.set(input.stepId, { token: claim.token, expiresAt: input.leaseExpiresAt });
            return current;
          },
        ),
        recoverDurableRunBinding: vi.fn(
          (input: {
            stepId: string;
            childSessionId: string;
            childTurnId: string;
            durableRunId: string;
            releaseDispatch: boolean;
          }) => {
            const current = steps.get(input.stepId);
            if (
              !current ||
              current.status !== "running" ||
              current.childSessionId !== input.childSessionId ||
              (current.childTurnId !== undefined && current.childTurnId !== input.childTurnId) ||
              (current.durableRunId !== undefined && current.durableRunId !== input.durableRunId)
            ) {
              return undefined;
            }
            const next = {
              ...current,
              childTurnId: input.childTurnId,
              durableRunId: input.durableRunId,
            };
            steps.set(input.stepId, next);
            if (input.releaseDispatch) dispatchClaims.delete(input.stepId);
            return next;
          },
        ),
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
        findByAgentSessionId: vi.fn(() => undefined),
      },
      runImmediateTransaction: vi.fn(async <T>(callback: () => T | Promise<T>) => await callback()),
    },
  } satisfies ChatDelegationServiceHost;

  return {
    deps,
    service: new ChatDelegationService(deps),
    runs,
    durableRuns,
    steps,
    dispatchClaims,
    tasks,
    traces,
    stableChildSessions,
    activityReceipts,
    setDatabaseNow: (nowIso: string) => {
      databaseNowIso = nowIso;
    },
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
  it("recovers a persisted pre-launch Explorer exactly once across two fresh Gateway services", async () => {
    const { deps, durableRuns, runs, service, stableChildSessions, steps } = createHarness();
    durableRuns.set("durable-parent-explorer", buildExplorerParentDurableRun());
    deps.resolveDelegatedFilesystemScope.mockImplementation(async (_sessionId, dispatchGeneration) => ({
      rootPath: "F:\\code\\personal-ai",
      projectId: "project-1",
      approvedPaths: ["apps/gateway"],
      scopeHash: "scope-prelaunch-crash",
      dispatchGeneration,
      updatedAt: "2026-08-12T00:00:00.000Z",
    }));
    const request = {
      objective: "Recover exploration after pre-launch process loss",
      roles: ["Workspace explorer"],
      executionProfile: "read_only_explorer" as const,
      policyRunId: "durable-parent-explorer",
      operatorId: "operator-1",
      authActorId: "operator-1",
    };
    await expect(
      service.runChatDelegation("sess-1", request, {
        onStatus: () => {
          throw new Error("simulated process stop after plan commit");
        },
      }),
    ).rejects.toThrow("simulated process stop after plan commit");
    const persistedRun = [...runs.values()][0]!;
    const persistedStep = [...steps.values()][0]!;
    expect(persistedStep).toMatchObject({
      status: "pending",
      scopeControl: expect.objectContaining({
        projectId: "project-1",
        scopeHash: "scope-prelaunch-crash",
      }),
    });

    let releaseChild!: () => void;
    const childHeld = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    deps.agentSendChatMessage = vi.fn(
      async (
        childSessionId: string,
        childRequest: ChatSendMessageRequest & { policyContext?: unknown },
        options?: {
          turnIdentity?: TestAgentTurnIdentity;
          onChildDurableRunLaunched?: (runId: string) => Promise<void>;
        },
      ) => {
        const identity = options!.turnIdentity!;
        const durableRunId = buildDeterministicAgentDurableRunId(identity.turnId);
        await options?.onChildDurableRunLaunched?.(durableRunId);
        await childHeld;
        const active = steps.get(persistedStep.stepId)!;
        steps.set(active.stepId, {
          ...active,
          workResult: {
            disposition: "completed",
            summary: "Recovered bounded workspace evidence.",
            changedFiles: [],
            evidenceRefs: ["apps/gateway"],
            scopeHash: active.scopeControl!.scopeHash,
            dispatchGeneration: active.scopeControl!.dispatchGeneration,
          },
        });
        return createIdentifiedChatResponse(childSessionId, identity, {
          trace: {
            ...createIdentifiedChatResponse(childSessionId, identity).trace!,
            durable: { runId: durableRunId, status: "completed" },
          },
        });
      },
    ) as never;
    const tracked: Promise<unknown>[] = [];
    const recoveryOptions = {
      returnAfterDurableLaunch: true,
      trackExecution: (execution: Promise<unknown>) => tracked.push(execution),
    };
    const recoveries = await Promise.all([
      new ChatDelegationService(deps).reconcilePersistedWorkspaceExplorer(
        { sessionId: "sess-1", delegationRunId: persistedRun.runId },
        recoveryOptions,
      ),
      new ChatDelegationService(deps).reconcilePersistedWorkspaceExplorer(
        { sessionId: "sess-1", delegationRunId: persistedRun.runId },
        recoveryOptions,
      ),
    ]);

    expect(recoveries).toEqual([
      { repaired: true, reentered: true },
      { repaired: true, reentered: true },
    ]);
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(1);
    expect(stableChildSessions.size).toBe(1);
    expect(steps.get(persistedStep.stepId)?.durableRunId).toMatch(/^durable-chat-/);
    expect(deps.watchDurableChildRun).toHaveBeenCalledTimes(1);
    releaseChild();
    await Promise.all(tracked);
    expect(steps.get(persistedStep.stepId)?.status).toBe("completed");
  });

  it.each(["unlinked", "linked"] as const)(
    "waits out and recovers an active short %s Explorer pre-admission lease after restart",
    async (crashPoint) => {
      const { deps, dispatchClaims, durableRuns, runs, service, setDatabaseNow, stableChildSessions, steps } =
        createHarness();
      durableRuns.set("durable-parent-explorer", buildExplorerParentDurableRun());
      deps.resolveDelegatedFilesystemScope.mockImplementation(async (_sessionId, dispatchGeneration) => ({
        rootPath: "F:\\code\\personal-ai",
        projectId: "project-1",
        approvedPaths: ["apps/gateway"],
        scopeHash: `scope-${crashPoint}-crash`,
        dispatchGeneration,
        updatedAt: "2026-08-12T00:00:00.000Z",
      }));
      await expect(
        service.runChatDelegation(
          "sess-1",
          {
            objective: `Recover ${crashPoint} Explorer admission`,
            roles: ["Workspace explorer"],
            executionProfile: "read_only_explorer",
            policyRunId: "durable-parent-explorer",
            operatorId: "operator-1",
            authActorId: "operator-1",
          },
          { onStatus: () => Promise.reject(new Error("simulated plan-only process stop")) },
        ),
      ).rejects.toThrow("simulated plan-only process stop");
      const persistedRun = [...runs.values()][0]!;
      const pending = [...steps.values()][0]!;
      const turnId = buildStableTestDelegationId("delegation-turn", persistedRun.runId, pending.stepId);
      const expiresAt = "2026-07-11T00:00:00.010Z";
      let childSessionId: string | undefined;
      if (crashPoint === "linked") {
        const stableKey = `chat-delegation:${persistedRun.runId}:${pending.stepId}`;
        childSessionId = deps.createChatSession({ stableKey, title: "Delegate · Workspace Explorer" }).sessionId;
      }
      steps.set(pending.stepId, { ...pending, status: "running", ...(childSessionId ? { childSessionId } : {}) });
      dispatchClaims.set(pending.stepId, {
        token: `delegation-${childSessionId ? "dispatch" : "claim"}:v1:${Date.parse(expiresAt)}:${turnId}:dead-process`,
        expiresAt,
      });
      deps.agentSendChatMessage = vi.fn(
        async (
          activeChildSessionId: string,
          _request: ChatSendMessageRequest,
          options?: {
            turnIdentity?: TestAgentTurnIdentity;
            onChildDurableRunLaunched?: (runId: string) => Promise<void>;
          },
        ) => {
          const identity = options!.turnIdentity!;
          const durableRunId = buildDeterministicAgentDurableRunId(identity.turnId);
          await options?.onChildDurableRunLaunched?.(durableRunId);
          const active = steps.get(pending.stepId)!;
          steps.set(active.stepId, {
            ...active,
            workResult: {
              disposition: "completed",
              summary: "Recovered after short admission lease.",
              changedFiles: [],
              evidenceRefs: ["apps/gateway"],
              scopeHash: active.scopeControl!.scopeHash,
              dispatchGeneration: active.scopeControl!.dispatchGeneration,
            },
          });
          return createIdentifiedChatResponse(activeChildSessionId, identity, {
            trace: {
              ...createIdentifiedChatResponse(activeChildSessionId, identity).trace!,
              durable: { runId: durableRunId, status: "completed" },
            },
          });
        },
      ) as never;
      setTimeout(() => setDatabaseNow("2026-07-11T00:00:01.000Z"), 5);

      await expect(
        new ChatDelegationService(deps).reconcilePersistedWorkspaceExplorer({
          sessionId: "sess-1",
          delegationRunId: persistedRun.runId,
        }),
      ).resolves.toEqual({ repaired: true, reentered: true });
      expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(1);
      expect(steps.get(pending.stepId)?.status).toBe("completed");
      expect(stableChildSessions.size).toBe(1);
      if (childSessionId) expect(steps.get(pending.stepId)?.childSessionId).toBe(childSessionId);
    },
  );

  it("atomically terminalizes project drift and retries after aggregate persistence rolls back", async () => {
    const { deps, durableRuns, runs, service, steps, tasks } = createHarness();
    durableRuns.set("durable-parent-explorer", buildExplorerParentDurableRun());
    deps.resolveDelegatedFilesystemScope.mockImplementation(async (_sessionId, dispatchGeneration) => ({
      rootPath: "F:\\private\\old-project",
      projectId: "project-1",
      approvedPaths: ["apps/gateway"],
      scopeHash: "scope-project-1",
      dispatchGeneration,
      updatedAt: "2026-08-12T00:00:00.000Z",
    }));
    await expect(
      service.runChatDelegation(
        "sess-1",
        {
          objective: "Detect a rebound project before Explorer recovery",
          roles: ["Workspace explorer"],
          executionProfile: "read_only_explorer",
          policyRunId: "durable-parent-explorer",
          operatorId: "operator-1",
          authActorId: "operator-1",
        },
        { onStatus: () => Promise.reject(new Error("simulated plan-only process stop")) },
      ),
    ).rejects.toThrow("simulated plan-only process stop");
    const persistedRun = [...runs.values()][0]!;
    deps.storage.chatSessionProjects.get.mockReturnValue({ projectId: "project-2" });
    deps.assertDelegatedFilesystemScopeBinding.mockImplementation(async (_sessionId, scope) => {
      const currentProject = await deps.storage.chatSessionProjects.get("sess-1");
      if (currentProject?.projectId !== scope.projectId) {
        throw new Error(`realpath failed for ${scope.rootPath}`);
      }
    });
    deps.storage.runImmediateTransaction = vi.fn(async <T>(callback: () => T | Promise<T>) => {
      const stepSnapshot = new Map([...steps].map(([key, value]) => [key, { ...value }]));
      const runSnapshot = new Map([...runs].map(([key, value]) => [key, { ...value }]));
      const taskSnapshot = new Map([...tasks].map(([key, value]) => [key, { ...value }]));
      try {
        return await callback();
      } catch (error) {
        steps.clear();
        for (const [key, value] of stepSnapshot) steps.set(key, value);
        runs.clear();
        for (const [key, value] of runSnapshot) runs.set(key, value);
        tasks.clear();
        for (const [key, value] of taskSnapshot) tasks.set(key, value);
        throw error;
      }
    }) as never;
    deps.storage.chatDelegationRuns.patch.mockImplementationOnce(() => {
      throw new Error("simulated aggregate persistence crash");
    });
    deps.taskLifecycleService.publishDelegationAggregateTask.mockClear();

    await expect(
      new ChatDelegationService(deps).reconcilePersistedWorkspaceExplorer({
        sessionId: "sess-1",
        delegationRunId: persistedRun.runId,
      }),
    ).rejects.toThrow("simulated aggregate persistence crash");
    expect([...steps.values()][0]).toMatchObject({ status: "pending", error: undefined });
    expect(runs.get(persistedRun.runId)?.status).toBe("running");
    expect(tasks.get(persistedRun.taskId)?.status).toBe("in_progress");
    expect(deps.taskLifecycleService.publishDelegationAggregateTask).not.toHaveBeenCalled();

    await expect(
      new ChatDelegationService(deps).reconcilePersistedWorkspaceExplorer({
        sessionId: "sess-1",
        delegationRunId: persistedRun.runId,
      }),
    ).resolves.toEqual({ repaired: true, reentered: false });
    const failedStep = [...steps.values()][0]!;
    expect(failedStep).toMatchObject({
      status: "failed",
      summary: "Workspace exploration unavailable.",
      error: "Workspace exploration is unavailable because its verified project or filesystem scope changed.",
    });
    expect(failedStep.error).not.toContain("F:\\private");
    expect(runs.get(persistedRun.runId)?.status).toBe("failed");
    expect(tasks.get(persistedRun.taskId)?.status).toBe("blocked");
    expect(deps.agentSendChatMessage).not.toHaveBeenCalled();
  });

  it("repairs and re-enters a terminal explorer child left running after process interruption", async () => {
    const { deps, durableRuns, service, steps } = createHarness();
    deps.resolveDelegatedFilesystemScope.mockResolvedValue({
      rootPath: "F:\\code\\personal-ai",
      projectId: "project-1",
      approvedPaths: ["apps/gateway"],
      scopeHash: "scope-explorer-crash",
      dispatchGeneration: "dispatch-explorer-crash",
      updatedAt: "2026-08-12T00:00:00.000Z",
    });
    let frozenRequest: (ChatSendMessageRequest & { policyContext?: unknown }) | undefined;
    let frozenIdentity: TestAgentTurnIdentity | undefined;
    deps.agentSendChatMessage = vi.fn(
      async (
        childSessionId: string,
        request: ChatSendMessageRequest & { policyContext?: unknown },
        options?: {
          turnIdentity?: TestAgentTurnIdentity;
          onChildDurableRunLaunched?: (runId: string) => Promise<void>;
        },
      ) => {
        const identity = options?.turnIdentity;
        if (!identity) {
          throw new Error("Expected a frozen Explorer turn identity.");
        }
        if (deps.agentSendChatMessage.mock.calls.length === 1) {
          frozenRequest = request;
          frozenIdentity = identity;
          await options?.onChildDurableRunLaunched?.("durable-child-explorer-crash");
          const waiting = createIdentifiedChatResponse(childSessionId, identity);
          return {
            ...waiting,
            assistantMessage: undefined,
            trace: {
              ...waiting.trace!,
              status: "running",
              durable: { runId: "durable-child-explorer-crash", status: "running" },
            },
          };
        }
        expect(request).toEqual(frozenRequest);
        const completed = createIdentifiedChatResponse(childSessionId, identity);
        return {
          ...completed,
          trace: {
            ...completed.trace!,
            durable: { runId: "durable-child-explorer-crash", status: "completed" },
          },
        };
      },
    ) as never;

    const interrupted = await service.runChatDelegation("sess-1", {
      objective: "Inspect the workspace after a durable restart",
      roles: ["Workspace explorer"],
      executionProfile: "read_only_explorer",
      policyRunId: "durable-parent-explorer",
      operatorId: "operator-1",
      authActorId: "operator-1",
    });
    expect(interrupted.status).toBe("running");
    const interruptedStep = steps.get(interrupted.steps[0]!.stepId)!;
    expect(interruptedStep).toMatchObject({
      status: "running",
      childSessionId: "delegate-session-1",
      childTurnId: frozenIdentity!.turnId,
      durableRunId: "durable-child-explorer-crash",
    });

    steps.set(interruptedStep.stepId, {
      ...interruptedStep,
      workResult: {
        disposition: "completed",
        summary: "Workspace evidence recovered.",
        changedFiles: [],
        evidenceRefs: ["apps/gateway/src/services/chat-delegation-service.ts"],
        scopeHash: "scope-explorer-crash",
        dispatchGeneration: "dispatch-explorer-crash",
      },
    });
    durableRuns.set(
      "durable-child-explorer-crash",
      buildPersistedChildDurableRun({
        runId: "durable-child-explorer-crash",
        sessionId: "delegate-session-1",
        workspaceId: "default",
        identity: frozenIdentity!,
        request: frozenRequest!,
      }),
    );

    const restartedService = new ChatDelegationService(deps);
    await expect(
      restartedService.reconcilePersistedWorkspaceExplorer({
        sessionId: "sess-1",
        delegationRunId: interrupted.runId,
      }),
    ).resolves.toEqual({ repaired: true, reentered: true });
    expect(steps.get(interruptedStep.stepId)).toMatchObject({
      status: "completed",
      childTurnId: frozenIdentity!.turnId,
      durableRunId: "durable-child-explorer-crash",
      output: expect.stringContaining("delegate-session-1 output"),
    });
    expect(deps.watchDurableChildRun).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRunId: "durable-parent-explorer",
        childRunId: "durable-child-explorer-crash",
        required: true,
      }),
    );
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(2);
  });

  it("derives and repairs the durable Explorer child when launch binding and watcher roll back together", async () => {
    const { deps, dispatchClaims, durableRuns, service, steps } = createHarness();
    deps.resolveDelegatedFilesystemScope.mockResolvedValue({
      rootPath: "F:\\code\\personal-ai",
      projectId: "project-1",
      approvedPaths: ["apps/gateway"],
      scopeHash: "scope-explorer-atomic-rollback",
      dispatchGeneration: "dispatch-explorer-atomic-rollback",
      updatedAt: "2026-08-12T00:00:00.000Z",
    });
    const originalTransaction = deps.storage.runImmediateTransaction;
    deps.storage.runImmediateTransaction = vi.fn(async <T>(callback: () => T | Promise<T>) => {
      const stepSnapshot = new Map([...steps].map(([key, value]) => [key, { ...value }]));
      const claimSnapshot = new Map([...dispatchClaims].map(([key, value]) => [key, { ...value }]));
      try {
        return await callback();
      } catch (error) {
        steps.clear();
        for (const [key, value] of stepSnapshot) steps.set(key, value);
        dispatchClaims.clear();
        for (const [key, value] of claimSnapshot) dispatchClaims.set(key, value);
        throw error;
      }
    }) as never;
    deps.watchDurableChildRun.mockRejectedValueOnce(new Error("simulated atomic watcher failure"));
    let frozenIdentity: TestAgentTurnIdentity | undefined;
    let frozenRequest: (ChatSendMessageRequest & { policyContext?: unknown }) | undefined;
    deps.agentSendChatMessage = vi.fn(
      async (
        childSessionId: string,
        request: ChatSendMessageRequest & { policyContext?: unknown },
        options?: {
          turnIdentity?: TestAgentTurnIdentity;
          onChildDurableRunLaunched?: (runId: string) => Promise<void>;
        },
      ) => {
        const identity = options?.turnIdentity;
        if (!identity) {
          throw new Error("Expected a frozen Explorer turn identity.");
        }
        if (deps.agentSendChatMessage.mock.calls.length === 1) {
          frozenIdentity = identity;
          frozenRequest = request;
          const active = [...steps.values()].find((step) => step.childSessionId === childSessionId)!;
          steps.set(active.stepId, {
            ...active,
            workResult: {
              disposition: "completed",
              summary: "Recovered after atomic watcher rollback.",
              changedFiles: [],
              evidenceRefs: ["apps/gateway"],
              scopeHash: "scope-explorer-atomic-rollback",
              dispatchGeneration: "dispatch-explorer-atomic-rollback",
            },
          });
          const childRunId = buildDeterministicAgentDurableRunId(identity.turnId);
          durableRuns.set(
            childRunId,
            buildPersistedChildDurableRun({
              runId: childRunId,
              sessionId: childSessionId,
              workspaceId: "default",
              identity,
              request,
            }),
          );
          await options?.onChildDurableRunLaunched?.(childRunId);
        }
        expect(request).toEqual(frozenRequest);
        const completed = createIdentifiedChatResponse(childSessionId, identity);
        return {
          ...completed,
          trace: {
            ...completed.trace!,
            durable: { runId: buildDeterministicAgentDurableRunId(identity.turnId), status: "completed" },
          },
        };
      },
    ) as never;

    const interrupted = await service.runChatDelegation("sess-1", {
      objective: "Recover the explorer launch atomically",
      roles: ["Workspace explorer"],
      executionProfile: "read_only_explorer",
      policyRunId: "durable-parent-explorer",
      operatorId: "operator-1",
      authActorId: "operator-1",
    });
    const interruptedStep = steps.get(interrupted.steps[0]!.stepId)!;
    expect(interrupted).toMatchObject({ status: "running" });
    expect(interruptedStep).toMatchObject({ status: "running", childSessionId: "delegate-session-1" });
    expect(interruptedStep.durableRunId).toBeUndefined();
    expect(interruptedStep.childTurnId).toBeUndefined();
    expect(dispatchClaims.has(interruptedStep.stepId)).toBe(true);

    deps.storage.runImmediateTransaction = originalTransaction;
    const restartedService = new ChatDelegationService(deps);
    await expect(
      restartedService.reconcilePersistedWorkspaceExplorer({
        sessionId: "sess-1",
        delegationRunId: interrupted.runId,
      }),
    ).resolves.toEqual({ repaired: true, reentered: true });
    expect(steps.get(interruptedStep.stepId)).toMatchObject({
      status: "completed",
      childTurnId: frozenIdentity!.turnId,
      durableRunId: buildDeterministicAgentDurableRunId(frozenIdentity!.turnId),
    });
    expect(dispatchClaims.has(interruptedStep.stepId)).toBe(false);
  });

  it("resumes the exact persisted child authority and custom step graph without widening posture", async () => {
    const originalPrefs = buildPrefs({
      webMode: "off",
      memoryMode: "off",
      toolAutonomy: "manual",
      retrievalMode: "standard",
    });
    const { deps, dispatchClaims, durableRuns, service, steps } = createHarness({ prefs: originalPrefs });
    deps.resolveToolPolicyContext = vi.fn((input) => ({
      ...input,
      permissionProfileId: "profile-restricted",
      localOperatorOverrideId: "override-frozen",
      fullWebAccess: false,
    }));

    let frozenChildRequest: (ChatSendMessageRequest & { policyContext?: unknown }) | undefined;
    let frozenIdentity: TestAgentTurnIdentity | undefined;
    deps.agentSendChatMessage = vi.fn(
      async (
        childSessionId: string,
        request: ChatSendMessageRequest & { policyContext?: unknown },
        options?: { turnIdentity?: TestAgentTurnIdentity },
      ) => {
        const identity = options?.turnIdentity;
        if (!identity) {
          throw new Error("Expected a frozen Explorer turn identity.");
        }
        const call = deps.agentSendChatMessage.mock.calls.length;
        const response = createIdentifiedChatResponse(childSessionId, identity);
        if (call === 1) {
          frozenChildRequest = request;
          frozenIdentity = identity;
          const active = [...steps.values()].find((step) => step.childSessionId === childSessionId)!;
          steps.set(active.stepId, {
            ...active,
            scopeControl: {
              rootPath: "F:\\code\\personal-ai",
              approvedPaths: ["apps/gateway"],
              scopeHash: "scope-original",
              dispatchGeneration: "dispatch-original",
              updatedAt: "2026-07-11T00:00:00.000Z",
            },
            workResult: {
              disposition: "scope_expansion",
              summary: "Need tests too.",
              changedFiles: [],
              evidenceRefs: [],
              scopeHash: "scope-original",
              dispatchGeneration: "dispatch-original",
              scopeExpansion: {
                requestedPaths: ["apps/gateway", "packages/storage"],
                reason: "Need tests too.",
                scopeHash: "scope-original",
                approvalId: "approval-scope-1",
                requestedAt: "2026-07-11T00:00:00.000Z",
              },
            },
          });
          return {
            ...response,
            trace: {
              ...response.trace!,
              status: "waiting_for_approval",
              durable: { runId: "durable-child-scope-1", status: "waiting" },
            },
          };
        }
        if (call === 2) {
          expect(childSessionId).toBe("delegate-session-1");
          expect(request).toEqual(frozenChildRequest);
          const active = [...steps.values()].find((step) => step.childSessionId === childSessionId)!;
          steps.set(active.stepId, {
            ...active,
            workResult: {
              disposition: "completed",
              summary: "Coder completed after scope approval.",
              changedFiles: [],
              evidenceRefs: ["apps/gateway/src/services/chat-delegation-service.ts"],
              scopeHash: "scope-expanded",
              dispatchGeneration: "dispatch-expanded",
            },
          });
          return {
            ...response,
            trace: {
              ...response.trace!,
              durable: { runId: "durable-child-scope-1", status: "completed" },
            },
          };
        }
        expect(childSessionId).toBe("delegate-session-2");
        expect(request).toMatchObject({
          webMode: "off",
          memoryMode: "off",
          fullWebAccess: false,
          permissionProfileId: "profile-restricted",
          localOperatorOverrideId: "override-frozen",
          prefsOverride: expect.objectContaining({ toolAutonomy: "manual", retrievalMode: "standard" }),
        });
        return response;
      },
    ) as never;

    const request = {
      objective: "Implement then verify the scoped change",
      roles: ["Coder", "QA"],
      mode: "sequential" as const,
      steps: [
        { stepId: "implementation", role: "Coder", index: 0, parallelizable: false },
        {
          stepId: "verification",
          role: "QA",
          index: 1,
          parallelizable: false,
          dependsOnStepIds: ["implementation"],
        },
      ],
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "token" as const,
      permissionProfileId: "profile-restricted",
      localOperatorOverrideId: "override-frozen",
      policyRunId: "durable-parent-custom-plan",
      fullWebAccess: false,
    };
    const waiting = await service.runChatDelegation("sess-1", request);
    expect(waiting.status).toBe("running");
    expect(waiting.steps).toHaveLength(2);
    expect(waiting.steps[1]?.dependsOnStepIds).toEqual([waiting.steps[0]!.stepId]);

    const scopeStep = steps.get(waiting.steps[0]!.stepId)!;
    steps.set(scopeStep.stepId, {
      ...scopeStep,
      scopeControl: {
        ...scopeStep.scopeControl!,
        approvedPaths: ["apps/gateway", "packages/storage"],
        scopeHash: "scope-expanded",
        dispatchGeneration: "dispatch-expanded",
        updatedAt: "2026-07-11T00:00:01.000Z",
      },
      workResult: {
        ...scopeStep.workResult!,
        scopeExpansion: {
          ...scopeStep.workResult!.scopeExpansion!,
          decision: "approved",
          resolvedAt: "2026-07-11T00:00:01.000Z",
        },
      },
    });
    durableRuns.set(
      "durable-child-scope-1",
      buildPersistedChildDurableRun({
        runId: "durable-child-scope-1",
        sessionId: "delegate-session-1",
        workspaceId: "default",
        identity: frozenIdentity!,
        request: frozenChildRequest!,
      }),
    );

    deps.storage.chatSessionPrefs.ensure.mockResolvedValue(
      buildPrefs({
        webMode: "deep",
        memoryMode: "auto",
        toolAutonomy: "safe_auto",
        retrievalMode: "layered",
        codeAutoApply: "aggressive_auto",
      }),
    );
    deps.resolveToolPolicyContext.mockClear();
    deps.resolveToolPolicyContext.mockRejectedValue(new Error("live policy must not be recomputed"));
    deps.inheritDelegatedSessionToolGrants.mockClear();
    deps.updateChatSessionPrefs.mockClear();
    const dispatchExpiry = "2026-07-11T01:00:00.000Z";
    dispatchClaims.set(scopeStep.stepId, {
      token: `delegation-dispatch:v1:${Date.parse(dispatchExpiry)}:${frozenIdentity!.turnId}:existing-owner`,
      expiresAt: dispatchExpiry,
    });
    const noOp = await service.resumePersistedChatDelegation({
      delegationRunId: waiting.runId,
      stepId: scopeStep.stepId,
      durableRunId: "durable-child-scope-1",
    });
    expect(noOp.reenteredPersistedStep).toBe(false);
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(1);

    dispatchClaims.delete(scopeStep.stepId);
    const resumed = await service.resumePersistedChatDelegation({
      delegationRunId: waiting.runId,
      stepId: scopeStep.stepId,
      durableRunId: "durable-child-scope-1",
    });
    expect(resumed.reenteredPersistedStep).toBe(true);
    expect(resumed.status).toBe("completed");
    expect(resumed.steps.map((step) => step.role)).toEqual(["coder", "qa"]);
    expect(resumed.steps[1]?.dependsOnStepIds).toEqual([resumed.steps[0]!.stepId]);
    expect(deps.resolveToolPolicyContext).not.toHaveBeenCalled();
    expect(deps.inheritDelegatedSessionToolGrants).not.toHaveBeenCalled();
    expect(deps.updateChatSessionPrefs).toHaveBeenCalledTimes(1);
    expect(deps.updateChatSessionPrefs).toHaveBeenCalledWith(
      "delegate-session-2",
      expect.objectContaining({
        webMode: "off",
        memoryMode: "off",
        toolAutonomy: "manual",
        codeAutoApply: "manual",
      }),
    );
  });

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

  it("binds a canonical durable child watcher when a delegated turn commits", async () => {
    const { deps, service } = createHarness();
    deps.watchDurableChildRun = vi.fn();

    const result = await service.runChatDelegation("sess-1", {
      objective: "Implement and verify the durable watcher slice",
      roles: ["coder"],
      policyRunId: "parent-durable-run",
    });

    const step = result.steps[0]!;
    expect(deps.watchDurableChildRun).toHaveBeenCalledTimes(1);
    expect(deps.watchDurableChildRun).toHaveBeenCalledWith({
      parentRunId: "parent-durable-run",
      childRunId: step.durableRunId,
      watcherId: `delegation-child:${step.stepId}`,
      source: "chat_delegation",
      metadata: {
        delegationRunId: result.runId,
        stepId: step.stepId,
        childSessionId: step.childSessionId,
        childTurnId: step.childTurnId,
      },
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
        stitchedOutput: expect.stringContaining("FAILED: permission profile is no longer active"),
        citations: [],
        finishedAt: expect.any(String),
      }),
    );
    expect(deps.taskLifecycleService.persistDelegationAggregateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "blocked",
        agenticContext: expect.objectContaining({
          status: "failed",
          activeChildCount: 0,
        }),
      }),
    );
    expect(deps.taskLifecycleService.publishDelegationAggregateTask).toHaveBeenCalledTimes(1);
  });

  it("rolls back pre-dispatch policy failure evidence with parent and task truth", async () => {
    const { deps, dispatchClaims, runs, service, steps, tasks } = createHarness();
    const transaction = deps.storage.runImmediateTransaction.getMockImplementation()!;
    deps.storage.runImmediateTransaction.mockImplementation(async (callback) => {
      const stepSnapshot = new Map([...steps].map(([key, value]) => [key, { ...value }]));
      const claimSnapshot = new Map([...dispatchClaims].map(([key, value]) => [key, { ...value }]));
      const runSnapshot = new Map([...runs].map(([key, value]) => [key, { ...value }]));
      const taskSnapshot = new Map([...tasks].map(([key, value]) => [key, { ...value }]));
      try {
        return await transaction(callback);
      } catch (error) {
        steps.clear();
        stepSnapshot.forEach((value, key) => steps.set(key, value));
        dispatchClaims.clear();
        claimSnapshot.forEach((value, key) => dispatchClaims.set(key, value));
        runs.clear();
        runSnapshot.forEach((value, key) => runs.set(key, value));
        tasks.clear();
        taskSnapshot.forEach((value, key) => tasks.set(key, value));
        throw error;
      }
    });
    deps.resolveToolPolicyContext = vi.fn(() => {
      throw new Error("permission profile is no longer active");
    }) as never;
    const persistActivity = deps.taskLifecycleService.persistDelegationActivity.getMockImplementation()!;
    deps.taskLifecycleService.persistDelegationActivity.mockImplementationOnce(() => {
      throw new Error("policy evidence transaction failed");
    });
    const request = {
      objective: "Rollback policy failure atomically",
      roles: ["runtime policy"],
      policyRunId: "durable-policy-failure-rollback",
    };

    await expect(service.runChatDelegation("sess-1", request)).rejects.toThrow("policy evidence transaction failed");
    expect([...runs.values()][0]?.status).toBe("running");
    expect([...steps.values()][0]?.status).toBe("pending");
    expect([...tasks.values()][0]).toEqual(
      expect.objectContaining({
        status: "in_progress",
        agenticContext: expect.objectContaining({ status: "running" }),
      }),
    );
    expect(deps.taskLifecycleService.publishDelegationActivity).not.toHaveBeenCalled();
    deps.taskLifecycleService.persistDelegationActivity.mockImplementation(persistActivity);

    await expect(service.runChatDelegation("sess-1", request)).rejects.toThrow(
      "permission profile is no longer active",
    );
    expect([...runs.values()][0]?.status).toBe("failed");
    expect([...steps.values()][0]?.status).toBe("failed");
    expect([...tasks.values()][0]).toEqual(
      expect.objectContaining({ status: "blocked", agenticContext: expect.objectContaining({ status: "failed" }) }),
    );
    expect(deps.taskLifecycleService.publishDelegationActivity).toHaveBeenCalledTimes(1);
  });

  it("keeps parent and task running when another worker claims a step before policy failure aggregation", async () => {
    const { deps, runs, service, steps, tasks } = createHarness();
    deps.resolveToolPolicyContext = vi.fn(() => {
      const step = [...steps.values()][0]!;
      deps.storage.chatDelegationSteps.claimPendingForDispatch(
        step.stepId,
        "replacement-policy-owner",
        "2099-01-01T00:00:00.000Z",
        "2026-07-11T00:00:01.000Z",
      );
      throw new Error("permission profile changed concurrently");
    }) as never;

    await expect(
      service.runChatDelegation("sess-1", {
        objective: "Preserve a claimed step across policy failure",
        roles: ["runtime policy"],
        policyRunId: "durable-policy-claim-race",
      }),
    ).rejects.toThrow("permission profile changed concurrently");

    expect([...steps.values()][0]).toEqual(expect.objectContaining({ status: "running" }));
    expect([...runs.values()][0]).toEqual(expect.objectContaining({ status: "running" }));
    expect([...tasks.values()][0]).toEqual(
      expect.objectContaining({
        status: "in_progress",
        agenticContext: expect.objectContaining({ status: "running" }),
      }),
    );
  });

  it("validates objective, code project binding, and custom step dependencies before creating work", async () => {
    const earlyValidationHarness = createHarness();
    const { service } = earlyValidationHarness;

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
    ).resolves.toMatchObject({ status: "completed" });
    expect(codeHarness.deps.taskLifecycleService.createTask).toHaveBeenCalled();

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

  it("resumes a persisted dependency plan after approval and passes the approved handoff to the next step", async () => {
    const { deps, service, steps } = createHarness();
    deps.agentSendChatMessage = vi.fn(
      async (childSessionId: string, request: Partial<ChatSendMessageRequest>): Promise<ChatSendMessageResponse> => {
        const response = createChatResponse(childSessionId);
        if (deps.agentSendChatMessage.mock.calls.length === 1) {
          return {
            ...response,
            assistantMessage: { ...response.assistantMessage, content: "Waiting for approved architecture tool." },
            trace: {
              ...response.trace,
              status: "waiting_for_approval",
              durable: { runId: `durable-${childSessionId}`, status: "waiting" },
            },
          };
        }
        expect(request.content).toContain("Approved architecture handoff");
        return response;
      },
    ) as never;
    const request = {
      objective: "Approve architecture before QA",
      roles: ["architect", "qa"],
      mode: "parallel" as const,
      policyRunId: "parent-durable-run-1",
      steps: [
        { stepId: "architect-step", role: "architect", index: 0, parallelizable: true },
        {
          stepId: "qa-step",
          role: "qa",
          index: 1,
          parallelizable: false,
          dependsOnStepIds: ["architect-step"],
        },
      ],
    };

    const waiting = await service.runChatDelegation("sess-1", request);
    expect(waiting.status).toBe("running");
    expect(waiting.steps.map((step) => step.status)).toEqual(["running", "pending"]);
    expect(waiting.steps[1]?.dependsOnStepIds).toEqual([waiting.steps[0]?.stepId]);

    const architect = waiting.steps[0]!;
    steps.set(architect.stepId, {
      ...architect,
      status: "completed",
      output: "Approved architecture handoff",
      summary: "Architecture approved",
      finishedAt: "2026-05-14T00:00:02.000Z",
    });
    const restartedService = new ChatDelegationService(deps);
    const completed = await restartedService.runChatDelegation("sess-1", request);

    expect(completed.runId).toBe(waiting.runId);
    expect(completed.status).toBe("completed");
    expect(completed.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(2);
    expect(deps.taskLifecycleService.createTask).toHaveBeenCalledTimes(1);

    const duplicateWake = await new ChatDelegationService(deps).runChatDelegation("sess-1", request);
    expect(duplicateWake.runId).toBe(waiting.runId);
    expect(duplicateWake.status).toBe("completed");
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(2);
  });

  it("resumes a failed approved dependency by durably skipping downstream work", async () => {
    const { deps, service, steps } = createHarness();
    deps.agentSendChatMessage = vi.fn(async (childSessionId: string): Promise<ChatSendMessageResponse> => {
      const response = createChatResponse(childSessionId);
      return {
        ...response,
        trace: {
          ...response.trace,
          status: "waiting_for_approval",
          durable: { runId: `durable-${childSessionId}`, status: "waiting" },
        },
      };
    }) as never;
    const request = {
      objective: "Fail architecture before QA",
      roles: ["architect", "qa"],
      mode: "parallel" as const,
      policyRunId: "parent-durable-run-2",
      steps: [
        { stepId: "architect-step", role: "architect", index: 0, parallelizable: true },
        { stepId: "qa-step", role: "qa", index: 1, dependsOnStepIds: ["architect-step"] },
      ],
    };

    const waiting = await service.runChatDelegation("sess-1", request);
    const architect = waiting.steps[0]!;
    steps.set(architect.stepId, {
      ...architect,
      status: "failed",
      output: undefined,
      error: "Approved tool failed at the domain boundary",
      finishedAt: "2026-05-14T00:00:02.000Z",
    });
    let transactionDepth = 0;
    deps.storage.runImmediateTransaction.mockImplementation(async (callback) => {
      transactionDepth += 1;
      try {
        return await callback();
      } finally {
        transactionDepth -= 1;
      }
    });
    deps.taskLifecycleService.publishDelegationActivity.mockImplementation(() => {
      expect(transactionDepth).toBe(0);
    });
    const onStep = vi.fn(() => {
      expect(transactionDepth).toBe(0);
    });
    const resumed = await new ChatDelegationService(deps).runChatDelegation("sess-1", request, { onStep });

    expect(resumed.runId).toBe(waiting.runId);
    expect(resumed.status).toBe("failed");
    expect(resumed.steps.map((step) => step.status)).toEqual(["failed", "skipped"]);
    expect(resumed.steps[1]?.error).toContain("dependency did not complete: architect");
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(1);
    expect(onStep).toHaveBeenCalledTimes(1);
  });

  it("revalidates a stale failed dependency under aggregate locks before dispatching downstream work", async () => {
    const { deps, service, steps } = createHarness();
    let childCallCount = 0;
    deps.agentSendChatMessage = vi.fn(
      async (childSessionId: string, request: ChatSendMessageRequest): Promise<ChatSendMessageResponse> => {
        childCallCount += 1;
        const response = createChatResponse(childSessionId);
        if (childCallCount === 1) {
          return {
            ...response,
            trace: {
              ...response.trace,
              status: "waiting_for_approval",
              durable: { runId: `durable-${childSessionId}`, status: "waiting" },
            },
          };
        }
        expect(request.content).toContain("Completed after the stale precheck");
        return response;
      },
    ) as never;
    const request = {
      objective: "Use database-locked dependency truth",
      roles: ["architect", "qa"],
      mode: "parallel" as const,
      policyRunId: "parent-durable-run-dependency-lock-race",
      steps: [
        { stepId: "architect-step", role: "architect", index: 0, parallelizable: true },
        { stepId: "qa-step", role: "qa", index: 1, dependsOnStepIds: ["architect-step"] },
      ],
    };

    const waiting = await service.runChatDelegation("sess-1", request);
    const architect = waiting.steps[0]!;
    steps.set(architect.stepId, {
      ...architect,
      status: "failed",
      output: undefined,
      error: "stale failed dependency snapshot",
      finishedAt: "2026-07-11T00:00:02.000Z",
    });

    const getParentForUpdate = deps.storage.chatDelegationRuns.getForUpdate.getMockImplementation()!;
    let injectedCompletion = false;
    deps.storage.chatDelegationRuns.getForUpdate.mockImplementation((runId) => {
      if (!injectedCompletion) {
        const staleDependency = steps.get(architect.stepId)!;
        steps.set(architect.stepId, {
          ...staleDependency,
          status: "completed",
          output: "Completed after the stale precheck",
          error: undefined,
          finishedAt: "2026-07-11T00:00:03.000Z",
        });
        injectedCompletion = true;
      }
      return getParentForUpdate(runId);
    });
    let transactionDepth = 0;
    deps.storage.runImmediateTransaction.mockImplementation(async (callback) => {
      transactionDepth += 1;
      try {
        return await callback();
      } finally {
        transactionDepth -= 1;
      }
    });
    deps.storage.chatDelegationSteps.finishUnclaimedPendingWithError.mockClear();
    deps.taskLifecycleService.publishDelegationActivity.mockImplementation(() => {
      expect(transactionDepth).toBe(0);
    });
    const onStep = vi.fn(() => {
      expect(transactionDepth).toBe(0);
    });

    const resumed = await new ChatDelegationService(deps).runChatDelegation("sess-1", request, { onStep });

    expect(injectedCompletion).toBe(true);
    expect(resumed.status).toBe("completed");
    expect(resumed.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(2);
    expect(deps.storage.chatDelegationSteps.finishUnclaimedPendingWithError).not.toHaveBeenCalled();
    expect(
      deps.taskLifecycleService.publishDelegationActivity.mock.calls.some(([activity]) =>
        activity.message.includes("skipped delegation step"),
      ),
    ).toBe(false);
    expect(onStep).toHaveBeenCalled();
  });

  it("waits when database-locked dependency truth is still active after a stale failed precheck", async () => {
    const { deps, service, steps } = createHarness();
    deps.agentSendChatMessage = vi.fn(async (childSessionId: string): Promise<ChatSendMessageResponse> => {
      const response = createChatResponse(childSessionId);
      return {
        ...response,
        trace: {
          ...response.trace,
          status: "waiting_for_approval",
          durable: { runId: `durable-${childSessionId}`, status: "waiting" },
        },
      };
    }) as never;
    const request = {
      objective: "Wait for database-locked dependency truth",
      roles: ["architect", "qa"],
      mode: "parallel" as const,
      policyRunId: "parent-durable-run-dependency-active-race",
      steps: [
        { stepId: "architect-step", role: "architect", index: 0, parallelizable: true },
        { stepId: "qa-step", role: "qa", index: 1, dependsOnStepIds: ["architect-step"] },
      ],
    };

    const waiting = await service.runChatDelegation("sess-1", request);
    const architect = waiting.steps[0]!;
    steps.set(architect.stepId, {
      ...architect,
      status: "failed",
      error: "stale failed dependency snapshot",
      finishedAt: "2026-07-11T00:00:02.000Z",
    });
    const getParentForUpdate = deps.storage.chatDelegationRuns.getForUpdate.getMockImplementation()!;
    let injectedActiveTruth = false;
    deps.storage.chatDelegationRuns.getForUpdate.mockImplementation((runId) => {
      if (!injectedActiveTruth) {
        const staleDependency = steps.get(architect.stepId)!;
        steps.set(architect.stepId, {
          ...staleDependency,
          status: "running",
          error: undefined,
          finishedAt: undefined,
        });
        injectedActiveTruth = true;
      }
      return getParentForUpdate(runId);
    });
    deps.storage.chatDelegationSteps.finishUnclaimedPendingWithError.mockClear();

    const resumed = await new ChatDelegationService(deps).runChatDelegation("sess-1", request);

    expect(injectedActiveTruth).toBe(true);
    expect(resumed.status).toBe("running");
    expect(resumed.steps.map((step) => step.status)).toEqual(["running", "pending"]);
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(1);
    expect(deps.storage.chatDelegationSteps.finishUnclaimedPendingWithError).not.toHaveBeenCalled();
    expect(
      deps.taskLifecycleService.publishDelegationActivity.mock.calls.some(([activity]) =>
        activity.message.includes("skipped delegation step"),
      ),
    ).toBe(false);
  });

  it("converges concurrent durable wakes on one stable task, run, step, and child dispatch", async () => {
    const { deps } = createHarness();
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    deps.agentSendChatMessage = vi.fn(
      async (
        childSessionId: string,
        _request: ChatSendMessageRequest,
        options?: { turnIdentity?: TestAgentTurnIdentity },
      ) => {
        markEntered();
        await blocked;
        expect(options?.turnIdentity).toBeDefined();
        return createIdentifiedChatResponse(childSessionId, options!.turnIdentity!);
      },
    ) as never;
    const request = {
      objective: "Converge duplicate durable wakeups",
      roles: ["coder"],
      mode: "sequential" as const,
      policyRunId: "durable-parent-concurrent",
    };

    const firstPromise = new ChatDelegationService(deps).runChatDelegation("sess-1", request);
    await entered;
    const duplicateResult = await new ChatDelegationService(deps).runChatDelegation("sess-1", request);
    releaseFirst();
    const firstResult = await firstPromise;

    expect(firstResult.runId).toBe(duplicateResult.runId);
    expect(firstResult.taskId).toBe(duplicateResult.taskId);
    expect(firstResult.runId).toMatch(/^delegation-run-/);
    expect(firstResult.taskId).toMatch(/^delegation-task-/);
    expect(firstResult.steps[0]?.stepId).toBe(duplicateResult.steps[0]?.stepId);
    expect(deps.taskLifecycleService.createTask).toHaveBeenCalledTimes(1);
    expect(deps.taskLifecycleService.createTask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ taskId: firstResult.taskId }),
    );
    expect(deps.storage.chatDelegationRuns.create).toHaveBeenCalledTimes(1);
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(1);
    expect(deps.createChatSession).toHaveBeenCalledTimes(1);
    expect(deps.createChatSession).toHaveBeenCalledWith(expect.objectContaining({ stableKey: expect.any(String) }));
  });

  it("fails a conflicting durable wake closed before it can mismatch stable task and run provenance", async () => {
    const { deps, runs, tasks, stableChildSessions } = createHarness();
    const winnerRequest = {
      objective: "Implement the canonical durable plan",
      roles: ["coder"],
      mode: "sequential" as const,
      policyRunId: "durable-parent-conflicting-plan",
    };
    const loserRequest = {
      objective: "Replace the canonical durable plan with a different objective",
      roles: ["architect", "qa"],
      mode: "parallel" as const,
      policyRunId: "durable-parent-conflicting-plan",
    };
    const createRun = deps.storage.chatDelegationRuns.create.getMockImplementation()!;
    let losingWake!: Promise<ChatDelegateResponse>;
    deps.storage.chatDelegationRuns.create.mockImplementationOnce((input) => {
      losingWake = new ChatDelegationService(deps).runChatDelegation("sess-1", loserRequest);
      void losingWake.catch(() => undefined);
      return createRun(input);
    });

    const winner = await new ChatDelegationService(deps).runChatDelegation("sess-1", winnerRequest);

    await expect(losingWake).rejects.toThrow(/different persisted plan/);
    expect(winner.status).toBe("completed");
    expect(tasks.size).toBe(1);
    expect(runs.size).toBe(1);
    expect(stableChildSessions.size).toBe(1);
    expect([...runs.values()][0]).toEqual(
      expect.objectContaining({ objective: winnerRequest.objective, roles: ["coder"], taskId: winner.taskId }),
    );
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps stable durable reuse fenced by the persisted explorer workflow in both directions", async () => {
    const request = {
      objective: "Inspect the canonical workspace",
      roles: ["workspace-explorer"],
      mode: "sequential" as const,
      policyRunId: "durable-parent-profile-fence",
      operatorId: "operator-1",
      authActorId: "operator-1",
    };
    const standardHarness = createHarness();
    await standardHarness.service.runChatDelegation("sess-1", request);

    await expect(
      standardHarness.service.runChatDelegation("sess-1", {
        ...request,
        executionProfile: "read_only_explorer",
      }),
    ).rejects.toThrow(/different persisted plan/);
    expect([...standardHarness.runs.values()]).toHaveLength(1);
    expect([...standardHarness.runs.values()][0]?.workflowTemplate).toBeUndefined();

    const explorerHarness = createHarness();
    explorerHarness.runs.set("persisted-explorer-run", {
      runId: "persisted-explorer-run",
      parentRunId: request.policyRunId,
      sessionId: "sess-1",
      taskId: "persisted-explorer-task",
      objective: request.objective,
      roles: request.roles,
      mode: request.mode,
      status: "running",
      workflowTemplate: READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE,
      citations: [],
      startedAt: "2026-08-12T00:00:00.000Z",
    });

    await expect(explorerHarness.service.runChatDelegation("sess-1", request)).rejects.toThrow(
      /different persisted plan/,
    );
    expect(explorerHarness.deps.taskLifecycleService.createTask).not.toHaveBeenCalled();
    expect(explorerHarness.deps.agentSendChatMessage).not.toHaveBeenCalled();
  });

  it("fails a durable wake closed when the canonical dependency topology or parallelism changes", async () => {
    const { deps, service } = createHarness();
    const canonicalRequest = {
      objective: "Execute one canonical durable graph",
      roles: ["architect", "qa"],
      mode: "parallel" as const,
      policyRunId: "durable-parent-conflicting-topology",
      steps: [
        { stepId: "architect-step", role: "architect", index: 0, parallelizable: true },
        { stepId: "qa-step", role: "qa", index: 1, parallelizable: true },
      ],
    };

    const completed = await service.runChatDelegation("sess-1", canonicalRequest);
    const exactReplay = await service.runChatDelegation("sess-1", canonicalRequest);

    await expect(
      service.runChatDelegation("sess-1", {
        ...canonicalRequest,
        steps: [canonicalRequest.steps[0], { ...canonicalRequest.steps[1], dependsOnStepIds: ["architect-step"] }],
      }),
    ).rejects.toThrow(/does not match the durable parent plan/);
    await expect(
      service.runChatDelegation("sess-1", {
        ...canonicalRequest,
        steps: [canonicalRequest.steps[0], { ...canonicalRequest.steps[1], parallelizable: false }],
      }),
    ).rejects.toThrow(/does not match the durable parent plan/);

    expect(exactReplay).toEqual(expect.objectContaining({ runId: completed.runId, status: "completed" }));
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(2);
  });

  it("reclaims a running step that crashed before child-session linkage", async () => {
    const { deps, steps } = createHarness();
    const request = {
      objective: "Recover a child dispatch before linkage",
      roles: ["coder"],
      mode: "sequential" as const,
      policyRunId: "durable-parent-before-link",
    };
    deps.agentSendChatMessage = vi.fn(
      async (
        childSessionId: string,
        _request: ChatSendMessageRequest,
        options?: { turnIdentity?: TestAgentTurnIdentity },
      ) => {
        const response = createIdentifiedChatResponse(childSessionId, options!.turnIdentity!);
        if (deps.agentSendChatMessage.mock.calls.length === 1) {
          return {
            ...response,
            assistantMessage: undefined,
            trace: { ...response.trace!, status: "waiting_for_tool" },
          };
        }
        return response;
      },
    ) as never;

    const waiting = await new ChatDelegationService(deps).runChatDelegation("sess-1", request);
    const crashed = waiting.steps[0]!;
    steps.set(crashed.stepId, {
      ...crashed,
      status: "running",
      childSessionId: undefined,
      childTurnId: undefined,
      output: undefined,
    });

    const recovered = await new ChatDelegationService(deps).runChatDelegation("sess-1", request);

    expect(recovered.status).toBe("completed");
    expect(recovered.steps[0]?.status).toBe("completed");
    expect(deps.storage.chatDelegationSteps.reclaimRunningForDispatch).toHaveBeenCalledWith(
      crashed.stepId,
      undefined,
      expect.stringMatching(/^delegation-claim:/),
      expect.any(String),
      expect.any(String),
    );
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(2);
    expect(deps.createChatSession).toHaveBeenCalledTimes(2);
    expect(new Set(deps.createChatSession.mock.results.map((result) => result.value.sessionId))).toEqual(
      new Set(["delegate-session-1"]),
    );
  });

  it("reuses the linked child and deterministic turn after a crash immediately before send", async () => {
    const { deps, dispatchClaims, steps } = createHarness();
    const request = {
      objective: "Recover a linked deterministic child turn",
      roles: ["qa"],
      mode: "sequential" as const,
      policyRunId: "durable-parent-after-link",
    };
    const identities: TestAgentTurnIdentity[] = [];
    deps.agentSendChatMessage = vi.fn(
      async (
        childSessionId: string,
        _request: ChatSendMessageRequest,
        options?: { turnIdentity?: TestAgentTurnIdentity },
      ) => {
        const identity = options!.turnIdentity!;
        identities.push(identity);
        const response = createIdentifiedChatResponse(childSessionId, identity);
        if (deps.agentSendChatMessage.mock.calls.length === 1) {
          return {
            ...response,
            assistantMessage: undefined,
            trace: { ...response.trace!, status: "waiting_for_tool" },
          };
        }
        return response;
      },
    ) as never;

    const waiting = await new ChatDelegationService(deps).runChatDelegation("sess-1", request);
    const linked = waiting.steps[0]!;
    steps.set(linked.stepId, {
      ...linked,
      status: "running",
      childTurnId: undefined,
      output: undefined,
    });
    dispatchClaims.set(linked.stepId, {
      token: `delegation-dispatch:v1:0:${identities[0]!.turnId}:crashed-owner`,
      expiresAt: "1970-01-01T00:00:00.000Z",
    });

    const recovered = await new ChatDelegationService(deps).runChatDelegation("sess-1", request);

    expect(recovered.status).toBe("completed");
    expect(recovered.steps[0]?.childSessionId).toBe(linked.childSessionId);
    expect(recovered.steps[0]?.childTurnId).toBe(identities[0]!.turnId);
    expect(identities).toHaveLength(2);
    expect(identities[1]).toEqual(identities[0]);
    expect(deps.createChatSession).toHaveBeenCalledTimes(1);
    expect(deps.agentSendChatMessage).toHaveBeenNthCalledWith(
      2,
      linked.childSessionId,
      expect.any(Object),
      expect.objectContaining({ turnIdentity: identities[0] }),
    );
  });

  it("does not reclaim an active dispatch when the application clock jumps ahead", async () => {
    const { deps, tasks, runs, stableChildSessions } = createHarness();
    let releaseOriginal!: () => void;
    let markOriginalEntered!: () => void;
    const originalEntered = new Promise<void>((resolve) => {
      markOriginalEntered = resolve;
    });
    const originalBlocked = new Promise<void>((resolve) => {
      releaseOriginal = resolve;
    });
    let providerExecutions = 0;
    deps.agentSendChatMessage = vi.fn(
      async (
        childSessionId: string,
        _request: ChatSendMessageRequest,
        options?: { turnIdentity?: TestAgentTurnIdentity },
      ) => {
        providerExecutions += 1;
        markOriginalEntered();
        await originalBlocked;
        return createIdentifiedChatResponse(childSessionId, options!.turnIdentity!);
      },
    ) as never;
    const request = {
      objective: "Keep an active child lease under application clock skew",
      roles: ["coder"],
      policyRunId: "durable-parent-app-clock-skew",
    };

    const originalPromise = new ChatDelegationService(deps).runChatDelegation("sess-1", request);
    await originalEntered;
    const clockSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2099-01-01T00:00:00.000Z"));
    try {
      const duplicateWake = await new ChatDelegationService(deps).runChatDelegation("sess-1", request);
      expect(duplicateWake.status).toBe("running");
      expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(1);
      expect(providerExecutions).toBe(1);
    } finally {
      clockSpy.mockRestore();
      releaseOriginal();
    }
    const completed = await originalPromise;

    expect(completed.status).toBe("completed");
    expect(tasks.size).toBe(1);
    expect(runs.size).toBe(1);
    expect(stableChildSessions.size).toBe(1);
    expect(deps.createChatSession).toHaveBeenCalledTimes(1);
  });

  it("fences a stale owner at the child execution boundary after a real lease takeover", async () => {
    const { deps, dispatchClaims, runs, steps, tasks, stableChildSessions, setDatabaseNow } = createHarness();
    let releaseStaleOwner!: () => void;
    let markStaleOwnerEntered!: () => void;
    const staleOwnerEntered = new Promise<void>((resolve) => {
      markStaleOwnerEntered = resolve;
    });
    const staleOwnerBlocked = new Promise<void>((resolve) => {
      releaseStaleOwner = resolve;
    });
    let providerBoundaryCalls = 0;
    deps.agentSendChatMessage = vi.fn(
      async (
        childSessionId: string,
        _request: ChatSendMessageRequest,
        options?: {
          turnIdentity?: TestAgentTurnIdentity;
          assertDispatchOwnership?: () => Promise<void>;
        },
      ) => {
        const callNumber = deps.agentSendChatMessage.mock.calls.length;
        if (callNumber === 1) {
          markStaleOwnerEntered();
          await staleOwnerBlocked;
        }
        await options?.assertDispatchOwnership?.();
        providerBoundaryCalls += 1;
        return createIdentifiedChatResponse(childSessionId, options!.turnIdentity!);
      },
    ) as never;
    const request = {
      objective: "Fence a superseded child dispatch owner",
      roles: ["coder"],
      policyRunId: "durable-parent-stale-owner-fence",
    };

    const staleOwnerPromise = new ChatDelegationService(deps).runChatDelegation("sess-1", request);
    await staleOwnerEntered;
    const projectedInFlightStep = [...steps.values()][0]!;
    expect(projectedInFlightStep.childSessionId).toMatch(/^delegate-session-/);
    expect(projectedInFlightStep.childSessionId).not.toContain("delegation-claim");
    expect(projectedInFlightStep.childTurnId).toBeUndefined();
    expect(dispatchClaims.get(projectedInFlightStep.stepId)?.token).toMatch(/^delegation-dispatch:/);
    setDatabaseNow("2026-07-11T02:00:00.000Z");
    const takeover = await new ChatDelegationService(deps).runChatDelegation("sess-1", request);
    expect(takeover.status).toBe("completed");
    expect(providerBoundaryCalls).toBe(1);

    releaseStaleOwner();
    const staleOwnerResult = await staleOwnerPromise;

    expect(staleOwnerResult.status).toBe("completed");
    expect(providerBoundaryCalls).toBe(1);
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(2);
    expect(tasks.size).toBe(1);
    expect(runs.size).toBe(1);
    expect(stableChildSessions.size).toBe(1);
    expect(deps.taskLifecycleService.appendTaskDeliverable).toHaveBeenCalledTimes(1);
    expect(
      deps.taskLifecycleService.appendTaskActivity.mock.calls.filter(
        ([, activity]) => activity.activityType === "handoff",
      ),
    ).toHaveLength(1);
  });

  it("does not let a stale owner's ordinary provider rejection overwrite a replacement completion", async () => {
    const { deps, runs, steps, tasks, stableChildSessions, setDatabaseNow } = createHarness();
    let releaseStaleOwner!: () => void;
    let markStaleOwnerEntered!: () => void;
    const staleOwnerEntered = new Promise<void>((resolve) => {
      markStaleOwnerEntered = resolve;
    });
    const staleOwnerBlocked = new Promise<void>((resolve) => {
      releaseStaleOwner = resolve;
    });
    deps.agentSendChatMessage = vi.fn(
      async (
        childSessionId: string,
        _request: ChatSendMessageRequest,
        options?: { turnIdentity?: TestAgentTurnIdentity; assertDispatchOwnership?: () => Promise<void> },
      ) => {
        const callNumber = deps.agentSendChatMessage.mock.calls.length;
        if (callNumber === 1) {
          markStaleOwnerEntered();
          await staleOwnerBlocked;
          throw new Error("late stale-owner provider rejection");
        }
        await options?.assertDispatchOwnership?.();
        return createIdentifiedChatResponse(childSessionId, options!.turnIdentity!);
      },
    ) as never;
    const request = {
      objective: "Preserve replacement completion after stale provider rejection",
      roles: ["coder"],
      policyRunId: "durable-parent-stale-provider-rejection",
    };

    const staleOwnerPromise = new ChatDelegationService(deps).runChatDelegation("sess-1", request);
    await staleOwnerEntered;
    setDatabaseNow("2026-07-11T02:00:00.000Z");
    const replacement = await new ChatDelegationService(deps).runChatDelegation("sess-1", request);
    expect(replacement.status).toBe("completed");

    releaseStaleOwner();
    const staleOwnerResult = await staleOwnerPromise;

    expect(staleOwnerResult.status).toBe("completed");
    expect([...steps.values()][0]).toEqual(expect.objectContaining({ status: "completed" }));
    expect([...steps.values()][0]?.error).not.toBe("late stale-owner provider rejection");
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(2);
    expect(tasks.size).toBe(1);
    expect(runs.size).toBe(1);
    expect(stableChildSessions.size).toBe(1);
    expect(deps.taskLifecycleService.appendTaskDeliverable).toHaveBeenCalledTimes(1);
  });

  it("does not let a response overwrite a replacement dispatch that wins before the atomic commit", async () => {
    const { deps, dispatchClaims, service, steps } = createHarness();
    const commitResponse = deps.storage.chatDelegationSteps.finishOwnedDispatchWithResponse.getMockImplementation()!;
    deps.storage.chatDelegationSteps.finishOwnedDispatchWithResponse.mockImplementation((input) => {
      dispatchClaims.set(input.stepId, {
        token: "replacement-response-owner",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      return commitResponse(input);
    });

    const result = await service.runChatDelegation("sess-1", {
      objective: "Fence a response commit after replacement takeover",
      roles: ["coder"],
      policyRunId: "durable-parent-response-commit-race",
    });

    const step = [...steps.values()][0]!;
    expect(step.status).toBe("running");
    expect(step.output).toBeUndefined();
    expect(step.childTurnId).toBeUndefined();
    expect(dispatchClaims.get(step.stepId)?.token).toBe("replacement-response-owner");
    expect(result.steps[0]).toEqual(expect.objectContaining({ status: "running" }));
    expect(deps.taskLifecycleService.appendTaskDeliverable).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.publishDelegationAggregateTask).not.toHaveBeenCalled();
    expect(deps.extractAndPersistLearnedMemory).not.toHaveBeenCalled();
    expect(deps.scheduleChatMemoryContextPrewarm).not.toHaveBeenCalled();
  });

  it("repairs a missing terminal summary once and keeps duplicate terminal wakes read-only", async () => {
    const { activityReceipts, deps, service } = createHarness();
    const request = {
      objective: "Repair terminal summary receipt",
      roles: ["qa"],
      policyRunId: "durable-terminal-summary-repair",
    };
    const completed = await service.runChatDelegation("sess-1", request);
    const summaryReceiptId = [...activityReceipts.keys()].find((key) => key.startsWith("delegation-summary-activity"));
    expect(summaryReceiptId).toBeDefined();
    activityReceipts.delete(summaryReceiptId!);
    deps.taskLifecycleService.publishDelegationActivity.mockClear();
    deps.taskLifecycleService.publishDelegationAggregateTask.mockClear();
    deps.extractAndPersistLearnedMemory.mockClear();
    deps.scheduleChatMemoryContextPrewarm.mockClear();
    const providerCalls = deps.agentSendChatMessage.mock.calls.length;

    const repaired = await service.runChatDelegation("sess-1", request);
    const duplicate = await service.runChatDelegation("sess-1", request);

    expect(repaired).toEqual(expect.objectContaining({ runId: completed.runId, status: "completed" }));
    expect(duplicate).toEqual(expect.objectContaining({ runId: completed.runId, status: "completed" }));
    expect(deps.taskLifecycleService.publishDelegationActivity).toHaveBeenCalledTimes(1);
    expect(deps.taskLifecycleService.publishDelegationAggregateTask).not.toHaveBeenCalled();
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(providerCalls);
    expect(deps.extractAndPersistLearnedMemory).not.toHaveBeenCalled();
    expect(deps.scheduleChatMemoryContextPrewarm).not.toHaveBeenCalled();
  });

  it("repairs terminal parent and task truth from locked steps before returning a stable replay", async () => {
    const { deps, runs, service, tasks } = createHarness();
    const request = {
      objective: "Repair terminal replay truth under locks",
      roles: ["qa"],
      policyRunId: "durable-terminal-aggregate-repair",
    };
    const completed = await service.runChatDelegation("sess-1", request);
    const run = runs.get(completed.runId)!;
    const task = tasks.get(completed.taskId)!;
    runs.set(completed.runId, {
      ...run,
      status: "failed",
      stitchedOutput: "stale parent output",
      citations: [],
      finishedAt: "2026-07-11T00:10:00.000Z",
    });
    tasks.set(completed.taskId, {
      ...task,
      status: "blocked",
      agenticContext: { ...task.agenticContext!, status: "failed", failureClass: "missing_handoff" },
    });
    deps.taskLifecycleService.publishDelegationAggregateTask.mockClear();
    const providerCalls = deps.agentSendChatMessage.mock.calls.length;

    const replay = await service.runChatDelegation("sess-1", request);

    expect(replay).toEqual(
      expect.objectContaining({
        runId: completed.runId,
        status: "completed",
        stitchedOutput: completed.stitchedOutput,
        citations: completed.citations,
      }),
    );
    expect(runs.get(completed.runId)).toEqual(
      expect.objectContaining({
        status: "completed",
        stitchedOutput: completed.stitchedOutput,
        citations: completed.citations,
      }),
    );
    expect(tasks.get(completed.taskId)).toEqual(
      expect.objectContaining({
        status: "review",
        agenticContext: expect.objectContaining({ status: "completed", failureClass: undefined }),
      }),
    );
    expect(deps.taskLifecycleService.publishDelegationAggregateTask).toHaveBeenCalledTimes(1);
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(providerCalls);
  });

  it("records one truthful correction when a legacy terminal summary conflicts with repaired outcome truth", async () => {
    const { activityReceipts, deps, runs, service, steps, tasks } = createHarness();
    deps.agentSendChatMessage = vi.fn(async () => {
      throw new Error("premature provider failure");
    }) as never;
    const request = {
      objective: "Correct a premature legacy summary",
      roles: ["coder"],
      policyRunId: "durable-terminal-summary-correction",
    };
    const failed = await service.runChatDelegation("sess-1", request);
    const failedStep = steps.get(failed.steps[0]!.stepId)!;
    steps.set(failedStep.stepId, {
      ...failedStep,
      status: "completed",
      output: "Recovered canonical output",
      error: undefined,
      failureGuidance: undefined,
      finishedAt: "2026-07-11T00:20:00.000Z",
    });
    const legacySummaryCount = activityReceipts.size;
    deps.taskLifecycleService.publishDelegationActivity.mockClear();

    const corrected = await service.runChatDelegation("sess-1", request);
    const exactReplay = await service.runChatDelegation("sess-1", request);

    expect(corrected).toEqual(
      expect.objectContaining({
        status: "completed",
        stitchedOutput: expect.stringContaining("Recovered canonical output"),
      }),
    );
    expect(exactReplay).toEqual(expect.objectContaining({ runId: failed.runId, status: "completed" }));
    expect(runs.get(failed.runId)?.status).toBe("completed");
    expect(tasks.get(failed.taskId)).toEqual(
      expect.objectContaining({ status: "review", agenticContext: expect.objectContaining({ status: "completed" }) }),
    );
    expect(activityReceipts.size).toBe(legacySummaryCount + 1);
    expect(
      [...activityReceipts.values()].filter(
        (activity) => activity.message === "Delegation completed." && activity.metadata?.completedSteps === 1,
      ),
    ).toHaveLength(1);
    expect(deps.taskLifecycleService.publishDelegationActivity).toHaveBeenCalledTimes(1);
  });

  it("isolates post-commit publication failures without downgrading outcome or suppressing later publishers", async () => {
    const { deps, service, steps } = createHarness();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    deps.taskLifecycleService.publishDelegationSubagentProjection.mockImplementationOnce(() => {
      throw new Error("subagent realtime unavailable");
    });

    try {
      const result = await service.runChatDelegation("sess-1", {
        objective: "Keep canonical delegation truth after realtime failure",
        roles: ["coder"],
        policyRunId: "durable-postcommit-publication-isolation",
      });

      expect(result).toEqual(expect.objectContaining({ status: "completed" }));
      expect([...steps.values()][0]).toEqual(expect.objectContaining({ status: "completed", error: undefined }));
      expect(deps.taskLifecycleService.publishDelegationSubagentProjection).toHaveBeenCalledTimes(1);
      expect(deps.taskLifecycleService.publishDelegationActivity).toHaveBeenCalled();
      expect(deps.taskLifecycleService.publishDelegationDeliverable).toHaveBeenCalledTimes(1);
      expect(deps.taskLifecycleService.publishDelegationAggregateTask).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("subagent projection publication failed"));
    } finally {
      stderr.mockRestore();
    }
  });

  it("continues from a failed aggregate publisher to the independently committed terminal summary", async () => {
    const { deps, service } = createHarness();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    deps.taskLifecycleService.publishDelegationAggregateTask.mockImplementationOnce(() => {
      throw new Error("aggregate realtime unavailable");
    });

    try {
      const result = await service.runChatDelegation("sess-1", {
        objective: "Publish every independent committed projection",
        roles: ["qa"],
        policyRunId: "durable-postcommit-aggregate-isolation",
      });

      expect(result).toEqual(expect.objectContaining({ status: "completed" }));
      expect(deps.taskLifecycleService.publishDelegationAggregateTask).toHaveBeenCalledTimes(1);
      expect(deps.taskLifecycleService.publishDelegationActivity).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Delegation completed." }),
      );
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("aggregate task publication failed"));
    } finally {
      stderr.mockRestore();
    }
  });

  it("does not publish aggregate task or completion activity when the aggregate transaction rolls back", async () => {
    const { deps, dispatchClaims, runs, service, steps, tasks } = createHarness();
    const transaction = deps.storage.runImmediateTransaction.getMockImplementation()!;
    deps.storage.runImmediateTransaction.mockImplementation(async (callback) => {
      const stepSnapshot = new Map([...steps].map(([key, value]) => [key, { ...value }]));
      const claimSnapshot = new Map([...dispatchClaims].map(([key, value]) => [key, { ...value }]));
      const runSnapshot = new Map([...runs].map(([key, value]) => [key, { ...value }]));
      const taskSnapshot = new Map([...tasks].map(([key, value]) => [key, { ...value }]));
      try {
        return await transaction(callback);
      } catch (error) {
        steps.clear();
        stepSnapshot.forEach((value, key) => steps.set(key, value));
        dispatchClaims.clear();
        claimSnapshot.forEach((value, key) => dispatchClaims.set(key, value));
        runs.clear();
        runSnapshot.forEach((value, key) => runs.set(key, value));
        tasks.clear();
        taskSnapshot.forEach((value, key) => tasks.set(key, value));
        throw error;
      }
    });
    deps.taskLifecycleService.persistDelegationAggregateTask.mockImplementation(() => {
      throw new Error("aggregate transaction rolled back");
    });

    await expect(
      service.runChatDelegation("sess-1", {
        objective: "Roll back aggregate proof",
        roles: ["qa"],
      }),
    ).rejects.toThrow("aggregate transaction rolled back");

    expect(deps.taskLifecycleService.publishDelegationAggregateTask).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.publishDelegationSubagentProjection).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.publishDelegationActivity).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.publishDelegationDeliverable).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.appendTaskActivity).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ message: "Delegation completed." }),
    );
  });

  it("repairs a terminal parent and task before resuming an active persisted step", async () => {
    const { runs, service, steps, tasks } = createHarness();
    const request = {
      objective: "Repair an impossible terminal parent before resume",
      roles: ["coder"],
      policyRunId: "durable-parent-terminal-active-repair",
    };
    const seeded = await service.runChatDelegation("sess-1", request);
    const seededRun = runs.get(seeded.runId)!;
    const seededStep = steps.get(seeded.steps[0]!.stepId)!;
    const seededTask = tasks.get(seeded.taskId)!;
    runs.set(seeded.runId, {
      ...seededRun,
      status: "completed",
      finishedAt: "2026-07-11T00:10:00.000Z",
    });
    steps.set(seededStep.stepId, {
      ...seededStep,
      status: "running",
      finishedAt: undefined,
      durationMs: undefined,
    });
    tasks.set(seeded.taskId, {
      ...seededTask,
      status: "review",
      agenticContext: { ...seededTask.agenticContext!, status: "completed", activeChildCount: 0 },
    });
    let parentWasRepairedBeforeDispatch = false;
    const resumed = await service.runChatDelegation("sess-1", request, {
      onStatus: () => {
        parentWasRepairedBeforeDispatch =
          runs.get(seeded.runId)?.status === "running" &&
          runs.get(seeded.runId)?.finishedAt === undefined &&
          tasks.get(seeded.taskId)?.status === "in_progress" &&
          tasks.get(seeded.taskId)?.agenticContext?.status === "running";
      },
    });

    expect(parentWasRepairedBeforeDispatch).toBe(true);
    expect(resumed.status).toBe("running");
    expect(resumed.steps[0]?.status).toBe("running");
    expect(runs.get(seeded.runId)?.status).toBe("running");
    expect(runs.get(seeded.runId)?.finishedAt).toBeUndefined();
    expect(tasks.get(seeded.taskId)).toEqual(
      expect.objectContaining({
        status: "in_progress",
        agenticContext: expect.objectContaining({ status: "running" }),
      }),
    );
  });

  it("recomputes parent, task, and citations from locked steps after a replacement completion", async () => {
    const { deps, dispatchClaims, runs, service, steps, tasks } = createHarness();
    deps.storage.chatDelegationSteps.finishOwnedDispatchWithResponse.mockImplementation((input) => {
      dispatchClaims.set(input.stepId, {
        token: "replacement-aggregate-owner",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      return undefined;
    });
    deps.storage.chatDelegationSteps.listByRunForUpdate.mockImplementation((runId) => {
      const current = [...steps.values()].find((step) => step.runId === runId)!;
      const replacement = {
        ...current,
        status: "completed" as const,
        output: "replacement worker output",
        childTurnId: "replacement-turn",
        citations: [{ citationId: "replacement-citation", title: "Replacement evidence" }],
      };
      steps.set(current.stepId, replacement);
      dispatchClaims.delete(current.stepId);
      return [replacement];
    });

    const result = await service.runChatDelegation("sess-1", {
      objective: "Recompute aggregate from replacement truth",
      roles: ["researcher"],
      policyRunId: "durable-parent-aggregate-recompute",
    });

    expect(result.status).toBe("completed");
    expect(result.stitchedOutput).toContain("replacement worker output");
    expect(result.citations).toEqual([
      expect.objectContaining({ citationId: "replacement-citation", title: "Replacement evidence" }),
    ]);
    expect([...runs.values()][0]).toEqual(expect.objectContaining({ status: "completed" }));
    expect([...tasks.values()][0]).toEqual(
      expect.objectContaining({ status: "review", agenticContext: expect.objectContaining({ status: "completed" }) }),
    );
  });

  it("does not let a pre-claim abort cancel a step claimed by another worker at the terminal CAS", async () => {
    const { deps, dispatchClaims, service, steps } = createHarness();
    const finishUnclaimedPendingWithError = vi.fn(
      (
        input: Parameters<
          ChatDelegationServiceHost["storage"]["chatDelegationSteps"]["finishUnclaimedPendingWithError"]
        >[0],
      ) => {
        deps.storage.chatDelegationSteps.claimPendingForDispatch(
          input.stepId,
          "replacement-preclaim-owner",
          "2099-01-01T00:00:00.000Z",
          "2026-07-11T00:00:01.000Z",
        );
        return undefined;
      },
    );
    deps.storage.chatDelegationSteps.finishUnclaimedPendingWithError = finishUnclaimedPendingWithError;
    const controller = new AbortController();

    const result = await service.runChatDelegation(
      "sess-1",
      {
        objective: "Preserve a concurrently claimed pre-dispatch step",
        roles: ["qa"],
        policyRunId: "durable-parent-preclaim-abort-race",
      },
      {
        onStatus: async () => {
          controller.abort(new Error("operator cancelled stale worker"));
        },
      },
      { abortSignal: controller.signal },
    );

    const step = [...steps.values()][0]!;
    expect(finishUnclaimedPendingWithError).toHaveBeenCalledTimes(1);
    expect(step.status).toBe("running");
    expect(step.error).toBeUndefined();
    expect(dispatchClaims.get(step.stepId)?.token).toBe("replacement-preclaim-owner");
    expect(result.steps[0]).toEqual(expect.objectContaining({ status: "running" }));
  });

  it("reconciles canonical completion after a skewed reclaimer overtakes the late original owner", async () => {
    const { deps, dispatchClaims, runs, steps, tasks, traces, stableChildSessions } = createHarness();
    const request = {
      objective: "Reconcile a late deterministic child completion",
      roles: ["coder"],
      mode: "sequential" as const,
      policyRunId: "durable-parent-clock-skew",
    };
    let releaseOriginal!: () => void;
    let markOriginalEntered!: () => void;
    const originalEntered = new Promise<void>((resolve) => {
      markOriginalEntered = resolve;
    });
    const originalBlocked = new Promise<void>((resolve) => {
      releaseOriginal = resolve;
    });
    let providerExecutions = 0;
    let identity!: TestAgentTurnIdentity;
    deps.agentSendChatMessage = vi.fn(
      async (
        childSessionId: string,
        _request: ChatSendMessageRequest,
        options?: { turnIdentity?: TestAgentTurnIdentity },
      ) => {
        identity = options!.turnIdentity!;
        const callNumber = deps.agentSendChatMessage.mock.calls.length;
        if (callNumber === 1) {
          providerExecutions += 1;
          markOriginalEntered();
          await originalBlocked;
          const completed = createIdentifiedChatResponse(childSessionId, identity);
          traces.set(identity.turnId, completed.trace!);
          return completed;
        }
        const canonicalTrace = traces.get(identity.turnId)!;
        return createIdentifiedChatResponse(childSessionId, identity, {
          assistantMessage:
            canonicalTrace.status === "completed"
              ? createIdentifiedChatResponse(childSessionId, identity).assistantMessage
              : undefined,
          trace: canonicalTrace,
        });
      },
    ) as never;

    const originalPromise = new ChatDelegationService(deps).runChatDelegation("sess-1", request);
    await originalEntered;
    const inFlightStep = [...steps.values()][0]!;
    const runningResponse = createIdentifiedChatResponse(inFlightStep.childSessionId!, identity, {
      assistantMessage: undefined,
    });
    traces.set(identity.turnId, { ...runningResponse.trace!, status: "running" });
    const activeClaim = dispatchClaims.get(inFlightStep.stepId)!;
    dispatchClaims.set(inFlightStep.stepId, {
      token: activeClaim.token.replace(/:v1:\d+:/, ":v1:0:"),
      expiresAt: "1970-01-01T00:00:00.000Z",
    });

    const reclaimed = await new ChatDelegationService(deps).runChatDelegation("sess-1", request);
    expect(reclaimed.status).toBe("running");
    expect(reclaimed.steps[0]?.childTurnId).toBe(identity.turnId);

    releaseOriginal();
    const lateOriginal = await originalPromise;
    expect(lateOriginal.status).toBe("running");
    expect(lateOriginal.steps[0]?.childTurnId).toBe(identity.turnId);

    const reconciled = await new ChatDelegationService(deps).runChatDelegation("sess-1", request);

    expect(reconciled.status).toBe("completed");
    expect(reconciled.steps[0]).toEqual(expect.objectContaining({ status: "completed", childTurnId: identity.turnId }));
    expect(providerExecutions).toBe(1);
    expect(tasks.size).toBe(1);
    expect(runs.size).toBe(1);
    expect(stableChildSessions.size).toBe(1);
    expect(deps.createChatSession).toHaveBeenCalledTimes(1);
    expect(deps.taskLifecycleService.appendTaskDeliverable).toHaveBeenCalledTimes(1);
    expect(
      deps.taskLifecycleService.appendTaskActivity.mock.calls.filter(
        ([, activity]) => activity.activityType === "handoff",
      ),
    ).toHaveLength(1);
  });

  it("keeps a canonical queued or running child turn active instead of completing the delegation step", async () => {
    const { deps } = createHarness();
    deps.agentSendChatMessage = vi.fn(
      async (
        childSessionId: string,
        _request: ChatSendMessageRequest,
        options?: { turnIdentity?: TestAgentTurnIdentity },
      ) => {
        const response = createIdentifiedChatResponse(childSessionId, options!.turnIdentity!);
        return {
          ...response,
          assistantMessage: undefined,
          trace: { ...response.trace!, status: "running" },
        };
      },
    ) as never;

    const result = await new ChatDelegationService(deps).runChatDelegation("sess-1", {
      objective: "Observe a running child turn",
      roles: ["researcher"],
      policyRunId: "durable-parent-running-trace",
    });

    expect(result.status).toBe("running");
    expect(result.steps[0]).toEqual(expect.objectContaining({ status: "running", childTurnId: expect.any(String) }));
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

  it("rolls back dependency skip evidence with its aggregate and reconstructs it once on re-entry", async () => {
    const { deps, dispatchClaims, runs, service, steps, tasks } = createHarness();
    const transaction = deps.storage.runImmediateTransaction.getMockImplementation()!;
    deps.storage.runImmediateTransaction.mockImplementation(async (callback) => {
      const stepSnapshot = new Map([...steps].map(([key, value]) => [key, { ...value }]));
      const claimSnapshot = new Map([...dispatchClaims].map(([key, value]) => [key, { ...value }]));
      const runSnapshot = new Map([...runs].map(([key, value]) => [key, { ...value }]));
      const taskSnapshot = new Map([...tasks].map(([key, value]) => [key, { ...value }]));
      try {
        return await transaction(callback);
      } catch (error) {
        steps.clear();
        stepSnapshot.forEach((value, key) => steps.set(key, value));
        dispatchClaims.clear();
        claimSnapshot.forEach((value, key) => dispatchClaims.set(key, value));
        runs.clear();
        runSnapshot.forEach((value, key) => runs.set(key, value));
        tasks.clear();
        taskSnapshot.forEach((value, key) => tasks.set(key, value));
        throw error;
      }
    });
    const persistActivity = deps.taskLifecycleService.persistDelegationActivity.getMockImplementation()!;
    let failSkipEvidence = true;
    deps.taskLifecycleService.persistDelegationActivity.mockImplementation((taskId, input, createdAt) => {
      if (failSkipEvidence && input.message.includes("skipped delegation step")) {
        failSkipEvidence = false;
        throw new Error("skip evidence transaction failed");
      }
      return persistActivity(taskId, input, createdAt);
    });
    deps.agentSendChatMessage = vi.fn(async (childSessionId: string) => {
      const response = createChatResponse(childSessionId);
      return {
        ...response,
        assistantMessage: { ...response.assistantMessage!, content: "" },
        trace: {
          ...response.trace!,
          status: "cancelled",
          failure: { message: "operator cancelled child run" },
        },
      };
    }) as never;
    const request = {
      objective: "Rollback and reconstruct dependency skip evidence",
      roles: ["researcher", "coder"],
      mode: "parallel" as const,
      policyRunId: "durable-dependency-skip-rollback",
      steps: [
        { stepId: "researcher-step", role: "researcher", index: 0 },
        { stepId: "coder-step", role: "coder", index: 1, dependsOnStepIds: ["researcher-step"] },
      ],
    };

    await expect(service.runChatDelegation("sess-1", request)).rejects.toThrow("skip evidence transaction failed");
    expect([...steps.values()].map((step) => step.status)).toEqual(["cancelled", "pending"]);

    const replay = await service.runChatDelegation("sess-1", request);

    expect(replay.steps.map((step) => step.status)).toEqual(["cancelled", "skipped"]);
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(1);
    expect(
      deps.taskLifecycleService.publishDelegationActivity.mock.calls.filter(([activity]) =>
        activity.message.includes("skipped delegation step"),
      ),
    ).toHaveLength(1);
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
        surface: "chat",
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
    expect(deps.taskLifecycleService.persistDelegationSubagentProjection).toHaveBeenCalledWith(
      "delegate-session-1",
      expect.objectContaining({
        status: "paused",
        metadata: expect.objectContaining({
          failureClass: undefined,
          waiting: {
            status: "waiting_for_approval",
            reason: "approval gate tripped",
            childTurnId: "turn-delegate-session-1",
            durableRunId: "durable-delegate-session-1",
            observedAt: expect.any(String),
          },
        }),
      }),
    );
    expect(deps.taskLifecycleService.publishDelegationSubagentProjection).toHaveBeenCalledTimes(1);
    expect(deps.taskLifecycleService.updateTaskSubagent).not.toHaveBeenCalled();
    expect(deps.storage.chatDelegationRuns.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "running", stitchedOutput: expect.stringContaining("WAITING") }),
    );
    expect(deps.taskLifecycleService.persistDelegationAggregateTask).toHaveBeenCalledWith(
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

  it("drops a waiting projection when a replacement dispatch wins before the atomic fence release", async () => {
    const { deps, service, dispatchClaims } = createHarness();
    const onStep = vi.fn();
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
            approvalId: "approval-race",
            reason: "Needs filesystem approval.",
          },
        },
      }),
    ) as never;
    deps.storage.chatDelegationSteps.releaseOwnedWaitingDispatch.mockImplementation((input) => {
      dispatchClaims.set(input.stepId, {
        token: "replacement-dispatch-owner",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      return undefined;
    });

    const result = await service.runChatDelegation(
      "sess-1",
      {
        objective: "Read a local project file",
        roles: ["researcher"],
        mode: "sequential",
      },
      { onStep },
    );

    expect(result.steps[0]?.status).toBe("running");
    expect(dispatchClaims.get(result.steps[0]!.stepId)?.token).toBe("replacement-dispatch-owner");
    expect(deps.taskLifecycleService.persistDelegationSubagentProjection).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.publishDelegationSubagentProjection).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.updateTaskSubagent).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.appendTaskActivity).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ message: expect.stringContaining("is waiting on delegation step") }),
    );
    expect(
      onStep.mock.calls.some(([step]) => (step as ChatDelegationStepRecord).output === "approval gate tripped"),
    ).toBe(false);
  });

  it("rolls back a waiting response when its canonical subagent projection cannot commit", async () => {
    const { deps, dispatchClaims, runs, service, steps, tasks } = createHarness();
    deps.agentSendChatMessage = vi.fn(async (childSessionId: string) =>
      createChatResponse(childSessionId, {
        assistantMessage: undefined,
        citations: [],
        trace: {
          ...createChatResponse(childSessionId).trace!,
          status: "waiting_for_approval",
          pendingApprovalSummary: {
            approvalId: "approval-rollback",
            reason: "Approve workspace access.",
          },
        },
      }),
    ) as never;
    const transaction = deps.storage.runImmediateTransaction.getMockImplementation()!;
    deps.storage.runImmediateTransaction.mockImplementation(async (callback) => {
      const stepSnapshot = new Map([...steps].map(([key, value]) => [key, { ...value }]));
      const claimSnapshot = new Map([...dispatchClaims].map(([key, value]) => [key, { ...value }]));
      const runSnapshot = new Map([...runs].map(([key, value]) => [key, { ...value }]));
      const taskSnapshot = new Map([...tasks].map(([key, value]) => [key, { ...value }]));
      try {
        return await transaction(callback);
      } catch (error) {
        steps.clear();
        stepSnapshot.forEach((value, key) => steps.set(key, value));
        dispatchClaims.clear();
        claimSnapshot.forEach((value, key) => dispatchClaims.set(key, value));
        runs.clear();
        runSnapshot.forEach((value, key) => runs.set(key, value));
        tasks.clear();
        taskSnapshot.forEach((value, key) => tasks.set(key, value));
        throw error;
      }
    });
    deps.taskLifecycleService.persistDelegationSubagentProjection.mockImplementationOnce(() => {
      throw new Error("projection transaction failed");
    });

    const result = await service.runChatDelegation("sess-1", {
      objective: "Rollback a half-written waiting projection",
      roles: ["researcher"],
    });

    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error: "projection transaction failed",
        childTurnId: undefined,
        output: undefined,
      }),
    );
    expect(deps.taskLifecycleService.publishDelegationSubagentProjection).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" }),
    );
    expect(deps.taskLifecycleService.publishDelegationSubagentProjection).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("rolls back terminal success when its subagent projection crashes and re-enters without duplicate evidence", async () => {
    const { deps, dispatchClaims, runs, service, steps, tasks } = createHarness();
    const transaction = deps.storage.runImmediateTransaction.getMockImplementation()!;
    deps.storage.runImmediateTransaction.mockImplementation(async (callback) => {
      const stepSnapshot = new Map([...steps].map(([key, value]) => [key, { ...value }]));
      const claimSnapshot = new Map([...dispatchClaims].map(([key, value]) => [key, { ...value }]));
      const runSnapshot = new Map([...runs].map(([key, value]) => [key, { ...value }]));
      const taskSnapshot = new Map([...tasks].map(([key, value]) => [key, { ...value }]));
      try {
        return await transaction(callback);
      } catch (error) {
        steps.clear();
        stepSnapshot.forEach((value, key) => steps.set(key, value));
        dispatchClaims.clear();
        claimSnapshot.forEach((value, key) => dispatchClaims.set(key, value));
        runs.clear();
        runSnapshot.forEach((value, key) => runs.set(key, value));
        tasks.clear();
        taskSnapshot.forEach((value, key) => tasks.set(key, value));
        throw error;
      }
    });
    deps.taskLifecycleService.persistDelegationSubagentProjection.mockImplementationOnce(() => {
      throw new Error("terminal projection transaction failed");
    });
    const request = {
      objective: "Commit terminal outcome atomically",
      roles: ["coder"],
      policyRunId: "durable-terminal-projection-crash",
    };

    const failed = await service.runChatDelegation("sess-1", request);
    const replay = await service.runChatDelegation("sess-1", request);

    expect(failed.steps[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error: "terminal projection transaction failed",
        childTurnId: undefined,
        output: undefined,
      }),
    );
    expect(replay).toEqual(expect.objectContaining({ runId: failed.runId, status: "failed" }));
    expect(deps.agentSendChatMessage).toHaveBeenCalledTimes(1);
    expect(deps.taskLifecycleService.appendTaskDeliverable).not.toHaveBeenCalled();
    expect(deps.taskLifecycleService.persistDelegationDeliverable).not.toHaveBeenCalled();
  });

  it("delivers the committed waiting projection in the final stream result without a stale step callback", async () => {
    const { deps, service } = createHarness();
    deps.agentSendChatMessage = vi.fn(async (childSessionId: string) =>
      createChatResponse(childSessionId, {
        assistantMessage: undefined,
        citations: [],
        trace: {
          ...createChatResponse(childSessionId).trace!,
          status: "waiting_for_user_input",
          pendingUserInput: {
            requestId: "input-stream-proof",
            question: "Which workspace should the delegate inspect?",
          },
        },
      }),
    ) as never;

    const chunks = [];
    for await (const chunk of service.runChatDelegationStream("sess-1", {
      objective: "Ask for the missing workspace",
      roles: ["researcher"],
      mode: "sequential",
    })) {
      chunks.push(chunk);
    }

    const stepChunks = chunks.filter((chunk) => chunk.type === "step");
    expect(stepChunks).toHaveLength(1);
    expect(stepChunks[0]?.step).toEqual(expect.objectContaining({ status: "running", output: undefined }));
    const done = chunks.find((chunk) => chunk.type === "done");
    expect(done?.result?.steps[0]).toEqual(
      expect.objectContaining({
        status: "running",
        output: "Which workspace should the delegate inspect?",
      }),
    );
    expect(deps.taskLifecycleService.persistDelegationSubagentProjection).toHaveBeenCalledWith(
      "delegate-session-1",
      expect.objectContaining({
        status: "paused",
        metadata: expect.objectContaining({
          waiting: {
            status: "waiting_for_user_input",
            reason: "Which workspace should the delegate inspect?",
            childTurnId: "turn-delegate-session-1",
            durableRunId: "durable-delegate-session-1",
            observedAt: expect.any(String),
          },
        }),
      }),
    );
    expect(deps.taskLifecycleService.publishDelegationSubagentProjection).toHaveBeenCalledTimes(1);
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
    expect(deps.taskLifecycleService.persistDelegationSubagentProjection).toHaveBeenCalledWith(
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
    expect(deps.taskLifecycleService.persistDelegationSubagentProjection).toHaveBeenCalledWith(
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
