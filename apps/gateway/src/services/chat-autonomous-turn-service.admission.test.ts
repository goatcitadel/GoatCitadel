import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@goatcitadel/contracts";
import type { CronJobRecord, DurableRunRecord } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import {
  buildCronChatAdmissionIdentity,
  buildCronInboxTaskId,
  enqueueAutonomousChatTurn,
  runCronAgentTurn,
  type ChatAutonomousTurnDeps,
  type CronChatAdmissionIdentity,
} from "./chat-autonomous-turn-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import { DurableRunService } from "./durable-run-service.js";
import type { ServiceContext } from "./service-context.js";

type DurableCreateInput = Parameters<ChatAutonomousTurnDeps["createDurableRun"]>[0];
type PrepareOptions = Parameters<ChatAutonomousTurnDeps["prepareAgentChatTurn"]>[2];

const CRON_TOKEN = {
  runId: "cron-run-canonical-001",
  jobId: "weekly-review",
  executionGeneration: 7,
} as const;

function buildPrepared(sessionId: string, content: string, options: PrepareOptions): PreparedAgentChatTurn {
  return {
    session: { sessionId },
    content,
    userEventId: options.userMessageId ?? "random-user-message",
    userMessage: {
      messageId: options.userMessageId ?? "random-user-message",
      sessionId,
      role: "user",
      actorType: "user",
      actorId: "operator",
      content,
      timestamp: "2026-07-13T00:00:00.000Z",
    },
    turnId: options.turnId ?? "random-turn",
    assistantMessageId: options.assistantMessageId ?? "random-assistant-message",
    branchKind: "append",
    effectiveMode: "chat",
    prefs: {
      mode: "chat",
      providerId: "test-provider",
      model: "test-model",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      speedMode: "balanced",
      subagentPolicy: "auto",
      toolAutonomy: "manual",
    },
    normalized: {},
    modelRouterDecision: {},
    effectiveToolAutonomy: "manual",
  } as PreparedAgentChatTurn;
}

