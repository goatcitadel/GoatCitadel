import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonString, NotFoundError } from "@goatcitadel/contracts";
import type { CronJobRecord, DurableRunRecord } from "@goatcitadel/contracts";
import { sealChatTurnCapabilityProfile, Storage, type SessionAutonomyPrefsRecord } from "@goatcitadel/storage";
import {
  buildCronChatAdmissionIdentity,
  buildCronInboxTaskId,
  enqueueAutonomousChatTurn,
  runCronAgentTurn,
  runHeartbeatSweep,
  type ChatAutonomousTurnDeps,
  type CronChatAdmissionIdentity,
} from "./chat-autonomous-turn-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import { DurableRunService } from "./durable-run-service.js";
import type { ServiceContext } from "./service-context.js";
import {
  finalizeDurableChatRun,
  GENERAL_CHAT_POST_COMMIT_EFFECTS,
  type GeneralChatPostCommitProgress,
} from "./chat-durable-run-service.js";
import {
  CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY,
  buildChatTurnRuntimeAuthoritySeal,
  withChatTurnRuntimeAuthority,
  withChatTurnRuntimeAuthorityCheckpoint,
} from "./chat-durable-runtime-authority.js";
import { buildAutonomousTurnContext, SCHEDULED_TURN_PERMISSION_PROFILE_ID } from "./gateway/autonomous-turn-policy.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
  freezeChatTurnExecutionRequest,
} from "./session-control-service.js";
import {
  cancelExpiredUnboundChatTurnAdmissionsOnBoot,
  SessionControlRuntimeOwner,
} from "./session-control-runtime-owner.js";
import { SessionControlService } from "./session-control-service.js";

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
    turnAdmission: options.turnAdmission,
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
  const durableRecords = new Map<string, DurableRunRecord>();
  const admissionRecords = new Map<string, Record<string, unknown>>();
  const durableBindings = new Set<string>();
  const traces = new Map<string, Record<string, unknown>>();
  const prepareAgentChatTurn = vi.fn(
    async (_sessionId: string, request: { content: string }, options: PrepareOptions) =>
      buildPrepared(_sessionId, request.content, options),
  );
  const createDurableRun = vi.fn((input: DurableCreateInput) => {
    const run = buildDurableRecord(input);
    durableRecords.set(run.runId, run);
    return run;
  });
  const persistChatStreamChunk = vi.fn();
  const requestDurableRunProcessing = vi.fn();
  const admitSystemChatTurn = vi.fn((input) => {
    const admittedRequest = freezeChatTurnExecutionRequest(input.request);
    const admissionId = `admission:${input.turnId}`;
    const existing = admissionRecords.get(admissionId);
    if (existing?.status !== undefined && existing.status !== "active") {
      throw new Error(`The Chat turn occurrence is already terminal (${String(existing.status)}).`);
    }
    const admission = {
      identity: {
        admissionId,
        sessionIncarnationId: `incarnation:${input.sessionId}`,
        workspaceId: "default",
        sessionId: input.sessionId,
        turnId: input.turnId,
        aggregateRevision: 1,
        controllerGeneration: 1,
        materialSha256: computeFrozenChatTurnAdmissionMaterialSha256(admittedRequest),
      },
      admittedRequest,
      requestActor: { actorKind: "system", actorId: input.systemActorId },
      requestClaim: { runtimeOwnerId: `runtime:${input.turnId}`, leaseRevision: 1 },
    };
    admissionRecords.set(admission.identity.admissionId, {
      ...admission.identity,
      actorKind: "system",
      actorId: input.systemActorId,
      admissionKind: "turn_write",
      status: "active",
      runtimeOwnerId: admission.requestClaim.runtimeOwnerId,
      runtimeLeaseRevision: admission.requestClaim.leaseRevision,
    });
    return admission;
  });
  const startRequestLeaseHeartbeat = vi.fn(() => ({ stop: vi.fn(), assertHealthy: vi.fn() }));
  const assertActiveTurnWrite = vi.fn();
  const bindDurableRun = vi.fn((admission) => {
    durableBindings.add(`${admission.identity.admissionId}:${admission.identity.turnId}`);
    admission.requestClaim = undefined;
  });
  const closeTurnWrite = vi.fn(({ admission }) => {
    admission.requestClaim = undefined;
    const stored = admissionRecords.get(admission.identity.admissionId);
    if (stored) stored.status = "cancelled";
  });
  const baseStorage = {
    chatTurnTraces: {
      get: vi.fn((turnId: string) => {
        const trace = traces.get(turnId);
        if (trace) return trace;
        throw new NotFoundError({ entity: "Chat turn trace", id: turnId });
      }),
      create: vi.fn((trace) => {
        traces.set(trace.turnId, trace);
        return trace;
      }),
    },
    chatSessionMeta: {
      get: vi.fn(() => ({ workspaceId: "default" })),
    },
    sessionMutationAdmissions: {
      require: vi.fn((admissionId: string) => admissionRecords.get(admissionId)),
      bindDurableRun: vi.fn((input) => {
        const key = `${input.admissionId}:${input.turnId}`;
        if (!durableBindings.has(key)) throw new Error("missing durable binding");
        return { disposition: "replayed", binding: input };
      }),
    },
  };
  const deps = {
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
    buildDurableChatTurnPayloadRecord: vi.fn(
      (prepared: PreparedAgentChatTurn, request: { content: string }, durableRunId: string) => {
        const admission = prepared.turnAdmission!;
        const frozenRequest = freezeChatTurnExecutionRequest(request);
        return {
          version: "chat.turn.execute.v2",
          admissionId: admission.identity.admissionId,
          sessionIncarnationId: admission.identity.sessionIncarnationId,
          admissionMaterialSha256: admission.identity.materialSha256,
          workspaceId: admission.identity.workspaceId,
          admissionAggregateRevision: admission.identity.aggregateRevision,
          admissionControllerGeneration: admission.identity.controllerGeneration,
          effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(
            admission.identity.materialSha256,
            frozenRequest,
          ),
          policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: durableRunId },
          requestActor: admission.requestActor,
          sessionId: prepared.session.sessionId,
          turnId: prepared.turnId,
          userMessageId: prepared.userEventId,
          assistantMessageId: prepared.assistantMessageId,
          branchKind: prepared.branchKind,
          threadEventType: "chat_thread_turn_appended",
          request: frozenRequest,
        };
      },
    ),
    createDurableRun,
    getDurableRun: vi.fn((runId: string) => {
      const run = durableRecords.get(runId);
      if (!run) throw new NotFoundError({ entity: "Durable run", id: runId });
      return run;
    }),
    persistChatStreamChunk,
    requestDurableRunProcessing,
    onDurableRunCommitted: vi.fn((run: DurableRunRecord) => {
      durableRecords.set(run.runId, run);
    }),
    ...overrides,
    storage: { ...baseStorage, ...(overrides.storage ?? {}) },
    sessionControlRuntimeOwner: overrides.sessionControlRuntimeOwner ?? {
      admitSystemChatTurn,
      startRequestLeaseHeartbeat,
      assertActiveTurnWrite,
      bindDurableRun,
      closeTurnWrite,
    },
  } as unknown as ChatAutonomousTurnDeps;
  return {
    deps,
    prepareAgentChatTurn,
    createDurableRun,
    persistChatStreamChunk,
    requestDurableRunProcessing,
    admitSystemChatTurn,
    startRequestLeaseHeartbeat,
    assertActiveTurnWrite,
    bindDurableRun,
    closeTurnWrite,
    admissionRecords,
    durableRecords,
    traces,
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

function createRealAutonomousReplayHarness(token: typeof CRON_TOKEN) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-autonomous-replay-"));
  const storage = new Storage({
    dbPath: path.join(root, "gateway.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  const identity = buildCronChatAdmissionIdentity(token);
  const input = deterministicInput(identity);
  storage.chatSessionLifecycles.initialize({
    workspaceId: "default",
    sessionId: input.sessionId,
    actorId: "operator:test",
    idempotencyKey: `lifecycle:init:${input.sessionId}`,
    correlationId: `lifecycle:init:${input.sessionId}`,
  });
  const owner = new SessionControlRuntimeOwner(new SessionControlService(storage));
  const publishRealtime = vi.fn();
  const service = new DurableRunService(
    {
      storage,
      config: {
        assistant: { durable: { enabled: true, workflowTimeoutMs: 30_000 }, mesh: { nodeId: "test-node" } },
      },
      publishRealtime,
      requireFeatureEnabled: vi.fn(),
      isFeatureEnabled: vi.fn((flag: string) => flag === "durableKernelV1Enabled"),
    } as unknown as ServiceContext,
    {
      backgroundTasks: new Set(),
      workflowRegistry: {
        executeWorkflow: vi.fn(async () => undefined),
        isWorkflowRecoverable: vi.fn(() => ({ recoverable: true })),
        markWorkflowUnrecoverable: vi.fn(async () => undefined),
      },
      onAutonomousChatPostCommit: vi.fn(async () => ({ disposition: "settled" })),
      onGeneralChatPostCommit: vi.fn(async (_run: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
        for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
          if (!progress.completedEffects.includes(effect)) {
            progress.runEffect(effect, () => undefined);
          }
        }
        return undefined;
      }),
    },
  );
  let prepared: PreparedAgentChatTurn | undefined;
  const prepareAgentChatTurn = vi.fn(
    async (_sessionId: string, request: { content: string }, options: PrepareOptions) => {
      const emptyCatalogHash = createHash("sha256").update(canonicalJsonString([])).digest("hex");
      const capabilityProfile = sealChatTurnCapabilityProfile({
        profileId: `chat-capability-profile-${options.turnId}`,
        schemaVersion: "chat.turn.capability-profile.v1",
        identity: {
          turnId: options.turnId!,
          sessionId: _sessionId,
          workspaceId: "default",
          citadelId: "default",
          operatorId: input.systemActorId,
          authActorId: input.systemActorId,
          authActorSource: "none",
        },
        source: { channel: "chat", account: "default" },
        catalog: {
          snapshotId: `snapshot-${options.turnId}`,
          inspectableHash: emptyCatalogHash,
          callableHash: emptyCatalogHash,
          inspectableCount: 0,
          callableCount: 0,
        },
        selection: {
          contentHash: createHash("sha256").update(request.content).digest("hex"),
          effectiveProviderId: "provider-test",
          effectiveModel: "model-test",
          allowedFallbacks: [],
          mode: "chat",
          webMode: "off",
          memory: {
            mode: "off",
            retrievalMode: "standard",
            workspaceId: "default",
            sessionId: _sessionId,
            contextManifestRef: `chat-memory-scope:${"d".repeat(64)}`,
            writeApprovalRequired: true,
          },
          thinkingLevel: "standard",
          speedMode: "standard",
          subagentPolicy: "auto_when_useful",
          toolAutonomy: "manual",
          tools: [],
          modelNameAllowMap: [],
          trustedSkills: [],
        },
        governance: {
          activeGrants: [],
          permission: {
            profileId: SCHEDULED_TURN_PERMISSION_PROFILE_ID,
            approvalMode: "approve_all",
            profileHash: "e".repeat(64),
          },
          policyDecisions: [],
          authReadiness: [
            { kind: "provider", ref: "provider-test", status: "ready", reasonCodes: [] },
            { kind: "channel", ref: "chat", status: "ready", reasonCodes: [] },
          ],
          approval: {
            mode: "approve_all",
            selectedToolCount: 0,
            toolsRequiringApproval: [],
            approvalGranted: false,
          },
        },
        preflightFingerprint: "f".repeat(64),
        createdAt: "2026-07-15T00:00:00.000Z",
      });
      prepared = {
        ...buildPrepared(_sessionId, request.content, options),
        workspaceId: "default",
        capabilityProfile,
        capabilityCatalogSnapshot: {
          snapshotId: capabilityProfile.catalog.snapshotId,
          inspectableEntries: [],
          callableEntries: [],
          createdAt: capabilityProfile.createdAt,
        },
      } as PreparedAgentChatTurn;
      return prepared;
    },
  );
  const deps = {
    ...buildDeps().deps,
    storage,
    sessionControlRuntimeOwner: owner,
    prepareAgentChatTurn,
    buildDurableChatTurnPayloadRecord: (
      preparedTurn: PreparedAgentChatTurn,
      request: { content: string },
      durableRunId: string,
    ) => {
      const admission = preparedTurn.turnAdmission!;
      const frozenRequest = freezeChatTurnExecutionRequest(request);
      return {
        version: "chat.turn.execute.v2",
        admissionId: admission.identity.admissionId,
        sessionIncarnationId: admission.identity.sessionIncarnationId,
        admissionMaterialSha256: admission.identity.materialSha256,
        workspaceId: admission.identity.workspaceId,
        admissionAggregateRevision: admission.identity.aggregateRevision,
        admissionControllerGeneration: admission.identity.controllerGeneration,
        effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(
          admission.identity.materialSha256,
          frozenRequest,
        ),
        policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: durableRunId },
        requestActor: admission.requestActor,
        sessionId: preparedTurn.session.sessionId,
        turnId: preparedTurn.turnId,
        userMessageId: preparedTurn.userEventId,
        assistantMessageId: preparedTurn.assistantMessageId,
        capabilityProfileId: preparedTurn.capabilityProfile!.profileId,
        capabilityProfileHash: preparedTurn.capabilityProfile!.hashes.profileHash,
        branchKind: preparedTurn.branchKind,
        threadEventType: "chat_thread_turn_appended",
        request: frozenRequest,
      };
    },
    createDurableRun: (create: DurableCreateInput) => service.createDurableRun(create, { publishRealtime: false }),
    getDurableRun: (runId: string) => service.getDurableRun(runId),
    persistChatStreamChunk: vi.fn(),
    onDurableRunCommitted: vi.fn(),
    requestDurableRunProcessing: vi.fn(),
  } as unknown as ChatAutonomousTurnDeps;
  return {
    root,
    storage,
    service,
    identity,
    input,
    deps,
    requestDurableRunProcessing: deps.requestDurableRunProcessing as ReturnType<typeof vi.fn>,
    publishRealtime,
    getPrepared: () => {
      if (!prepared) throw new Error("Autonomous replay fixture was not prepared.");
      return prepared;
    },
  };
}

function claimRealAutonomousRun(storage: Storage, runId: string): DurableRunRecord {
  const now = new Date().toISOString();
  const claimed = storage.durableRuns.tryClaimQueuedRun({
    runId,
    workerId: `worker-${runId}`,
    leaseHeartbeatAt: now,
    leaseExpiresAt: new Date(Date.parse(now) + 120_000).toISOString(),
    updatedAt: now,
  });
  if (!claimed) throw new Error(`Autonomous replay fixture ${runId} was not claimable.`);
  return claimed;
}

function finalizeRealAutonomousRun(
  harness: ReturnType<typeof createRealAutonomousReplayHarness>,
  status: "waiting_for_approval" | "completed" | "partial" | "failed" | "cancelled",
): void {
  const claimed = claimRealAutonomousRun(harness.storage, harness.identity.durableRunId);
  if (status === "completed" || status === "partial") {
    harness.storage.chatMessages.upsert({
      messageId: harness.identity.assistantMessageId,
      sessionId: harness.input.sessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: "Canonical autonomous completion.",
      timestamp: new Date().toISOString(),
    });
  }
  harness.storage.chatTurnTraces.patch(harness.identity.turnId, {
    status,
    ...(status === "waiting_for_approval" || status === "failed"
      ? {
          failure: {
            failureClass: status === "waiting_for_approval" ? "approval_required" : "provider_timeout",
            message: status === "waiting_for_approval" ? "Waiting for approval" : "Provider failed",
            retryable: status === "waiting_for_approval",
            recommendedAction: status === "waiting_for_approval" ? "approve_pending_step" : "retry_turn",
          },
        }
      : {}),
  });
  const trace = harness.storage.chatTurnTraces.get(harness.identity.turnId);
  finalizeDurableChatRun(
    {
      runImmediateTransaction: (callback) => harness.storage.runImmediateTransaction(callback),
      durableRuns: harness.storage.durableRuns,
      chatToolRuns: harness.storage.chatToolRuns,
      chatToolArtifacts: harness.storage.chatToolArtifacts,
      chatMessages: harness.storage.chatMessages,
      recordDurableTimelineEvent: vi.fn(),
      chatTurnTraces: harness.storage.chatTurnTraces,
      resolvePostCommitEligibility: () => ({
        version: 1,
        autonomyEnabledAtParentSettlement: true,
        evalIntegrityTurn: false,
        humanSession: true,
      }),
    },
    harness.identity.durableRunId,
    harness.getPrepared(),
    trace,
    claimed.leaseOwnerId,
  );
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
    const { deps, prepareAgentChatTurn, createDurableRun, admitSystemChatTurn, bindDurableRun } = buildDeps();
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
      expect.objectContaining({
        ingestUserMessage: false,
        userMessageId: identity.userMessageId,
        turnId: identity.turnId,
        assistantMessageId: identity.assistantMessageId,
        turnAdmission: expect.objectContaining({
          requestActor: { actorKind: "system", actorId: "system:cron:weekly-review" },
        }),
      }),
    );
    expect(admitSystemChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        systemActorId: "system:cron:weekly-review",
        turnId: identity.turnId,
      }),
    );
    expect(bindDurableRun).toHaveBeenCalledWith(expect.any(Object), identity.durableRunId);
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

  it("terminalizes a caught pre-bind failure and never redispatches the same occurrence", async () => {
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
    await expect(enqueueAutonomousChatTurn(deps, deterministicInput(identity))).rejects.toThrow(/already terminal/);
    expect(prepareAgentChatTurn).toHaveBeenCalledOnce();
    expect(createDurableRun).toHaveBeenCalledOnce();
    expect(requestDurableRunProcessing).not.toHaveBeenCalled();
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
    expect(createDurableRun).toHaveBeenCalledTimes(1);
    expect(canonicalRun?.runId).toBe(identity.durableRunId);
  });

  it("quarantines a terminal replay that lacks checkpoint-anchored runtime authority", async () => {
    const identity = buildCronChatAdmissionIdentity(CRON_TOKEN);
    const harness = buildDeps();
    await enqueueAutonomousChatTurn(harness.deps, deterministicInput(identity));
    const admission = harness.admissionRecords.get(`admission:${identity.turnId}`)!;
    const run = harness.durableRecords.get(identity.durableRunId)!;
    const trace = harness.traces.get(identity.turnId)!;
    admission.status = "completed";
    admission.terminalAuthorityKind = "durable_terminal";
    admission.terminalDurableRunId = identity.durableRunId;
    admission.terminalDurableRunStatus = "completed";
    run.status = "completed";
    trace.status = "completed";
    (trace.durable as Record<string, unknown>).status = "completed";

    await expect(enqueueAutonomousChatTurn(harness.deps, deterministicInput(identity))).rejects.toThrow(
      /checkpoint-anchored runtime authority/,
    );
    expect(harness.createDurableRun).toHaveBeenCalledOnce();
    expect(harness.requestDurableRunProcessing).toHaveBeenCalledOnce();
  });

  it("quarantines a legacy deterministic child without a v2 mutation admission", async () => {
    const identity = buildCronChatAdmissionIdentity({
      ...CRON_TOKEN,
      runId: "cron-run-legacy-unadmitted",
      executionGeneration: 17,
    });
    const harness = buildDeps();
    await enqueueAutonomousChatTurn(harness.deps, deterministicInput(identity));
    const run = harness.durableRecords.get(identity.durableRunId)!;
    run.payload = {
      version: "chat.turn.execute.v1",
      sessionId: "session-cron",
      turnId: identity.turnId,
      userMessageId: identity.userMessageId,
      assistantMessageId: identity.assistantMessageId,
      request: { content: "Review the external repositories." },
    };
    harness.admissionRecords.delete(`admission:${identity.turnId}`);

    await expect(enqueueAutonomousChatTurn(harness.deps, deterministicInput(identity))).rejects.toThrow(
      /admissionId must be a non-empty string|conflicting v2 admission lineage|no mutation admission/,
    );
    expect(harness.createDurableRun).toHaveBeenCalledOnce();
    expect(harness.requestDurableRunProcessing).toHaveBeenCalledOnce();
  });

  it("replays a real capability-bound Storage run parked for approval with runtime metadata intact", async () => {
    const harness = createRealAutonomousReplayHarness({
      ...CRON_TOKEN,
      runId: "cron-run-real-waiting",
      executionGeneration: 8,
    });
    try {
      const first = await enqueueAutonomousChatTurn(harness.deps, harness.input);
      finalizeRealAutonomousRun(harness, "waiting_for_approval");
      expect(harness.storage.durableRuns.getRun(harness.identity.durableRunId)).toMatchObject({
        status: "waiting",
        metadata: {
          waitForEvent: { eventKey: "approval.resolved" },
          generalChatPostCommitPending: { traceStatus: "waiting_for_approval" },
          autonomousAdmission: { materialSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
        },
      });

      const replay = await enqueueAutonomousChatTurn(harness.deps, harness.input);

      expect(replay).toEqual(first);
      expect(harness.requestDurableRunProcessing).toHaveBeenCalledOnce();
      const waitingRun = harness.storage.durableRuns.getRun(harness.identity.durableRunId);
      const waitingAdmission = harness.storage.sessionMutationAdmissions.require(
        (waitingRun.payload as { admissionId: string }).admissionId,
      );
      expect(
        harness.storage.sessionMutationAdmissions.requireCapabilityProfileBinding({
          admissionId: waitingAdmission.admissionId,
          workspaceId: waitingAdmission.workspaceId,
          sessionId: waitingAdmission.sessionId,
          sessionIncarnationId: waitingAdmission.sessionIncarnationId,
          turnId: harness.identity.turnId,
          profileId: harness.getPrepared().capabilityProfile!.profileId,
          profileHash: harness.getPrepared().capabilityProfile!.hashes.profileHash,
          createdAt: harness.getPrepared().capabilityProfile!.createdAt,
        }).admission.status,
      ).toBe("active");

      expect(await harness.service.reconcileGeneralChatPostCommit(harness.identity.durableRunId)).toBe(true);
      expect(await enqueueAutonomousChatTurn(harness.deps, harness.input)).toEqual(first);
      expect(harness.storage.durableRuns.getRun(harness.identity.durableRunId)).toMatchObject({
        status: "waiting",
        metadata: {
          generalChatPostCommit: {
            settlementStatus: "completed",
            completedAt: expect.any(String),
          },
        },
      });

      const waiting = harness.storage.durableRuns.getRun(harness.identity.durableRunId);
      harness.storage.durableRuns.updateRun({
        runId: waiting.runId,
        status: waiting.status,
        metadata: { ...(waiting.metadata ?? {}), unknownAdmissionOwner: { version: 1 } },
        updatedAt: new Date().toISOString(),
        expectedVersion: waiting.version,
      });
      await expect(enqueueAutonomousChatTurn(harness.deps, harness.input)).rejects.toThrow(/metadata/);
      expect(harness.requestDurableRunProcessing).toHaveBeenCalledOnce();
    } finally {
      harness.service.stopWorker();
      harness.storage.close();
      fs.rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("replays a real terminalized and post-commit-settled Storage run without redispatch", async () => {
    const harness = createRealAutonomousReplayHarness({
      ...CRON_TOKEN,
      runId: "cron-run-real-terminal",
      executionGeneration: 9,
    });
    try {
      const first = await enqueueAutonomousChatTurn(harness.deps, harness.input);
      finalizeRealAutonomousRun(harness, "completed");
      const pendingTerminal = harness.storage.durableRuns.getRun(harness.identity.durableRunId);
      expect(
        harness.storage.sessionMutationAdmissions.require(
          (pendingTerminal.payload as { admissionId: string }).admissionId,
        ).status,
      ).toBe("active");
      const {
        generalChatPostCommitPending: _generalPending,
        autonomousChatPostCommitPending: _autonomousPending,
        chatTurnAdmissionHandoff: _handoff,
        linkedFinalizationPending: _linkedPending,
        ...metadataWithoutTerminalReconciliation
      } = pendingTerminal.metadata ?? {};
      const runSpy = vi.spyOn(harness.service, "getDurableRun").mockReturnValue({
        ...pendingTerminal,
        metadata: metadataWithoutTerminalReconciliation,
      });
      await expect(enqueueAutonomousChatTurn(harness.deps, harness.input)).rejects.toThrow(
        /conflicting autonomous finalization/,
      );
      runSpy.mockRestore();
      const pendingTrace = harness.storage.chatTurnTraces.get(harness.identity.turnId);
      const traceSpy = vi.spyOn(harness.storage.chatTurnTraces, "get").mockReturnValue({
        ...pendingTrace,
        status: "failed",
      });
      await expect(enqueueAutonomousChatTurn(harness.deps, harness.input)).rejects.toThrow(
        /conflicting runtime authority/,
      );
      traceSpy.mockRestore();
      expect(harness.requestDurableRunProcessing).toHaveBeenCalledOnce();
      expect(await enqueueAutonomousChatTurn(harness.deps, harness.input)).toEqual(first);
      expect(harness.requestDurableRunProcessing).toHaveBeenCalledTimes(2);
      expect(await harness.service.reconcileAutonomousChatPostCommit(harness.identity.durableRunId)).toBe(true);
      expect(await harness.service.reconcileGeneralChatPostCommit(harness.identity.durableRunId)).toBe(true);
      const settled = harness.storage.durableRuns.getRun(harness.identity.durableRunId);
      expect(settled).toMatchObject({
        status: "completed",
        metadata: {
          autonomousChatPostCommit: { completedAt: expect.any(String) },
          generalChatPostCommit: { settlementStatus: "completed" },
          chatTurnAdmissionHandoff: { parentRunId: harness.identity.durableRunId },
        },
      });
      const admissionId = (settled.payload as { admissionId: string }).admissionId;
      expect(harness.storage.sessionMutationAdmissions.require(admissionId)).toMatchObject({
        status: "completed",
        terminalAuthorityKind: "durable_terminal",
        terminalDurableRunId: harness.identity.durableRunId,
      });

      const replay = await enqueueAutonomousChatTurn(harness.deps, harness.input);

      expect(replay).toEqual(first);
      expect(harness.requestDurableRunProcessing).toHaveBeenCalledTimes(2);

      const conflicting = harness.storage.durableRuns.getRun(harness.identity.durableRunId);
      harness.storage.durableRuns.updateRun({
        runId: conflicting.runId,
        status: conflicting.status,
        metadata: {
          ...(conflicting.metadata ?? {}),
          autonomous: {
            ...((conflicting.metadata?.autonomous as Record<string, unknown>) ?? {}),
            reason: "changed immutable owner",
          },
        },
        updatedAt: new Date().toISOString(),
        expectedVersion: conflicting.version,
      });
      await expect(enqueueAutonomousChatTurn(harness.deps, harness.input)).rejects.toThrow(/metadata/);
      expect(harness.requestDurableRunProcessing).toHaveBeenCalledTimes(2);
    } finally {
      harness.service.stopWorker();
      harness.storage.close();
      fs.rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("accepts a completed durable run whose canonical terminal trace is partial", async () => {
    const harness = createRealAutonomousReplayHarness({
      ...CRON_TOKEN,
      runId: "cron-run-real-partial",
      executionGeneration: 13,
    });
    try {
      const first = await enqueueAutonomousChatTurn(harness.deps, harness.input);
      finalizeRealAutonomousRun(harness, "partial");

      expect(await enqueueAutonomousChatTurn(harness.deps, harness.input)).toEqual(first);
      const run = harness.storage.durableRuns.getRun(harness.identity.durableRunId);
      expect(run).toMatchObject({
        status: "completed",
        metadata: {
          outputText: "Canonical autonomous completion.",
          chatTurnRuntimeAuthority: {
            material: { durableStatus: "completed", traceStatus: "partial" },
          },
        },
      });
    } finally {
      harness.service.stopWorker();
      harness.storage.close();
      fs.rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("rejects malformed seals, unanchored checkpoints, stale generations, stale output, and stray finalizers", async () => {
    const waitingHarness = createRealAutonomousReplayHarness({
      ...CRON_TOKEN,
      runId: "cron-run-runtime-adversarial-waiting",
      executionGeneration: 14,
    });
    try {
      await enqueueAutonomousChatTurn(waitingHarness.deps, waitingHarness.input);
      finalizeRealAutonomousRun(waitingHarness, "waiting_for_approval");
      const waiting = waitingHarness.storage.durableRuns.getRun(waitingHarness.identity.durableRunId);
      const waitingAuthority = waiting.metadata?.[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY] as {
        material: { postCommitGenerationId: string; transitionAt: string };
        materialSha256: string;
      };

      let runSpy = vi.spyOn(waitingHarness.service, "getDurableRun").mockReturnValue({
        ...waiting,
        metadata: {
          ...(waiting.metadata ?? {}),
          [CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]: {
            ...waitingAuthority,
            materialSha256: "0".repeat(64),
          },
        },
      });
      await expect(enqueueAutonomousChatTurn(waitingHarness.deps, waitingHarness.input)).rejects.toThrow(
        /seal hash does not match/,
      );
      runSpy.mockRestore();

      const waitingCheckpoint = waitingHarness.storage.durableRuns.getLatestCheckpointByKind(
        waiting.runId,
        "run_waiting",
      )!;
      const { [CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]: _checkpointAuthority, ...checkpointWithoutAuthority } =
        waitingCheckpoint.state;
      const checkpointSpy = vi
        .spyOn(waitingHarness.storage.durableRuns, "getLatestCheckpointByKind")
        .mockReturnValue({ ...waitingCheckpoint, state: checkpointWithoutAuthority });
      await expect(enqueueAutonomousChatTurn(waitingHarness.deps, waitingHarness.input)).rejects.toThrow(
        /runtime authority seal is missing/,
      );
      checkpointSpy.mockRestore();

      runSpy = vi.spyOn(waitingHarness.service, "getDurableRun").mockReturnValue({
        ...waiting,
        metadata: {
          ...(waiting.metadata ?? {}),
          generalChatPostCommitPending: {
            ...(waiting.metadata?.generalChatPostCommitPending as Record<string, unknown>),
            generationId: "stale-generation",
          },
        },
      });
      await expect(enqueueAutonomousChatTurn(waitingHarness.deps, waitingHarness.input)).rejects.toThrow(
        /stale general finalization evidence/,
      );
      runSpy.mockRestore();

      runSpy = vi.spyOn(waitingHarness.service, "getDurableRun").mockReturnValue({
        ...waiting,
        metadata: {
          ...(waiting.metadata ?? {}),
          autonomousChatPostCommit: {
            delivery: { status: "skipped", reason: "not_required" },
            heartbeatCleanup: { status: "not_required" },
            generationId: waitingAuthority.material.postCommitGenerationId,
            requestedAt: waitingAuthority.material.transitionAt,
            completedAt: waitingAuthority.material.transitionAt,
          },
        },
      });
      await expect(enqueueAutonomousChatTurn(waitingHarness.deps, waitingHarness.input)).rejects.toThrow(
        /stray autonomous finalization evidence/,
      );
      runSpy.mockRestore();
    } finally {
      waitingHarness.service.stopWorker();
      waitingHarness.storage.close();
      fs.rmSync(waitingHarness.root, { recursive: true, force: true });
    }

    const completedHarness = createRealAutonomousReplayHarness({
      ...CRON_TOKEN,
      runId: "cron-run-runtime-adversarial-completed",
      executionGeneration: 15,
    });
    try {
      await enqueueAutonomousChatTurn(completedHarness.deps, completedHarness.input);
      finalizeRealAutonomousRun(completedHarness, "completed");
      const pending = completedHarness.storage.durableRuns.getRun(completedHarness.identity.durableRunId);

      let runSpy = vi.spyOn(completedHarness.service, "getDurableRun").mockReturnValue({
        ...pending,
        metadata: {
          ...(pending.metadata ?? {}),
          outputText: "stale autonomous output",
        },
      });
      await expect(enqueueAutonomousChatTurn(completedHarness.deps, completedHarness.input)).rejects.toThrow(
        /terminal output authority drift/,
      );
      runSpy.mockRestore();

      expect(
        await completedHarness.service.reconcileAutonomousChatPostCommit(completedHarness.identity.durableRunId),
      ).toBe(true);
      expect(
        await completedHarness.service.reconcileGeneralChatPostCommit(completedHarness.identity.durableRunId),
      ).toBe(true);
      const settled = completedHarness.storage.durableRuns.getRun(completedHarness.identity.durableRunId);
      runSpy = vi.spyOn(completedHarness.service, "getDurableRun").mockReturnValue({
        ...settled,
        metadata: {
          ...(settled.metadata ?? {}),
          chatTurnAdmissionHandoff: {
            ...(settled.metadata?.chatTurnAdmissionHandoff as Record<string, unknown>),
            postCommitGenerationId: "stale-generation",
          },
        },
      });
      await expect(enqueueAutonomousChatTurn(completedHarness.deps, completedHarness.input)).rejects.toThrow(
        /conflicting terminal handoff/,
      );
      runSpy.mockRestore();

      const { chatTurnAdmissionHandoff: _handoff, ...withoutHandoff } = settled.metadata ?? {};
      runSpy = vi.spyOn(completedHarness.service, "getDurableRun").mockReturnValue({
        ...settled,
        metadata: withoutHandoff,
      });
      await expect(enqueueAutonomousChatTurn(completedHarness.deps, completedHarness.input)).rejects.toThrow(
        /no exact terminal handoff/,
      );
      runSpy.mockRestore();
    } finally {
      completedHarness.service.stopWorker();
      completedHarness.storage.close();
      fs.rmSync(completedHarness.root, { recursive: true, force: true });
    }
  });

  it("accepts only exact pending or settled linked-finalization evidence", async () => {
    const harness = createRealAutonomousReplayHarness({
      ...CRON_TOKEN,
      runId: "cron-run-runtime-linked-finalization",
      executionGeneration: 16,
    });
    try {
      const first = await enqueueAutonomousChatTurn(harness.deps, harness.input);
      finalizeRealAutonomousRun(harness, "failed");
      const failed = harness.storage.durableRuns.getRun(harness.identity.durableRunId);
      const priorAuthority = failed.metadata?.[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY] as {
        material: { postCommitEligibility: Record<string, unknown> };
      };
      const transitionAt = "2026-07-15T12:00:00.000Z";
      const generationId = "linked-generation";
      const finalizationId = "linked-finalization";
      const reason = "Lease expired after retry exhaustion.";
      const authority = buildChatTurnRuntimeAuthoritySeal({
        runId: failed.runId,
        turnId: harness.identity.turnId,
        transitionKind: "linked_finalization",
        durableStatus: "failed",
        traceStatus: "failed",
        transitionAt,
        postCommitGenerationId: generationId,
        postCommitEligibility: priorAuthority.material.postCommitEligibility as never,
        linkedFinalization: { finalizationId, requestedAt: transitionAt, reason },
        requiredFinalizers: ["linked", "general"],
      });
      const generalPending = {
        ...(failed.metadata?.generalChatPostCommitPending as Record<string, unknown>),
        generationId,
        traceStatus: "failed",
        requestedAt: transitionAt,
        postCommitEligibility: authority.material.postCommitEligibility,
      };
      const pendingMetadata = withChatTurnRuntimeAuthority(
        {
          ...(failed.metadata ?? {}),
          generalChatPostCommitPending: generalPending,
          linkedFinalizationPending: { reason, requestedAt: transitionAt, finalizationId },
        },
        authority,
      );
      const failedCheckpoint = harness.storage.durableRuns.getLatestCheckpointByKind(failed.runId, "run_failed")!;
      const checkpointSpy = vi.spyOn(harness.storage.durableRuns, "getLatestCheckpointByKind").mockReturnValue({
        ...failedCheckpoint,
        state: withChatTurnRuntimeAuthorityCheckpoint(failedCheckpoint.state, authority),
      });
      let runSpy = vi.spyOn(harness.service, "getDurableRun").mockReturnValue({
        ...failed,
        metadata: pendingMetadata,
      });
      expect(await enqueueAutonomousChatTurn(harness.deps, harness.input)).toEqual(first);
      runSpy.mockRestore();

      const { linkedFinalizationPending: _pending, ...metadataWithoutPending } = pendingMetadata;
      const settledMetadata = {
        ...metadataWithoutPending,
        linkedFinalization: {
          version: 1,
          finalizationId,
          requestedAt: transitionAt,
          reasonSha256: authority.material.linkedFinalization!.reasonSha256,
          completedAt: "2026-07-15T12:00:01.000Z",
        },
      };
      runSpy = vi.spyOn(harness.service, "getDurableRun").mockReturnValue({
        ...failed,
        metadata: settledMetadata,
      });
      expect(await enqueueAutonomousChatTurn(harness.deps, harness.input)).toEqual(first);
      runSpy.mockRestore();

      runSpy = vi.spyOn(harness.service, "getDurableRun").mockReturnValue({
        ...failed,
        metadata: {
          ...pendingMetadata,
          linkedFinalizationPending: {
            ...(pendingMetadata.linkedFinalizationPending as Record<string, unknown>),
            reason: "different failure owner",
          },
        },
      });
      await expect(enqueueAutonomousChatTurn(harness.deps, harness.input)).rejects.toThrow(
        /conflicting linked finalization/,
      );
      runSpy.mockRestore();
      checkpointSpy.mockRestore();
    } finally {
      harness.service.stopWorker();
      harness.storage.close();
      fs.rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("fails closed on capability identity, trace, catalog, binding, and permission drift", async () => {
    const harness = createRealAutonomousReplayHarness({
      ...CRON_TOKEN,
      runId: "cron-run-real-capability-drift",
      executionGeneration: 10,
    });
    try {
      await enqueueAutonomousChatTurn(harness.deps, harness.input);
      const profile = harness.storage.chatTurnCapabilityProfiles.findByTurn(harness.identity.turnId)!;
      const trace = harness.storage.chatTurnTraces.get(harness.identity.turnId);
      const cases: Array<{ name: string; install: () => { mockRestore(): void } }> = [
        {
          name: "session identity",
          install: () =>
            vi.spyOn(harness.storage.chatTurnCapabilityProfiles, "findByTurn").mockReturnValue({
              ...profile,
              identity: { ...profile.identity, sessionId: "other-session" },
            }),
        },
        {
          name: "workspace identity",
          install: () =>
            vi.spyOn(harness.storage.chatTurnCapabilityProfiles, "findByTurn").mockReturnValue({
              ...profile,
              identity: { ...profile.identity, workspaceId: "other-workspace" },
            }),
        },
        {
          name: "turn identity",
          install: () =>
            vi.spyOn(harness.storage.chatTurnCapabilityProfiles, "findByTurn").mockReturnValue({
              ...profile,
              identity: { ...profile.identity, turnId: "other-turn" },
            }),
        },
        {
          name: "durable identity",
          install: () =>
            vi.spyOn(harness.storage.chatTurnCapabilityProfiles, "findByTurn").mockReturnValue({
              ...profile,
              identity: { ...profile.identity, durableRunId: "other-run" },
            }),
        },
        {
          name: "trace refs",
          install: () =>
            vi.spyOn(harness.storage.chatTurnTraces, "get").mockReturnValue({
              ...trace,
              capabilityProfileHash: "a".repeat(64),
            }),
        },
        {
          name: "assistant trace identity",
          install: () =>
            vi.spyOn(harness.storage.chatTurnTraces, "get").mockReturnValue({
              ...trace,
              assistantMessageId: undefined,
            }),
        },
        {
          name: "catalog snapshot",
          install: () => vi.spyOn(harness.storage.capabilityCatalogSnapshots, "find").mockReturnValue(undefined),
        },
        {
          name: "permission governance",
          install: () =>
            vi.spyOn(harness.storage.chatTurnCapabilityProfiles, "findByTurn").mockReturnValue({
              ...profile,
              governance: {
                ...profile.governance,
                permission: { ...profile.governance.permission, profileId: "other-permission" },
              },
            }),
        },
        {
          name: "admission binding",
          install: () =>
            vi
              .spyOn(harness.storage.sessionMutationAdmissions, "requireCapabilityProfileBinding")
              .mockImplementation(() => {
                throw new Error("capability binding conflict");
              }),
        },
      ];
      for (const testCase of cases) {
        const spy = testCase.install();
        await expect(enqueueAutonomousChatTurn(harness.deps, harness.input), testCase.name).rejects.toThrow(
          /capability|metadata|binding|trace/iu,
        );
        spy.mockRestore();
      }
      expect(harness.requestDurableRunProcessing).toHaveBeenCalledOnce();
    } finally {
      harness.service.stopWorker();
      harness.storage.close();
      fs.rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("never cross-accepts failed and cancelled terminal trace authority", async () => {
    for (const [index, status, conflictingTraceStatus] of [
      [11, "failed", "cancelled"],
      [12, "cancelled", "failed"],
    ] as const) {
      const harness = createRealAutonomousReplayHarness({
        ...CRON_TOKEN,
        runId: `cron-run-real-${status}`,
        executionGeneration: index,
      });
      try {
        const first = await enqueueAutonomousChatTurn(harness.deps, harness.input);
        finalizeRealAutonomousRun(harness, status);
        expect(await enqueueAutonomousChatTurn(harness.deps, harness.input)).toEqual(first);
        expect(harness.requestDurableRunProcessing).toHaveBeenCalledTimes(2);
        const reconciled = await harness.service.reconcileGeneralChatPostCommit(harness.identity.durableRunId);
        expect(reconciled, JSON.stringify(harness.publishRealtime.mock.calls)).toBe(true);
        const terminal = harness.storage.durableRuns.getRun(harness.identity.durableRunId);
        const admission = harness.storage.sessionMutationAdmissions.require(
          (terminal.payload as { admissionId: string }).admissionId,
        );
        expect(admission).toMatchObject({
          status: "cancelled",
          terminalAuthorityKind: "durable_terminal",
          terminalDurableRunStatus: status,
        });
        expect(await enqueueAutonomousChatTurn(harness.deps, harness.input)).toEqual(first);
        const trace = harness.storage.chatTurnTraces.get(harness.identity.turnId);
        const traceSpy = vi.spyOn(harness.storage.chatTurnTraces, "get").mockReturnValue({
          ...trace,
          status: conflictingTraceStatus,
        });
        await expect(enqueueAutonomousChatTurn(harness.deps, harness.input)).rejects.toThrow(
          /conflicting runtime authority/,
        );
        traceSpy.mockRestore();
        expect(harness.requestDurableRunProcessing).toHaveBeenCalledTimes(2);
      } finally {
        harness.service.stopWorker();
        harness.storage.close();
        fs.rmSync(harness.root, { recursive: true, force: true });
      }
    }
  });

  it("rejects conflicting terminal authority and current policy drift", async () => {
    const identity = buildCronChatAdmissionIdentity(CRON_TOKEN);
    const terminalHarness = buildDeps();
    await enqueueAutonomousChatTurn(terminalHarness.deps, deterministicInput(identity));
    const admission = terminalHarness.admissionRecords.get(`admission:${identity.turnId}`)!;
    const run = terminalHarness.durableRecords.get(identity.durableRunId)!;
    const trace = terminalHarness.traces.get(identity.turnId)!;
    admission.status = "completed";
    admission.terminalAuthorityKind = "durable_terminal";
    admission.terminalDurableRunId = "other-run";
    admission.terminalDurableRunStatus = "completed";
    run.status = "completed";
    trace.status = "completed";
    (trace.durable as Record<string, unknown>).status = "completed";
    await expect(enqueueAutonomousChatTurn(terminalHarness.deps, deterministicInput(identity))).rejects.toThrow(
      /checkpoint-anchored runtime authority/,
    );

    const driftHarness = buildDeps();
    await enqueueAutonomousChatTurn(driftHarness.deps, deterministicInput(identity));
    await expect(
      enqueueAutonomousChatTurn(driftHarness.deps, {
        ...deterministicInput(identity),
        policyContext: {
          actorType: "system",
          actorId: "system-cron",
          permissionProfileId: "changed-profile",
        } as never,
      }),
    ).rejects.toThrow(/current_admission_material|request/);
    expect(driftHarness.createDurableRun).toHaveBeenCalledOnce();
  });

  it("fails closed on a trace replay that has no exact durable v2 owner", async () => {
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

    await expect(enqueueAutonomousChatTurn(deps, deterministicInput(identity))).rejects.toThrow(/has no durable owner/);
    expect(prepareAgentChatTurn).not.toHaveBeenCalled();
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
      /does not match its immutable admission identity/,
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

  it("rejects legacy heartbeat enqueue before admission or child writes when no occurrence is preclaimed", async () => {
    const { deps, prepareAgentChatTurn, createDurableRun, admitSystemChatTurn } = buildDeps();

    await expect(
      enqueueAutonomousChatTurn(deps, {
        sessionId: "session-heartbeat",
        prompt: "HEARTBEAT",
        runId: "heartbeat-random",
        systemActorId: "system-heartbeat",
        reason: "heartbeat self-wake:session-heartbeat",
        kind: "heartbeat",
        deliverMode: "on_notify",
      }),
    ).rejects.toThrow(/exact durable occurrence claim/u);

    expect(admitSystemChatTurn).not.toHaveBeenCalled();
    expect(prepareAgentChatTurn).not.toHaveBeenCalled();
    expect(createDurableRun).not.toHaveBeenCalled();
  });

  it("discovers and fires a heartbeat in a non-default active workspace", async () => {
    const target = heartbeatSession("session-workspace-2", 1);
    const workspaceSql = heartbeatWorkspaceSql(["default", "workspace-2"]);
    const listChatSessions = vi.fn((query: { workspaceId: string }) =>
      query.workspaceId === "workspace-2" ? [target] : [],
    );
    const claimAndEnqueueHeartbeat = vi.fn(async () => ({ disposition: "enqueued" as const }));
    const { deps } = buildDeps({
      storage: {
        gatewaySql: workspaceSql.gatewaySql,
        chatSessionMeta: {
          get: vi.fn((sessionId: string) =>
            sessionId === target.sessionId
              ? { workspaceId: "workspace-2", origin: "operator", lifecycleStatus: "active" }
              : undefined,
          ),
        },
      } as unknown as ChatAutonomousTurnDeps["storage"],
      listChatSessions,
      getSessionAutonomyPrefs: vi.fn((sessionId: string) => heartbeatPrefs(sessionId)),
      getSessionIdleSeconds: vi.fn(() => 600),
      claimAndEnqueueHeartbeat,
    });

    await runHeartbeatSweep(deps);

    expect(listChatSessions).toHaveBeenCalledWith({
      scope: "mission",
      view: "active",
      workspaceId: "workspace-2",
      limit: 500,
    });
    expect(claimAndEnqueueHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-2", sessionId: target.sessionId }),
    );
    expect(workspaceSql.all).toHaveBeenCalledWith({ afterWorkspaceId: "", limit: 100 });
  });

  it("exhausts stable per-workspace pages so session 501 cannot starve behind disabled sessions", async () => {
    const disabled = Array.from({ length: 500 }, (_, index) => heartbeatSession(`disabled-${index + 1}`, index));
    const target = heartbeatSession("target-501", 501);
    const firstCursor = `${disabled.at(-1)?.updatedAt}|${disabled.at(-1)?.sessionId}`;
    const workspaceSql = heartbeatWorkspaceSql(["workspace-1"]);
    const listChatSessions = vi.fn((query: { cursor?: string }) => (query.cursor ? [target] : disabled));
    const claimAndEnqueueHeartbeat = vi.fn(async () => ({ disposition: "enqueued" as const }));
    const { deps } = buildDeps({
      storage: {
        gatewaySql: workspaceSql.gatewaySql,
        chatSessionMeta: {
          get: vi.fn(() => ({ workspaceId: "workspace-1", origin: "operator", lifecycleStatus: "active" })),
        },
      } as unknown as ChatAutonomousTurnDeps["storage"],
      listChatSessions,
      getSessionAutonomyPrefs: vi.fn((sessionId: string) =>
        heartbeatPrefs(sessionId, { heartbeatEnabled: sessionId === target.sessionId }),
      ),
      getSessionIdleSeconds: vi.fn(() => 600),
      claimAndEnqueueHeartbeat,
    });

    await runHeartbeatSweep(deps);

    expect(listChatSessions).toHaveBeenNthCalledWith(2, {
      scope: "mission",
      view: "active",
      workspaceId: "workspace-1",
      cursor: firstCursor,
      limit: 500,
    });
    expect(claimAndEnqueueHeartbeat).toHaveBeenCalledTimes(1);
    expect(claimAndEnqueueHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", sessionId: target.sessionId }),
    );
  });

  it("keyset-pages active workspaces so the page boundary cannot starve later workspaces", async () => {
    const workspaceIds = Array.from({ length: 201 }, (_, index) => `workspace-${String(index + 1).padStart(4, "0")}`);
    const workspaceSql = heartbeatWorkspaceSql(workspaceIds);
    const listChatSessions = vi.fn(() => []);
    const { deps } = buildDeps({
      storage: {
        gatewaySql: workspaceSql.gatewaySql,
      } as unknown as ChatAutonomousTurnDeps["storage"],
      listChatSessions,
    });

    await runHeartbeatSweep(deps);

    expect(workspaceSql.prepare).toHaveBeenCalledWith(expect.stringContaining("LIMIT @limit"));
    expect(workspaceSql.all).toHaveBeenCalledTimes(3);
    expect(workspaceSql.all).toHaveBeenNthCalledWith(2, {
      afterWorkspaceId: "workspace-0100",
      limit: 100,
    });
    expect(workspaceSql.all).toHaveBeenNthCalledWith(3, {
      afterWorkspaceId: "workspace-0200",
      limit: 100,
    });
    expect(listChatSessions).toHaveBeenCalledTimes(201);
    expect(listChatSessions).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-0201", limit: 500 }),
    );
  });

  it("fails closed when a full heartbeat session page repeats without cursor progress", async () => {
    const repeated = Array.from({ length: 500 }, (_, index) => heartbeatSession(`session-${index + 1}`, index));
    const workspaceSql = heartbeatWorkspaceSql(["workspace-1"]);
    const { deps } = buildDeps({
      storage: {
        gatewaySql: workspaceSql.gatewaySql,
      } as unknown as ChatAutonomousTurnDeps["storage"],
      listChatSessions: vi.fn(() => repeated),
      getSessionAutonomyPrefs: vi.fn((sessionId: string) => heartbeatPrefs(sessionId, { heartbeatEnabled: false })),
    });

    await expect(runHeartbeatSweep(deps)).rejects.toThrow(/cursor did not advance/u);
  });

  it("uses real storage to replay a live occurrence and terminalize only expired unbound startup work", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-autonomous-session-admission-"));
    const storage = new Storage({
      dbPath: path.join(root, "gateway.db"),
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    try {
      for (const sessionId of ["session-cron", "session-live", "session-bound"]) {
        storage.chatSessionLifecycles.initialize({
          workspaceId: "default",
          sessionId,
          actorId: "operator:test",
          idempotencyKey: `lifecycle:init:${sessionId}`,
          correlationId: `lifecycle:init:${sessionId}`,
        });
      }
      const owner = new SessionControlRuntimeOwner(new SessionControlService(storage));
      const identity = buildCronChatAdmissionIdentity(CRON_TOKEN);
      const input = deterministicInput(identity);
      const request = buildAutonomousRequestForTest(input);
      const admissionInput = {
        sessionId: input.sessionId,
        turnId: identity.turnId,
        request,
        systemActorId: input.systemActorId,
        occurrenceId: identity.durableRunId,
        idempotencyKey: `chat-turn:autonomous:${identity.durableRunId}`,
        correlationId: input.runId,
      };

      const first = owner.admitSystemChatTurn(admissionInput);
      const liveReplay = new SessionControlRuntimeOwner(new SessionControlService(storage)).admitSystemChatTurn(
        admissionInput,
      );
      expect(liveReplay.identity.admissionId).toBe(first.identity.admissionId);
      expect(liveReplay.requestClaim).toEqual(first.requestClaim);

      const live = owner.admitSystemChatTurn({
        ...admissionInput,
        sessionId: "session-live",
        turnId: "turn-live",
        occurrenceId: "occurrence-live",
        idempotencyKey: "chat-turn:autonomous:live",
        correlationId: "live",
      });
      const bound = owner.admitSystemChatTurn({
        ...admissionInput,
        sessionId: "session-bound",
        turnId: "turn-bound",
        occurrenceId: "occurrence-bound",
        idempotencyKey: "chat-turn:autonomous:bound",
        correlationId: "bound",
      });
      const boundRunId = "run-bound";
      const boundRequest = bound.admittedRequest;
      storage.durableRuns.createRun({
        runId: boundRunId,
        workflowKey: "chat.turn.execute",
        status: "queued",
        attemptCount: 0,
        maxAttempts: 3,
        payload: {
          version: "chat.turn.execute.v2",
          admissionId: bound.identity.admissionId,
          sessionIncarnationId: bound.identity.sessionIncarnationId,
          admissionMaterialSha256: bound.identity.materialSha256,
          workspaceId: bound.identity.workspaceId,
          admissionAggregateRevision: bound.identity.aggregateRevision,
          admissionControllerGeneration: bound.identity.controllerGeneration,
          effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(
            bound.identity.materialSha256,
            boundRequest,
          ),
          policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: boundRunId },
          requestActor: bound.requestActor,
          sessionId: "session-bound",
          turnId: "turn-bound",
          userMessageId: "message-bound-user",
          assistantMessageId: "message-bound-assistant",
          branchKind: "append",
          threadEventType: "chat_thread_turn_appended",
          request: boundRequest,
        },
        metadata: {},
      });
      owner.bindDurableRun(bound, boundRunId);

      // Fixture-only clock aging: production owns this timestamp through the
      // database clock and immutable update guard. Drop the guard only long
      // enough to seed a process-restart snapshot whose lease is already old.
      storage.db.prepare("DROP TRIGGER trg_chat_session_mutation_admissions_update_guard").run();
      storage.db
        .prepare(
          `UPDATE chat_session_mutation_admissions
           SET runtime_last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes'),
               runtime_lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')
           WHERE admission_id IN (@expiredAdmissionId, @boundAdmissionId)`,
        )
        .run({ expiredAdmissionId: first.identity.admissionId, boundAdmissionId: bound.identity.admissionId });

      expect(cancelExpiredUnboundChatTurnAdmissionsOnBoot(owner, "gateway-startup:real-storage-1")).toEqual([
        first.identity.admissionId,
      ]);
      const terminal = storage.sessionMutationAdmissions.require(first.identity.admissionId);
      expect(terminal).toMatchObject({ status: "cancelled", terminalAuthorityKind: "expired_recovery" });
      expect(storage.sessionMutationAdmissions.require(live.identity.admissionId).status).toBe("active");
      expect(storage.sessionMutationAdmissions.require(bound.identity.admissionId).status).toBe("active");
      expect(cancelExpiredUnboundChatTurnAdmissionsOnBoot(owner, "gateway-startup:real-storage-2")).toEqual([]);

      const harness = buildDeps({
        storage: storage as unknown as ChatAutonomousTurnDeps["storage"],
        sessionControlRuntimeOwner: owner,
      });
      await expect(enqueueAutonomousChatTurn(harness.deps, input)).rejects.toThrow(/already terminal/);
      expect(harness.prepareAgentChatTurn).not.toHaveBeenCalled();
      expect(harness.createDurableRun).not.toHaveBeenCalled();
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function buildAutonomousRequestForTest(input: ReturnType<typeof deterministicInput>) {
  const context = buildAutonomousTurnContext({
    kind: "scheduled",
    systemActorId: input.systemActorId,
    runId: input.runId,
    sessionId: input.sessionId,
  });
  return {
    content: input.prompt,
    operatorId: context.policyContext.operatorId,
    authActorId: context.policyContext.authActorId,
    authActorSource: context.policyContext.authActorSource,
    permissionProfileId: SCHEDULED_TURN_PERMISSION_PROFILE_ID,
    policyContext: context.policyContext,
  };
}

function heartbeatWorkspaceSql(workspaceIds: string[]) {
  const sorted = [...workspaceIds].sort((left, right) => left.localeCompare(right));
  const all = vi.fn(({ afterWorkspaceId, limit }: { afterWorkspaceId: string; limit: number }) =>
    sorted
      .filter((workspaceId) => workspaceId > afterWorkspaceId)
      .slice(0, limit)
      .map((workspaceId) => ({ workspace_id: workspaceId })),
  );
  const prepare = vi.fn(() => ({ all }));
  return { gatewaySql: { prepare }, prepare, all };
}

function heartbeatSession(sessionId: string, offset: number) {
  const updatedAt = new Date(Date.parse("2026-07-15T12:00:00.000Z") - offset * 1_000).toISOString();
  return { sessionId, updatedAt, lastActivityAt: "2026-07-15T00:00:00.000Z" };
}

function heartbeatPrefs(
  sessionId: string,
  overrides: Partial<SessionAutonomyPrefsRecord> = {},
): SessionAutonomyPrefsRecord {
  return {
    sessionId,
    proactiveMode: "off",
    maxActionsPerHour: 6,
    maxActionsPerTurn: 2,
    cooldownSeconds: 0,
    retrievalMode: "standard",
    reflectionMode: "off",
    heartbeatEnabled: true,
    heartbeatIntervalSeconds: 0,
    activeHours: { start: 0, end: 0 },
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}
