import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonString, NotFoundError, type PermissionProfileRecord } from "@goatcitadel/contracts";
import { sealChatTurnCapabilityProfile } from "@goatcitadel/storage";
import { enqueueAutonomousChatTurn, type ChatAutonomousTurnDeps } from "./chat-autonomous-turn-service.js";
import { buildHeartbeatOccurrencePlan } from "./heartbeat-occurrence-service.js";
import { persistPreparedChatCapabilityAdmission } from "./chat-durable-run-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
  freezeChatTurnExecutionRequest,
} from "./session-control-service.js";

function buildPrepared(
  ids: {
    sessionId?: string;
    turnId?: string;
    userMessageId?: string;
    assistantMessageId?: string;
  } = {},
  options: { content?: string; actorId?: string; permissionProfileId?: string } = {},
): PreparedAgentChatTurn {
  const sessionId = ids.sessionId ?? "autonomous-session";
  const turnId = ids.turnId ?? "autonomous-turn";
  const userMessageId = ids.userMessageId ?? "autonomous-user-message";
  const assistantMessageId = ids.assistantMessageId ?? "autonomous-assistant-message";
  const content = options.content ?? "Run the scheduled review.";
  const actorId = options.actorId ?? "system-cron";
  const permissionProfileId = options.permissionProfileId ?? "synthetic-scheduled";
  const emptyCatalogHash = createHash("sha256").update(canonicalJsonString([])).digest("hex");
  const capabilityProfile = sealChatTurnCapabilityProfile({
    profileId: `chat-capability-profile-${turnId}`,
    schemaVersion: "chat.turn.capability-profile.v1",
    identity: {
      turnId,
      sessionId,
      workspaceId: "default",
      citadelId: "default",
      operatorId: actorId,
      authActorId: actorId,
      authActorSource: "none",
    },
    source: { channel: "chat", account: "default" },
    catalog: {
      snapshotId: "autonomous-snapshot",
      inspectableHash: emptyCatalogHash,
      callableHash: emptyCatalogHash,
      inspectableCount: 0,
      callableCount: 0,
    },
    selection: {
      contentHash: "c".repeat(64),
      effectiveProviderId: "provider-a",
      effectiveModel: "model-a",
      allowedFallbacks: [],
      mode: "chat",
      webMode: "off",
      memory: {
        mode: "off",
        retrievalMode: "standard",
        workspaceId: "default",
        sessionId,
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
        profileId: permissionProfileId,
        approvalMode: "approve_all",
        profileHash: "e".repeat(64),
      },
      policyDecisions: [],
      authReadiness: [
        { kind: "provider", ref: "provider-a", status: "ready", reasonCodes: [] },
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
    createdAt: "2026-07-13T00:00:00.000Z",
  });
  return {
    session: { sessionId },
    workspaceId: "default",
    content,
    userEventId: userMessageId,
    userMessage: {
      messageId: userMessageId,
      sessionId,
      role: "user",
      actorType: "user",
      actorId,
      content,
      timestamp: "2026-07-13T00:00:00.000Z",
    },
    turnId,
    assistantMessageId,
    branchKind: "append",
    effectiveMode: "chat",
    prefs: {
      mode: "chat",
      providerId: "provider-a",
      model: "model-a",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "auto_when_useful",
      toolAutonomy: "manual",
    },
    normalized: {},
    modelRouterDecision: {},
    effectiveToolAutonomy: "manual",
    capabilityProfile,
    capabilityCatalogSnapshot: {
      snapshotId: "autonomous-snapshot",
      inspectableEntries: [],
      callableEntries: [],
      createdAt: "2026-07-13T00:00:00.000Z",
    },
  } as PreparedAgentChatTurn;
}

describe("autonomous Chat capability admission", () => {
  it("registers synthetic policy before prep and atomically binds profile, run, trace, and stream start", async () => {
    const events: string[] = [];
    let prepared = buildPrepared();
    const syntheticProfile = {
      profileId: "synthetic-scheduled",
      name: "Synthetic scheduled",
      status: "active",
      approvalMode: "approve_all",
      scope: "session",
      scopeRef: "autonomous-session",
      tools: [],
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    } as unknown as PermissionProfileRecord;
    const listSkillLifecycle = vi.fn(() => []);
    let storedProfile = prepared.capabilityProfile;
    let durablePayload: Record<string, unknown> | undefined;
    const admitSystemChatTurn = vi.fn((input) => {
      const admittedRequest = freezeChatTurnExecutionRequest(input.request);
      return {
        identity: {
          admissionId: `admission:${input.turnId}`,
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
    });
    const startRequestLeaseHeartbeat = vi.fn(() => ({ stop: vi.fn(), assertHealthy: vi.fn() }));
    const assertActiveTurnWrite = vi.fn();
    const bindDurableRun = vi.fn((admission) => {
      admission.requestClaim = undefined;
    });
    const closeTurnWrite = vi.fn();
    const bindCapabilityProfile = vi.fn((input) => ({ disposition: "created", binding: input }));
    const deps = {
      storage: {
        capabilityCatalogSnapshots: { create: vi.fn(() => events.push("snapshot")) },
        chatTurnCapabilityProfiles: {
          create: vi.fn((profile) => {
            events.push("profile");
            storedProfile = profile;
            return profile;
          }),
        },
        sessionMutationAdmissions: { bindCapabilityProfile },
        skillLifecycle: { list: listSkillLifecycle },
        chatTurnTraces: {
          get: vi.fn(() => {
            throw new NotFoundError({ entity: "chat turn trace", id: prepared.turnId });
          }),
          create: vi.fn((trace) => {
            events.push("trace");
            return trace;
          }),
        },
        runImmediateTransaction: (callback: () => unknown) => {
          events.push("tx-start");
          const result = callback();
          events.push("tx-commit");
          return result;
        },
      },
      isFeatureEnabled: vi.fn((flag: string) => flag === "durableKernelV1Enabled"),
      registerSyntheticPermissionProfile: vi.fn(() => events.push("register-policy")),
      sessionControlRuntimeOwner: {
        admitSystemChatTurn,
        startRequestLeaseHeartbeat,
        assertActiveTurnWrite,
        bindDurableRun,
        closeTurnWrite,
      },
      prepareAgentChatTurn: vi.fn(async (_sessionId, _request, options) => {
        events.push("prepare");
        prepared = {
          ...buildPrepared({
            sessionId: _sessionId,
            turnId: options.turnId,
            userMessageId: options.userMessageId,
            assistantMessageId: options.assistantMessageId,
          }),
          turnAdmission: options.turnAdmission,
        } as PreparedAgentChatTurn;
        return prepared;
      }),
      buildDurableChatTurnPayloadRecord: vi.fn((preparedTurn, request, durableRunId) => {
        const admission = preparedTurn.turnAdmission!;
        const frozenRequest = freezeChatTurnExecutionRequest(request);
        durablePayload = {
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
          capabilityProfileId: preparedTurn.capabilityProfile?.profileId,
          capabilityProfileHash: preparedTurn.capabilityProfile?.hashes.profileHash,
          branchKind: preparedTurn.branchKind,
          threadEventType: "chat_thread_turn_appended",
          request: frozenRequest,
        };
        return durablePayload;
      }),
      createDurableRun: vi.fn((input) => {
        events.push("run");
        return {
          runId: input.runId,
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
      }),
      persistChatStreamChunk: vi.fn(() => events.push("message-start")),
      onDurableRunCommitted: vi.fn(() => events.push("published")),
      requestDurableRunProcessing: vi.fn(() => events.push("processing")),
    } as unknown as ChatAutonomousTurnDeps;

    const result = await enqueueAutonomousChatTurn(deps, {
      sessionId: "autonomous-session",
      prompt: "Run the scheduled review.",
      runId: "scheduler-occurrence",
      systemActorId: "system-cron",
      reason: "scheduled review",
      deliverMode: "always",
      policyContext: {
        operatorId: "system-cron",
        authActorId: "system-cron",
        authActorSource: "none",
        permissionProfileId: syntheticProfile.profileId,
        permissionProfile: syntheticProfile,
        sessionId: "autonomous-session",
      },
    });

    expect(events).toEqual([
      "register-policy",
      "prepare",
      "tx-start",
      "snapshot",
      "profile",
      "run",
      "trace",
      "message-start",
      "tx-commit",
      "published",
      "processing",
    ]);
    expect(storedProfile?.identity.durableRunId).toBe(result?.runId);
    expect(admitSystemChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        systemActorId: "system-cron",
        occurrenceId: result?.runId,
      }),
    );
    expect(bindCapabilityProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        admissionId: expect.stringMatching(/^admission:turn_autonomous_/),
        profileId: storedProfile?.profileId,
        profileHash: storedProfile?.hashes.profileHash,
      }),
    );
    expect(listSkillLifecycle).toHaveBeenCalledTimes(1);
    expect(prepared.history).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining(storedProfile?.hashes.profileHash ?? "missing-profile-hash"),
      }),
    ]);
    expect(durablePayload).toMatchObject({
      capabilityProfileId: storedProfile?.profileId,
      capabilityProfileHash: storedProfile?.hashes.profileHash,
    });
    expect(result?.runId).toMatch(/^run_autonomous_chat_[a-f0-9]{40}$/);
  });

  it("uses one preclaimed heartbeat admission and atomically binds the exact v2 occurrence payload", async () => {
    const claimInput = {
      workspaceId: "default",
      sessionId: "heartbeat-session",
      expectedPriorCadence: {},
      idleFloorSeconds: 300,
    };
    const plan = buildHeartbeatOccurrencePlan(claimInput);
    const occurrence = {
      occurrenceId: "heartbeat-occurrence-1",
      workspaceId: "default",
      sessionId: "heartbeat-session",
      sessionIncarnationId: "heartbeat-incarnation-1",
      admissionId: "heartbeat-admission-1",
      admissionRequestSha256: "1".repeat(64),
      admissionIdempotencyKey: "heartbeat-admission:heartbeat-occurrence-1",
      admissionCorrelationId: "heartbeat-occurrence-1",
      runtimeOwnerId: "heartbeat-runtime-1",
      systemActorId: "system-heartbeat" as const,
      admissionMaterialSha256: plan.frozenRequestSha256,
      evaluatedPolicySha256: plan.evaluatedPolicySha256,
      frozenRequestSha256: plan.frozenRequestSha256,
      frozenObjectiveSha256: plan.frozenObjectiveSha256,
      claimSha256: "2".repeat(64),
      aggregateRevision: 3,
      controllerGeneration: 2,
      priorCadence: {},
      heartbeatIntervalSeconds: 3600,
      cooldownSeconds: 300,
      idleFloorSeconds: 300,
      observedSessionActivityAt: "2026-07-15T18:00:00.000Z",
      userMessageId: "heartbeat-user-1",
      assistantMessageId: "heartbeat-assistant-1",
      turnId: "heartbeat-turn-1",
      durableRunId: "heartbeat-run-1",
      state: "admitted" as const,
      revision: 1,
      claimedAt: "2026-07-15T19:00:00.000Z",
      updatedAt: "2026-07-15T19:00:00.000Z",
    };
    const turnAdmission = {
      identity: {
        admissionId: occurrence.admissionId,
        sessionIncarnationId: occurrence.sessionIncarnationId,
        workspaceId: occurrence.workspaceId,
        sessionId: occurrence.sessionId,
        turnId: occurrence.turnId,
        aggregateRevision: occurrence.aggregateRevision,
        controllerGeneration: occurrence.controllerGeneration,
        materialSha256: occurrence.frozenRequestSha256,
      },
      admittedRequest: freezeChatTurnExecutionRequest(plan.request),
      requestActor: { actorKind: "system" as const, actorId: "system-heartbeat" },
      systemHeartbeatOccurrence: {
        kind: "system_heartbeat_occurrence" as const,
        operation: "chat_system_heartbeat" as const,
        occurrenceId: occurrence.occurrenceId,
        correlationId: occurrence.occurrenceId,
        claimSha256: occurrence.claimSha256,
        durableRunId: occurrence.durableRunId,
      },
      requestClaim: { runtimeOwnerId: occurrence.runtimeOwnerId, leaseRevision: 1 },
    };
    const events: string[] = [];
    let prepared = buildPrepared(
      {
        sessionId: occurrence.sessionId,
        turnId: occurrence.turnId,
        userMessageId: occurrence.userMessageId,
        assistantMessageId: occurrence.assistantMessageId,
      },
      {
        content: plan.request.content,
        actorId: "system-heartbeat",
        permissionProfileId: plan.request.permissionProfileId,
      },
    );
    const admitSystemChatTurn = vi.fn();
    const markDurableBound = vi.fn((identity) => {
      events.push("occurrence-bound");
      expect(identity).toMatchObject({
        occurrenceId: occurrence.occurrenceId,
        durableRunId: occurrence.durableRunId,
        capabilityProfileId: prepared.capabilityProfile?.profileId,
        capabilityProfileHash: prepared.capabilityProfile?.hashes.profileHash,
      });
      return { disposition: "created", occurrence: { ...occurrence, state: "durable_bound" } };
    });
    let createdPayload: Record<string, unknown> | undefined;
    const deps = {
      storage: {
        capabilityCatalogSnapshots: {
          create: vi.fn((snapshot) => {
            events.push("snapshot");
            return snapshot;
          }),
        },
        chatTurnCapabilityProfiles: {
          create: vi.fn((profile) => {
            events.push("profile");
            return profile;
          }),
        },
        sessionMutationAdmissions: { bindCapabilityProfile: vi.fn(() => ({ disposition: "created" })) },
        heartbeatOccurrences: { markDurableBound },
        skillLifecycle: { list: vi.fn(() => []) },
        chatTurnTraces: {
          get: vi.fn(() => {
            throw new NotFoundError({ entity: "chat turn trace", id: occurrence.turnId });
          }),
          create: vi.fn((trace) => {
            events.push("trace");
            return trace;
          }),
        },
        runImmediateTransaction: (callback: () => unknown) => {
          events.push("tx-start");
          const result = callback();
          events.push("tx-commit");
          return result;
        },
      },
      isFeatureEnabled: vi.fn((flag: string) => flag === "durableKernelV1Enabled"),
      registerSyntheticPermissionProfile: vi.fn(),
      sessionControlRuntimeOwner: {
        admitSystemChatTurn,
        startRequestLeaseHeartbeat: vi.fn(() => ({ stop: vi.fn(), assertHealthy: vi.fn() })),
        assertActiveTurnWrite: vi.fn(),
        bindDurableRun: vi.fn((admission) => {
          events.push("admission-bound");
          admission.requestClaim = undefined;
        }),
        closeTurnWrite: vi.fn(),
      },
      prepareAgentChatTurn: vi.fn(async (_sessionId, _request, options) => {
        events.push("prepare");
        expect(options.serverOnlyPosture).toEqual({
          kind: "system_heartbeat",
          actorId: "system-heartbeat",
          operation: "chat_system_heartbeat",
          occurrenceId: occurrence.occurrenceId,
          claimSha256: occurrence.claimSha256,
          durableRunId: occurrence.durableRunId,
        });
        prepared = {
          ...prepared,
          turnAdmission: options.turnAdmission,
        } as PreparedAgentChatTurn;
        return prepared;
      }),
      buildDurableChatTurnPayloadRecord: vi.fn((preparedTurn, request, durableRunId) => ({
        version: "chat.turn.execute.v2",
        admissionId: turnAdmission.identity.admissionId,
        sessionIncarnationId: turnAdmission.identity.sessionIncarnationId,
        admissionMaterialSha256: turnAdmission.identity.materialSha256,
        workspaceId: turnAdmission.identity.workspaceId,
        admissionAggregateRevision: turnAdmission.identity.aggregateRevision,
        admissionControllerGeneration: turnAdmission.identity.controllerGeneration,
        effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(
          turnAdmission.identity.materialSha256,
          freezeChatTurnExecutionRequest(request),
        ),
        policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: durableRunId },
        requestActor: turnAdmission.requestActor,
        sessionId: preparedTurn.session.sessionId,
        turnId: preparedTurn.turnId,
        userMessageId: preparedTurn.userEventId,
        assistantMessageId: preparedTurn.assistantMessageId,
        capabilityProfileId: preparedTurn.capabilityProfile?.profileId,
        capabilityProfileHash: preparedTurn.capabilityProfile?.hashes.profileHash,
        request: freezeChatTurnExecutionRequest(request),
      })),
      createDurableRun: vi.fn((input) => {
        events.push("run");
        createdPayload = input.payload;
        return { ...input, status: "queued", attemptCount: 0, maxAttempts: 3, version: 1 };
      }),
      persistChatStreamChunk: vi.fn(() => events.push("message-start")),
      onDurableRunCommitted: vi.fn(() => events.push("published")),
      requestDurableRunProcessing: vi.fn(() => events.push("processing")),
    } as unknown as ChatAutonomousTurnDeps;

    const result = await enqueueAutonomousChatTurn(deps, {
      sessionId: occurrence.sessionId,
      prompt: plan.request.content,
      runId: plan.sourceRunId,
      systemActorId: "system-heartbeat",
      reason: plan.reason,
      kind: "heartbeat",
      deliverMode: "on_notify",
      heartbeatOccurrence: { occurrence, turnAdmission, request: plan.request },
    });

    expect(admitSystemChatTurn).not.toHaveBeenCalled();
    expect(result?.runId).toBe(occurrence.durableRunId);
    expect(createdPayload).toMatchObject({
      heartbeatOccurrenceId: occurrence.occurrenceId,
      heartbeatClaimSha256: occurrence.claimSha256,
      heartbeatEvaluatedPolicySha256: occurrence.evaluatedPolicySha256,
      heartbeatFrozenObjectiveSha256: occurrence.frozenObjectiveSha256,
    });
    expect(events).toEqual([
      "prepare",
      "tx-start",
      "snapshot",
      "profile",
      "run",
      "admission-bound",
      "trace",
      "occurrence-bound",
      "tx-commit",
      "published",
      "processing",
    ]);
  });

  it("persists nothing when catalog verification fails before admission", () => {
    const prepared = buildPrepared();
    prepared.capabilityCatalogSnapshot = {
      ...prepared.capabilityCatalogSnapshot!,
      callableEntries: [
        {
          capabilityId: "tool:unexpected",
          kind: "tool",
          category: "built_in",
          title: "Unexpected",
          summary: "Must not be admitted.",
          callable: true,
          toolName: "unexpected",
        },
      ],
    };
    const createSnapshot = vi.fn();
    const createProfile = vi.fn();

    expect(() =>
      persistPreparedChatCapabilityAdmission(
        {
          capabilityCatalogSnapshots: { create: createSnapshot },
          chatTurnCapabilityProfiles: { create: createProfile },
          sessionMutationAdmissions: { bindCapabilityProfile: vi.fn() },
          skillLifecycle: { list: vi.fn(() => []) },
        },
        prepared,
      ),
    ).toThrow(/immutable catalog snapshot/);
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(createProfile).not.toHaveBeenCalled();
  });
});