function buildDurableRecord(input: DurableCreateInput): DurableRunRecord {
  return {
    runId: input.runId ?? "random-durable-run",
    workflowKey: input.workflowKey,
    status: "queued",
    attemptCount: 0,
    maxAttempts: 3,
    version: 1,
    payload: input.payload,
    metadata: input.metadata,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

function buildDeps(overrides: Partial<ChatAutonomousTurnDeps> = {}) {
  const prepareAgentChatTurn = vi.fn(
    async (_sessionId: string, request: { content: string }, options: PrepareOptions) =>
      buildPrepared(_sessionId, request.content, options),
  );
  const createDurableRun = vi.fn((input: DurableCreateInput) => buildDurableRecord(input));
  const persistChatStreamChunk = vi.fn();
  const requestDurableRunProcessing = vi.fn();
  const deps = {
    storage: {
      chatTurnTraces: {
        get: vi.fn((turnId: string) => {
          throw new NotFoundError({ entity: "Chat turn trace", id: turnId });
        }),
        create: vi.fn(),
      },
      chatSessionMeta: {
        get: vi.fn(() => ({ workspaceId: "default" })),
      },
    },
    cron: {},
    isFeatureEnabled: vi.fn((flag: string) => flag === "durableKernelV1Enabled"),
    createCronInboxTask: vi.fn(() => ({ taskId: "inbox-task" })),
    getSessionAutonomyPrefs: vi.fn(),
    patchSessionAutonomyPrefs: vi.fn(),
    listChatSessions: vi.fn(() => []),
    getSessionIdleSeconds: vi.fn(),
    hasRunningTurn: vi.fn(() => false),
    isReplayScratchSession: vi.fn(() => false),
    getSession: vi.fn((sessionId: string) => ({ sessionId })),
    normalizeWorkspaceId: vi.fn(() => "default"),
    ensureChatSessionRuntimeGrants: vi.fn(),
    listConnectorRecords: vi.fn(() => []),
    listToolCatalog: vi.fn(() => []),
    registerSyntheticPermissionProfile: vi.fn(),
    prepareAgentChatTurn,
    buildDurableChatTurnPayloadRecord: vi.fn((prepared: PreparedAgentChatTurn, request: { content: string }) => ({
      version: "chat.turn.execute.v1",
      sessionId: prepared.session.sessionId,
      turnId: prepared.turnId,
      userMessageId: prepared.userEventId,
      assistantMessageId: prepared.assistantMessageId,
      branchKind: prepared.branchKind,
      threadEventType: "chat_thread_turn_appended",
      request: { content: request.content },
    })),
    createDurableRun,
    persistChatStreamChunk,
    requestDurableRunProcessing,
    ...overrides,
  } as unknown as ChatAutonomousTurnDeps;
  return {
    deps,
    prepareAgentChatTurn,
    createDurableRun,
    persistChatStreamChunk,
    requestDurableRunProcessing,
  };
}

function deterministicInput(admissionIdentity: CronChatAdmissionIdentity) {
  return {
    sessionId: "session-cron",
    prompt: "Review the external repositories.",
    runId: admissionIdentity.cronRunId,
    systemActorId: "system-cron",
    reason: `cron agent_turn:${admissionIdentity.jobId}`,
    deliverMode: "always" as const,
    admissionIdentity,
  };
}

describe("deterministic autonomous Chat child admission", () => {
  it("derives byte-stable, domain-specific child ids from the canonical cron run id", () => {
    const first = buildCronChatAdmissionIdentity(CRON_TOKEN);
    const replay = buildCronChatAdmissionIdentity({ ...CRON_TOKEN });
    const otherRun = buildCronChatAdmissionIdentity({ ...CRON_TOKEN, runId: "cron-run-canonical-002" });

    expect(replay).toEqual(first);
    expect(new Set([first.userMessageId, first.turnId, first.assistantMessageId, first.durableRunId])).toHaveLength(4);
    expect(otherRun.userMessageId).not.toBe(first.userMessageId);
    expect(first).toMatchObject({
      version: "cron.chat.admission.v1",
      cronRunId: CRON_TOKEN.runId,
      jobId: CRON_TOKEN.jobId,
      executionGeneration: CRON_TOKEN.executionGeneration,
    });
  });

  it("threads the canonical cron owner through stable prep, immutable payload, metadata, and outcome linkage", async () => {
    const { deps, prepareAgentChatTurn, createDurableRun } = buildDeps();
    const job = {
      jobId: CRON_TOKEN.jobId,
      name: "Weekly review",
      action: "agent_turn",
      schedule: "0 9 * * 1",
      enabled: true,
    } as CronJobRecord;

    const outcome = await runCronAgentTurn(deps, {
      job,
      runId: CRON_TOKEN.runId,
      config: {
        prompt: "Review the external repositories.",
        sessionId: "session-cron",
        deliverMode: "always",
      },
      cronRun: CRON_TOKEN,
    });
    const identity = buildCronChatAdmissionIdentity(CRON_TOKEN);

    expect(outcome).toMatchObject({
      mode: "agent_turn",
      durableRunId: identity.durableRunId,
      sessionId: "session-cron",
      turnId: identity.turnId,
      userMessageId: identity.userMessageId,
      assistantMessageId: identity.assistantMessageId,
      admissionIdentity: identity,
    });
    expect(prepareAgentChatTurn).toHaveBeenCalledWith(
      "session-cron",
      expect.objectContaining({ content: "Review the external repositories." }),
      {
        ingestUserMessage: false,
        userMessageId: identity.userMessageId,
        turnId: identity.turnId,
        assistantMessageId: identity.assistantMessageId,
      },
    );
    expect(createDurableRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: identity.durableRunId,
        workflowKey: "chat.turn.execute",
        payload: expect.objectContaining({ cronAdmission: identity }),
        metadata: expect.objectContaining({
          cronRunId: CRON_TOKEN.runId,
          cronJobId: CRON_TOKEN.jobId,
          cronExecutionGeneration: CRON_TOKEN.executionGeneration,
          cronAdmission: identity,
        }),
      }),
    );
  });

  it("re-enters the same child after a crash between deterministic message prep and durable creation", async () => {
    const identity = buildCronChatAdmissionIdentity(CRON_TOKEN);
    const { deps, prepareAgentChatTurn, createDurableRun, requestDurableRunProcessing } = buildDeps();
    createDurableRun
      .mockImplementationOnce(() => {
        throw new Error("simulated crash after user-message persistence");
      })
      .mockImplementationOnce((input) => buildDurableRecord(input));

    await expect(enqueueAutonomousChatTurn(deps, deterministicInput(identity))).rejects.toThrow(
      "simulated crash after user-message persistence",
    );
    const replay = await enqueueAutonomousChatTurn(deps, deterministicInput(identity));

    expect(replay).toMatchObject({
      runId: identity.durableRunId,
      turnId: identity.turnId,
      userMessageId: identity.userMessageId,
      assistantMessageId: identity.assistantMessageId,
    });
    expect(prepareAgentChatTurn).toHaveBeenCalledTimes(2);
    expect(prepareAgentChatTurn.mock.calls[0]?.[2]).toEqual(prepareAgentChatTurn.mock.calls[1]?.[2]);
    expect(createDurableRun.mock.calls[0]?.[0]).toEqual(createDurableRun.mock.calls[1]?.[0]);
    expect(requestDurableRunProcessing).toHaveBeenCalledOnce();
    expect(requestDurableRunProcessing).toHaveBeenCalledWith(identity.durableRunId);
  });

  it("adopts an existing deterministic child only when its immutable payload and audit owner match", async () => {
    const identity = buildCronChatAdmissionIdentity(CRON_TOKEN);
    const { deps, createDurableRun } = buildDeps();
    let canonicalRun: DurableRunRecord | undefined;
    createDurableRun.mockImplementation((input) => {
      canonicalRun ??= buildDurableRecord(input);
      return canonicalRun;
    });

    const first = await enqueueAutonomousChatTurn(deps, deterministicInput(identity));
    const replay = await enqueueAutonomousChatTurn(deps, deterministicInput(identity));

    expect(first).toEqual(replay);
    expect(createDurableRun).toHaveBeenCalledTimes(2);
    expect(canonicalRun?.runId).toBe(identity.durableRunId);
  });

  it("reuses the admitted trace parent after the session leaf advances", async () => {
    const identity = buildCronChatAdmissionIdentity(CRON_TOKEN);
    const trace = {
      turnId: identity.turnId,
      sessionId: "session-cron",
      userMessageId: identity.userMessageId,
      assistantMessageId: identity.assistantMessageId,
      parentTurnId: "turn-parent-at-admission",
      branchKind: "append",
      status: "running",
      routing: {},
      durable: { runId: identity.durableRunId, status: "queued" },
    };
    const { deps, prepareAgentChatTurn } = buildDeps({
      storage: {
        chatTurnTraces: {
          get: vi.fn(() => trace),
          create: vi.fn(),
        },
      } as unknown as ChatAutonomousTurnDeps["storage"],
    });

    await enqueueAutonomousChatTurn(deps, deterministicInput(identity));

    expect(prepareAgentChatTurn.mock.calls[0]?.[2]).toEqual({
      ingestUserMessage: false,
      userMessageId: identity.userMessageId,
      turnId: identity.turnId,
      assistantMessageId: identity.assistantMessageId,
      parentTurnId: "turn-parent-at-admission",
    });
  });

  it("refuses a pre-existing deterministic trace without the exact durable owner linkage", async () => {
    const identity = buildCronChatAdmissionIdentity(CRON_TOKEN);
    const { deps, prepareAgentChatTurn, createDurableRun } = buildDeps({
      storage: {
        chatTurnTraces: {
          get: vi.fn(() => ({
            turnId: identity.turnId,
            sessionId: "session-cron",
            userMessageId: identity.userMessageId,
            assistantMessageId: identity.assistantMessageId,
            branchKind: "append",
            status: "running",
            durable: { runId: "other-durable-owner", status: "queued" },
          })),
          create: vi.fn(),
        },
      } as unknown as ChatAutonomousTurnDeps["storage"],
    });

    await expect(enqueueAutonomousChatTurn(deps, deterministicInput(identity))).rejects.toThrow(
      /trace .* conflicting admission/,
    );
    expect(prepareAgentChatTurn).not.toHaveBeenCalled();
    expect(createDurableRun).not.toHaveBeenCalled();
  });

  it("converges retries on one real durable owner and refuses a conflicting immutable payload", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-cron-chat-admission-"));
    const storage = new Storage({
      dbPath: path.join(root, "gateway.db"),
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    try {
      const durableRunService = new DurableRunService({
        storage,
        requireFeatureEnabled: vi.fn(),
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext);
      const createDurableRun = vi.fn((input: DurableCreateInput) =>
        durableRunService.createDurableRun(input, { publishRealtime: false }),
      );
      const base = buildDeps({
        storage: {
          chatTurnTraces: storage.chatTurnTraces,
        } as ChatAutonomousTurnDeps["storage"],
        createDurableRun,
      });
      const identity = buildCronChatAdmissionIdentity(CRON_TOKEN);

      const first = await enqueueAutonomousChatTurn(base.deps, deterministicInput(identity));
      const replay = await enqueueAutonomousChatTurn(base.deps, deterministicInput(identity));

      expect(replay).toEqual(first);
      expect(storage.durableRuns.listRuns(20).filter((run) => run.runId === identity.durableRunId)).toHaveLength(1);
      expect(storage.durableRuns.listCheckpoints(identity.durableRunId)).toHaveLength(1);
      expect(() =>
        durableRunService.createDurableRun(
          {
            ...createDurableRun.mock.calls[0]![0],
            payload: {
              ...createDurableRun.mock.calls[0]![0].payload,
              request: { content: "conflicting retry payload" },
            },
          },
          { publishRealtime: false },
        ),
      ).toThrow(/different immutable workflow payload/);
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed before trace, stream, or processing when a stable durable id has conflicting ownership", async () => {
    const identity = buildCronChatAdmissionIdentity(CRON_TOKEN);
    const { deps, createDurableRun, persistChatStreamChunk, requestDurableRunProcessing } = buildDeps();
    createDurableRun.mockImplementation((input) => ({
      ...buildDurableRecord(input),
      metadata: {
        ...input.metadata,
        cronExecutionGeneration: identity.executionGeneration + 1,
      },
    }));

    await expect(enqueueAutonomousChatTurn(deps, deterministicInput(identity))).rejects.toThrow(
      /owned by a conflicting admission/,
    );
    expect(persistChatStreamChunk).not.toHaveBeenCalled();
    expect(requestDurableRunProcessing).not.toHaveBeenCalled();
  });

  it("fails closed when prep returns ids outside the canonical admission", async () => {
    const identity = buildCronChatAdmissionIdentity(CRON_TOKEN);
    const prepareAgentChatTurn = vi.fn(async () =>
      buildPrepared("session-cron", "Review the external repositories.", {
        ingestUserMessage: false,
        userMessageId: identity.userMessageId,
        turnId: "conflicting-turn",
        assistantMessageId: identity.assistantMessageId,
      }),
    );
    const { deps, createDurableRun } = buildDeps({ prepareAgentChatTurn });

    await expect(enqueueAutonomousChatTurn(deps, deterministicInput(identity))).rejects.toThrow(
      /does not match admission identity/,
    );
    expect(createDurableRun).not.toHaveBeenCalled();
  });

  it("rejects a cron-run token that does not own the invoked job/run pair", async () => {
    const { deps, prepareAgentChatTurn } = buildDeps();
    const job = {
      jobId: CRON_TOKEN.jobId,
      name: "Weekly review",
      action: "agent_turn",
      schedule: "0 9 * * 1",
      enabled: true,
    } as CronJobRecord;

    await expect(
      runCronAgentTurn(deps, {
        job,
        runId: CRON_TOKEN.runId,
        config: { prompt: "Review", sessionId: "session-cron" },
        cronRun: { ...CRON_TOKEN, jobId: "other-job" },
      }),
    ).rejects.toThrow(/owner mismatch/);
    expect(prepareAgentChatTurn).not.toHaveBeenCalled();
  });

  it("reuses one deterministic inbox task identity when a fallback is replayed", async () => {
    const createCronInboxTask = vi.fn((_job: CronJobRecord, options?: { taskId?: string }) => ({
      taskId: options?.taskId ?? "random-inbox-task",
    }));
    const { deps, createDurableRun } = buildDeps({ createCronInboxTask });
    const job = {
      jobId: CRON_TOKEN.jobId,
      name: "Weekly review",
      action: "agent_turn",
      schedule: "0 9 * * 1",
      enabled: true,
    } as CronJobRecord;

    const first = await runCronAgentTurn(deps, {
      job,
      runId: CRON_TOKEN.runId,
      config: { prompt: "Review", inertInboxFallback: true },
      cronRun: CRON_TOKEN,
    });
    const replay = await runCronAgentTurn(deps, {
      job,
      runId: CRON_TOKEN.runId,
      config: { prompt: "Review", inertInboxFallback: true },
      cronRun: CRON_TOKEN,
    });

    const taskId = buildCronInboxTaskId(CRON_TOKEN);
    expect(first).toEqual({ mode: "inbox", taskId });
    expect(replay).toEqual(first);
    expect(createCronInboxTask).toHaveBeenNthCalledWith(1, job, { taskId });
    expect(createCronInboxTask).toHaveBeenNthCalledWith(2, job, { taskId });
    expect(createDurableRun).not.toHaveBeenCalled();
  });

  it("preserves the legacy heartbeat/proactive path when no cron admission identity is supplied", async () => {
    const { deps, prepareAgentChatTurn, createDurableRun } = buildDeps();

    const result = await enqueueAutonomousChatTurn(deps, {
      sessionId: "session-heartbeat",
      prompt: "HEARTBEAT",
      runId: "heartbeat-random",
      systemActorId: "system-heartbeat",
      reason: "heartbeat self-wake:session-heartbeat",
      kind: "heartbeat",
      deliverMode: "on_notify",
    });

    expect(result).toMatchObject({
      runId: "random-durable-run",
      turnId: "random-turn",
      userMessageId: "random-user-message",
      assistantMessageId: "random-assistant-message",
    });
    expect(prepareAgentChatTurn.mock.calls[0]?.[2]).toEqual({ ingestUserMessage: true });
    expect(createDurableRun.mock.calls[0]?.[0]).not.toHaveProperty("runId");
    expect(createDurableRun.mock.calls[0]?.[0].payload).not.toHaveProperty("cronAdmission");
    expect(createDurableRun.mock.calls[0]?.[0].metadata).not.toHaveProperty("cronAdmission");
  });
});
