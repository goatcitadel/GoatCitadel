import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString,
  NotFoundError,
  type ChatRoutedContextSnapshotRecord,
  type ChatSendMessageRequest,
  type ChatTurnTraceRecord,
  type ChatTurnCapabilityProfileRecord,
  type DurableRunCreateRequest,
  type DurableRunRecord,
} from "@goatcitadel/contracts";
import {
  renderChatRoutedContextEntries,
  sealChatRoutedContextSnapshot,
  sealChatTurnCapabilityProfile,
} from "@goatcitadel/storage";
import { beginDurableChatRun, type ChatDurableRunBeginDeps } from "./chat-durable-run-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";

vi.mock("./chat-turn-dispatch-service.js", () => ({
  executePreparedAgentChatTurnBackground: vi.fn(),
}));

import { executePreparedAgentChatTurnBackground } from "./chat-turn-dispatch-service.js";
import { executeDurableChatTurnRun, parseDurableChatTurnPayload } from "./durable-execution-service.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(executePreparedAgentChatTurnBackground).mockResolvedValue(undefined as never);
});

describe("durable Chat routed-context binding", () => {
  it("atomically rebinds the snapshot to the stable run profile and persists only id/hash references", () => {
    const fixture = admitRoutedTurn();
    const payloadText = JSON.stringify(fixture.run.payload);
    const traceText = JSON.stringify(fixture.trace);

    expect(fixture.finalProfile.identity.durableRunId).toBe("run-routed-1");
    expect(fixture.finalProfile.hashes.profileHash).not.toBe(fixture.provisionalProfileHash);
    expect(fixture.finalSnapshot).toMatchObject({
      snapshotId: "routed-snapshot-turn-1",
      capabilityProfileId: fixture.finalProfile.profileId,
      capabilityProfileHash: fixture.finalProfile.hashes.profileHash,
    });
    expect(fixture.finalSnapshot.snapshotHash).not.toBe(fixture.provisionalSnapshotHash);
    expect(fixture.run.payload).toMatchObject({
      routedContextSnapshotId: fixture.finalSnapshot.snapshotId,
      routedContextSnapshotHash: fixture.finalSnapshot.snapshotHash,
      request: { content: "Use the admitted source." },
    });
    expect((fixture.run.payload.request as Record<string, unknown>).contextRefs).toBeUndefined();
    for (const forbidden of ["contextRefs", "attachment-secret-ref", "private-source-label", "exact source bytes"]) {
      expect(payloadText).not.toContain(forbidden);
    }
    for (const forbidden of [
      "contextRefs",
      "admittedText",
      "exact source bytes",
      "storageRelPath",
      "attachment-secret-ref",
      "private-source-label",
    ]) {
      expect(traceText).not.toContain(forbidden);
    }
    expect(fixture.trace).toMatchObject({
      routing: {
        routedContext: {
          snapshotId: fixture.finalSnapshot.snapshotId,
          snapshotHash: fixture.finalSnapshot.snapshotHash,
          sourceRequestHash: fixture.finalSnapshot.sourceRequestHash,
          contentHash: fixture.finalSnapshot.contentHash,
        },
      },
    });
    expect(fixture.events).toEqual([
      "tx:start",
      "catalog",
      "profile",
      "routed-snapshot",
      "durable-run",
      "trace",
      "stream",
      "tx:commit",
      "process",
    ]);
  });

  it("rejects live refs without a frozen snapshot and refuses snapshot reuse for a different turn", () => {
    const missing = buildPrepared();
    delete (missing as PreparedAgentChatTurn & { routedContextSnapshot?: unknown }).routedContextSnapshot;
    const createDurableRun = vi.fn();
    expect(() =>
      beginDurableChatRun(minimalBeginDeps(createDurableRun), missing, routedRequest(), "chat_thread_turn_appended", {
        runId: "run-missing",
      }),
    ).toThrow(/cannot persist live routed-context references/u);
    expect(createDurableRun).not.toHaveBeenCalled();

    const reused = buildPrepared();
    reused.turnId = "turn-retry-new";
    expect(() =>
      beginDurableChatRun(minimalBeginDeps(createDurableRun), reused, routedRequest(), "chat_thread_turn_retried", {
        runId: "run-retry-new",
      }),
    ).toThrow(/mismatched routed-context snapshot/u);
    expect(createDurableRun).not.toHaveBeenCalled();
  });

  it("keeps the exact historical payload object for turns without routed context", () => {
    const prepared = buildPrepared();
    delete (prepared as PreparedAgentChatTurn & { routedContextSnapshot?: unknown }).routedContextSnapshot;
    delete prepared.capabilityProfile;
    delete prepared.capabilityCatalogSnapshot;
    const historicalPayload = {
      version: "chat.turn.execute.v1",
      sessionId: "session-1",
      turnId: "turn-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      branchKind: "append",
      threadEventType: "chat_thread_turn_appended",
      request: { content: "No routed context." },
    };
    let persistedPayload: Record<string, unknown> | undefined;
    beginDurableChatRun(
      {
        shouldUseDurableExecution: true,
        createDurableRun: (input) => {
          persistedPayload = input.payload;
          return runFromCreate(input);
        },
        buildDurablePayloadRecord: () => historicalPayload,
        persistChatStreamChunk: vi.fn(),
        requestDurableRunProcessing: vi.fn(),
      },
      prepared,
      { content: "No routed context." },
      "chat_thread_turn_appended",
      { runId: "run-historical" },
    );
    expect(persistedPayload).toBe(historicalPayload);
  });

  it("fails closed instead of running routed context through the non-durable compatibility path", () => {
    const prepared = buildPrepared();
    expect(() =>
      beginDurableChatRun(
        {
          shouldUseDurableExecution: false,
          createDurableRun: vi.fn(),
          buildDurablePayloadRecord: vi.fn(),
          persistChatStreamChunk: vi.fn(),
          requestDurableRunProcessing: vi.fn(),
        },
        prepared,
        routedRequest(),
        "chat_thread_turn_appended",
      ),
    ).toThrow(/cannot execute routed context without durable admission/u);
  });

  it("loads the same frozen snapshot on continuation and injects its exact system block once", async () => {
    const fixture = admitRoutedTurn();
    const run = { ...fixture.run, attemptCount: 1, leaseOwnerId: "worker-1" };
    const preparedTurns: PreparedAgentChatTurn[] = [];
    const prepareAgentChatTurn = vi.fn(async (_sessionId: string, request: ChatSendMessageRequest) => {
      expect((request as ChatSendMessageRequest & { contextRefs?: unknown }).contextRefs).toBeUndefined();
      const prepared = buildReplayPrepared(fixture.finalProfile);
      preparedTurns.push(prepared);
      return prepared;
    });
    const getSnapshot = vi.fn(() => fixture.finalSnapshot);
    const host = replayHost(run, fixture.finalProfile, fixture.trace, prepareAgentChatTurn, getSnapshot);

    await executeDurableChatTurnRun(host as never, run);
    await executeDurableChatTurnRun(host as never, run);

    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(getSnapshot).toHaveBeenNthCalledWith(1, fixture.finalSnapshot.snapshotId);
    expect(getSnapshot).toHaveBeenNthCalledWith(2, fixture.finalSnapshot.snapshotId);
    expect(preparedTurns).toHaveLength(2);
    for (const prepared of preparedTurns) {
      expect(prepared.routedContextSnapshot).toBe(fixture.finalSnapshot);
      expect({
        contextSnapshotId: prepared.routedContextSnapshot?.snapshotId,
        contextIntentHash: prepared.routedContextSnapshot?.sourceRequestHash,
        contextResolutionHash: prepared.routedContextSnapshot?.snapshotHash,
      }).toEqual({
        contextSnapshotId: fixture.finalSnapshot.snapshotId,
        contextIntentHash: fixture.finalSnapshot.sourceRequestHash,
        contextResolutionHash: fixture.finalSnapshot.snapshotHash,
      });
      expect(
        prepared.history.filter(
          (message) => message.role === "system" && message.content === fixture.finalSnapshot.contextText,
        ),
      ).toHaveLength(1);
    }
    expect(executePreparedAgentChatTurnBackground).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(executePreparedAgentChatTurnBackground).mock.calls) {
      const dispatchedPrepared = call[3] as PreparedAgentChatTurn;
      expect(
        dispatchedPrepared.history.filter((message) => message.content === fixture.finalSnapshot.contextText),
      ).toHaveLength(1);
    }
  });

  it.each(["missing", "corrupt", "hash-mismatch", "trace-mismatch"] as const)(
    "fails a %s frozen snapshot before prep or provider dispatch",
    async (failure) => {
      const fixture = admitRoutedTurn();
      const run =
        failure === "hash-mismatch"
          ? {
              ...fixture.run,
              payload: { ...fixture.run.payload, routedContextSnapshotHash: "f".repeat(64) },
            }
          : fixture.run;
      const prepareAgentChatTurn = vi.fn(async () => buildReplayPrepared(fixture.finalProfile));
      const getSnapshot = vi.fn(() => {
        if (failure === "missing") {
          throw new NotFoundError({ entity: "chat routed context snapshot", id: fixture.finalSnapshot.snapshotId });
        }
        if (failure === "corrupt") {
          return { ...fixture.finalSnapshot, contextText: `${fixture.finalSnapshot.contextText}!` };
        }
        return fixture.finalSnapshot;
      });
      const trace =
        failure === "trace-mismatch"
          ? {
              ...fixture.trace,
              routing: {
                ...fixture.trace.routing,
                routedContext: {
                  ...fixture.trace.routing.routedContext!,
                  contentHash: "f".repeat(64),
                },
              },
            }
          : fixture.trace;
      const host = replayHost(run, fixture.finalProfile, trace, prepareAgentChatTurn, getSnapshot);

      await expect(executeDurableChatTurnRun(host as never, run)).rejects.toThrow();
      expect(prepareAgentChatTurn).not.toHaveBeenCalled();
      expect(host.registerActiveChatTurnStream).not.toHaveBeenCalled();
      expect(executePreparedAgentChatTurnBackground).not.toHaveBeenCalled();
    },
  );

  it("rejects raw refs and incomplete snapshot references in parsed durable payloads", () => {
    const fixture = admitRoutedTurn();
    const base = fixture.run.payload;
    expect(
      parseDurableChatTurnPayload({
        ...fixture.run,
        payload: {
          ...base,
          request: { ...(base.request as Record<string, unknown>), contextRefs: [{ kind: "attachment", ref: "x" }] },
        },
      }),
    ).toBeUndefined();
    expect(
      parseDurableChatTurnPayload({
        ...fixture.run,
        payload: { ...base, routedContextSnapshotHash: undefined },
      }),
    ).toBeUndefined();
    expect(
      parseDurableChatTurnPayload({
        ...fixture.run,
        payload: {
          ...base,
          routedContext: { admittedText: "must never persist" },
        },
      }),
    ).toBeUndefined();
  });
});

