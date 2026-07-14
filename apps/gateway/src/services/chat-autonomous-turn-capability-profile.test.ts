import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonString, NotFoundError, type PermissionProfileRecord } from "@goatcitadel/contracts";
import { sealChatTurnCapabilityProfile } from "@goatcitadel/storage";
import { enqueueAutonomousChatTurn, type ChatAutonomousTurnDeps } from "./chat-autonomous-turn-service.js";
import { persistPreparedChatCapabilityAdmission } from "./chat-durable-run-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";

function buildPrepared(): PreparedAgentChatTurn {
  const emptyCatalogHash = createHash("sha256").update(canonicalJsonString([])).digest("hex");
  const capabilityProfile = sealChatTurnCapabilityProfile({
    profileId: "chat-capability-profile-autonomous-turn",
    schemaVersion: "chat.turn.capability-profile.v1",
    identity: {
      turnId: "autonomous-turn",
      sessionId: "autonomous-session",
      workspaceId: "default",
      citadelId: "default",
      operatorId: "system-cron",
      authActorId: "system-cron",
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
        sessionId: "autonomous-session",
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
        profileId: "synthetic-scheduled",
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
    session: { sessionId: "autonomous-session" },
    content: "Run the scheduled review.",
    userEventId: "autonomous-user-message",
    userMessage: {
      messageId: "autonomous-user-message",
      sessionId: "autonomous-session",
      role: "user",
      actorType: "user",
      actorId: "system-cron",
      content: "Run the scheduled review.",
      timestamp: "2026-07-13T00:00:00.000Z",
    },
    turnId: "autonomous-turn",
    assistantMessageId: "autonomous-assistant-message",
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
    const prepared = buildPrepared();
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
      prepareAgentChatTurn: vi.fn(async () => {
        events.push("prepare");
        return prepared;
      }),
      buildDurableChatTurnPayloadRecord: vi.fn((preparedTurn) => {
        durablePayload = {
          version: "chat.turn.execute.v1",
          sessionId: preparedTurn.session.sessionId,
          turnId: preparedTurn.turnId,
          capabilityProfileId: preparedTurn.capabilityProfile?.profileId,
          capabilityProfileHash: preparedTurn.capabilityProfile?.hashes.profileHash,
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
    expect(result?.runId).toMatch(/^[a-f0-9-]{36}$/);
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
          skillLifecycle: { list: vi.fn(() => []) },
        },
        prepared,
      ),
    ).toThrow(/immutable catalog snapshot/);
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(createProfile).not.toHaveBeenCalled();
  });
});