function admitRoutedTurn() {
  const prepared = buildPrepared();
  const provisionalProfileHash = prepared.capabilityProfile!.hashes.profileHash;
  const provisionalSnapshot = (
    prepared as PreparedAgentChatTurn & {
      routedContextSnapshot: ChatRoutedContextSnapshotRecord;
    }
  ).routedContextSnapshot;
  const provisionalSnapshotHash = provisionalSnapshot.snapshotHash;
  const events: string[] = [];
  let finalProfile!: ChatTurnCapabilityProfileRecord;
  let finalSnapshot!: ChatRoutedContextSnapshotRecord;
  let trace!: ChatTurnTraceRecord;
  const deps: ChatDurableRunBeginDeps = {
    shouldUseDurableExecution: true,
    runImmediateTransaction: (callback) => {
      events.push("tx:start");
      const value = callback();
      events.push("tx:commit");
      return value;
    },
    capabilityCatalogSnapshots: {
      create: (snapshot) => {
        events.push("catalog");
        return snapshot;
      },
    },
    chatTurnCapabilityProfiles: {
      create: (profile) => {
        events.push("profile");
        finalProfile = profile;
        return profile;
      },
    },
    routedContextSnapshots: {
      create: (snapshot) => {
        events.push("routed-snapshot");
        finalSnapshot = snapshot;
        return snapshot;
      },
    },
    skillLifecycle: { list: () => [] },
    createDurableRun: (input) => {
      events.push("durable-run");
      return runFromCreate(input);
    },
    buildDurablePayloadRecord: (preparedTurn, input, threadEventType) => ({
      version: "chat.turn.execute.v1",
      sessionId: preparedTurn.session.sessionId,
      turnId: preparedTurn.turnId,
      userMessageId: preparedTurn.userEventId,
      assistantMessageId: preparedTurn.assistantMessageId,
      capabilityProfileId: preparedTurn.capabilityProfile?.profileId,
      capabilityProfileHash: preparedTurn.capabilityProfile?.hashes.profileHash,
      branchKind: preparedTurn.branchKind,
      threadEventType,
      request: { ...input },
    }),
    chatTurnTraces: {
      get: () => {
        throw new NotFoundError({ entity: "chat turn trace", id: prepared.turnId });
      },
      create: (input) => {
        events.push("trace");
        trace = input as ChatTurnTraceRecord;
        return input as never;
      },
    },
    persistChatStreamChunk: () => events.push("stream"),
    requestDurableRunProcessing: () => events.push("process"),
  };
  const run = beginDurableChatRun(deps, prepared, routedRequest(), "chat_thread_turn_appended", {
    runId: "run-routed-1",
  })!;
  return {
    run,
    trace,
    events,
    finalProfile,
    finalSnapshot,
    provisionalProfileHash,
    provisionalSnapshotHash,
  };
}

function buildPrepared(): PreparedAgentChatTurn {
  const catalogHash = hash(canonicalJsonString([]));
  const capabilityProfile = sealChatTurnCapabilityProfile({
    profileId: "profile-turn-1",
    schemaVersion: "chat.turn.capability-profile.v1",
    identity: {
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      citadelId: "default",
      operatorId: "operator",
      authActorId: "operator",
      authActorSource: "none",
    },
    source: { channel: "chat", account: "operator" },
    catalog: {
      snapshotId: "capability-catalog-turn-1",
      inspectableHash: catalogHash,
      callableHash: catalogHash,
      inspectableCount: 0,
      callableCount: 0,
    },
    selection: {
      contentHash: hash("Use the admitted source."),
      effectiveProviderId: "provider-1",
      effectiveModel: "model-1",
      allowedFallbacks: [],
      mode: "chat",
      webMode: "off",
      memory: {
        mode: "on",
        retrievalMode: "standard",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        contextManifestRef: `chat-memory-scope:${"d".repeat(64)}`,
        writeApprovalRequired: true,
      },
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "off",
      toolAutonomy: "manual",
      tools: [],
      modelNameAllowMap: [],
      trustedSkills: [],
    },
    governance: {
      activeGrants: [],
      permission: { profileId: "permission-1", approvalMode: "approve_all", profileHash: "e".repeat(64) },
      policyDecisions: [],
      authReadiness: [
        { kind: "provider", ref: "provider-1", status: "ready", reasonCodes: [] },
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
  const entries = [
    {
      index: 0,
      kind: "attachment" as const,
      ref: "attachment-secret-ref",
      label: "private-source-label",
      disposition: "included" as const,
      sourceScope: "workspace" as const,
      sourceWorkspaceId: "workspace-1",
      sourceVersion: `sha256:${"c".repeat(64)}`,
      sourceHash: "c".repeat(64),
      originalBytes: 18,
      originalTokens: 4,
      admittedBytes: 18,
      admittedTokens: 4,
      truncated: false,
      admittedText: "exact source bytes",
    },
  ];
  const contextText = renderChatRoutedContextEntries(entries);
  const routedContextSnapshot = sealChatRoutedContextSnapshot({
    snapshotId: "routed-snapshot-turn-1",
    schemaVersion: "chat.routed-context-snapshot.v1",
    turnId: "turn-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    capabilityProfileId: capabilityProfile.profileId,
    capabilityProfileHash: capabilityProfile.hashes.profileHash,
    sourceRequestHash: hash(canonicalJsonString(entries.map(({ kind, ref }) => ({ kind, ref })))),
    contentHash: hash(contextText),
    budget: {
      effectiveProviderId: "provider-1",
      effectiveModel: "model-1",
      contextWindowTokens: 16_384,
      promptReservedTokens: 4_000,
      outputReservedTokens: 4_096,
      hardCapTokens: 8_192,
      effectiveBudgetTokens: 8_192,
      usedTokens: 19,
      usedBytes: Buffer.byteLength(contextText, "utf8"),
      estimatorVersion: "gc-approx-tokens.v1",
      budgetPolicyVersion: "chat.routed-context-budget.v1",
    },
    entries,
    contextText,
    createdAt: "2026-07-13T00:00:00.000Z",
  });
  return {
    session: { sessionId: "session-1" },
    route: { channel: "chat", account: "operator" },
    workspaceId: "workspace-1",
    content: "Use the admitted source.",
    userEventId: "user-1",
    userMessage: {
      messageId: "user-1",
      sessionId: "session-1",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "Use the admitted source.",
      timestamp: "2026-07-13T00:00:00.000Z",
    },
    prefs: {
      mode: "chat",
      providerId: "provider-1",
      model: "model-1",
      webMode: "off",
      memoryMode: "on",
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "off",
      toolAutonomy: "manual",
    },
    autonomy: { retrievalMode: "standard" },
    normalized: { mode: "chat", webMode: "off", memoryMode: "on" },
    retrievalTrace: { l0Used: false, l1Used: false, l2Used: false },
    resolvedGuidance: { workspaceId: "workspace-1", files: [], truncated: false },
    conversationMessages: [],
    history: [
      { role: "system", content: "Base system prompt." },
      { role: "user", content: "Use the admitted source." },
    ],
    turnId: "turn-1",
    assistantMessageId: "assistant-1",
    branchKind: "append",
    effectiveToolAutonomy: "manual",
    capabilityProfile,
    capabilityCatalogSnapshot: {
      snapshotId: "capability-catalog-turn-1",
      inspectableEntries: [],
      callableEntries: [],
      createdAt: "2026-07-13T00:00:00.000Z",
    },
    routedContextSnapshot,
  } as PreparedAgentChatTurn & { routedContextSnapshot: ChatRoutedContextSnapshotRecord };
}

function buildReplayPrepared(profile: ChatTurnCapabilityProfileRecord): PreparedAgentChatTurn {
  const prepared = buildPrepared();
  prepared.capabilityProfile = profile;
  prepared.history = [
    { role: "system", content: "Base system prompt." },
    { role: "user", content: "Use the admitted source." },
  ];
  delete (prepared as PreparedAgentChatTurn & { routedContextSnapshot?: unknown }).routedContextSnapshot;
  return prepared;
}

function replayHost(
  run: DurableRunRecord,
  profile: ChatTurnCapabilityProfileRecord,
  trace: ChatTurnTraceRecord,
  prepareAgentChatTurn: ReturnType<typeof vi.fn>,
  getSnapshot: ReturnType<typeof vi.fn>,
) {
  return {
    storage: {
      chatMessages: {
        get: vi.fn(() => ({
          messageId: "user-1",
          sessionId: "session-1",
          role: "user",
          content: "Use the admitted source.",
        })),
      },
      chatTurnTraces: { get: vi.fn(() => trace) },
      routedContextSnapshots: { get: getSnapshot },
      chatTurnCapabilityProfiles: { get: vi.fn(() => profile), findByTurn: vi.fn() },
    },
    prepareAgentChatTurn,
    registerActiveChatTurnStream: vi.fn(() => ({
      registrationId: `stream-${run.runId}`,
      sessionId: "session-1",
      turnId: "turn-1",
      runId: run.runId,
    })),
    persistChatStreamChunk: vi.fn(),
    reconcileGeneralChatPostCommit: vi.fn(async () => true),
    reconcileAutonomousChatPostCommit: vi.fn(async () => true),
  };
}

function routedRequest(): ChatSendMessageRequest {
  return {
    content: "Use the admitted source.",
    contextRefs: [{ kind: "attachment", ref: "attachment-secret-ref", label: "private-source-label" }],
  } as ChatSendMessageRequest;
}

function minimalBeginDeps(createDurableRun: ReturnType<typeof vi.fn>): ChatDurableRunBeginDeps {
  return {
    shouldUseDurableExecution: true,
    runImmediateTransaction: (callback) => callback(),
    createDurableRun,
    buildDurablePayloadRecord: () => ({}),
    persistChatStreamChunk: vi.fn(),
    requestDurableRunProcessing: vi.fn(),
  };
}

function runFromCreate(input: DurableRunCreateRequest): DurableRunRecord {
  return {
    runId: input.runId ?? "generated-run",
    workflowKey: input.workflowKey,
    status: "queued",
    attemptCount: 0,
    maxAttempts: 3,
    version: 1,
    payload: input.payload,
    metadata: input.metadata ?? {},
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
