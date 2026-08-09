import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventIngestService, resolveSessionRoute } from "@goatcitadel/gateway-core";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import type { ChatMessageRecord, ChatSendMessageResponse } from "@goatcitadel/contracts";
import {
  InboundChannelEventService,
  InboundChannelTurnTerminalError,
  type InboundChannelDeterministicIdentity,
  type InboundChannelEventServiceDeps,
} from "./inbound-channel-event-service.js";
import type { DurableInboundChannelAcceptInput } from "./channel-inbound-dispatch.js";
import { ensureInboundIntegrationChatSession, type ChatSessionDependencies } from "./chat-session-service.js";
import { SharedHostLifecycleService } from "./shared-host-lifecycle-service.js";

describe("InboundChannelEventService", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
    vi.restoreAllMocks();
  });

  it("returns after durable acceptance while the model turn remains in flight", async () => {
    const response = deferred<ChatSendMessageResponse>();
    let responseIdentity!: InboundChannelDeterministicIdentity;
    const harness = await createHarness({
      respondToExistingChatMessage: vi.fn(async (_sessionId, _eventId, options) => {
        responseIdentity = options.inboundDurableIdentity;
        options.inboundDurableIdentity.onDurableRunLaunched?.(options.inboundDurableIdentity.durableRunId);
        return response.promise;
      }),
    });

    const accepted = await harness.service.accept(buildInput());

    expect(accepted).toMatchObject({ accepted: true, durableAccepted: true, replied: false, queued: true });
    expect(harness.storage.inboundChannelEvents.get(accepted.inboundEventId)).toBeDefined();
    await waitFor(() => harness.respondToExistingChatMessage.mock.calls.length === 1);
    expect(harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status).toBe("turn_admitted");

    response.resolve(buildResponse(responseIdentity));
    await waitFor(() => harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "completed");
  });

  it("parks approval-required agent turns without advancing to delivery", async () => {
    const respondToExistingChatMessage = vi.fn<InboundChannelEventServiceDeps["respondToExistingChatMessage"]>(
      async (_sessionId, _messageId, options) => {
        await options.inboundDurableIdentity.onDurableRunLaunched?.(options.inboundDurableIdentity.durableRunId);
        return {
          ...buildResponse(options.inboundDurableIdentity),
          trace: { status: "waiting_for_approval" } as ChatSendMessageResponse["trace"],
        };
      },
    );
    const harness = await createHarness({ respondToExistingChatMessage });

    const accepted = await harness.service.accept(buildInput());
    await waitFor(() => harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "waiting");

    expect(harness.storage.inboundChannelEvents.get(accepted.inboundEventId)).toMatchObject({
      status: "waiting",
      attemptCount: 1,
      turnId: expect.stringMatching(/^inbound-turn-/),
      durableRunId: expect.stringMatching(/^inbound-run-/),
      deliveryId: undefined,
      providerMessageId: undefined,
    });
    expect(respondToExistingChatMessage).toHaveBeenCalledTimes(1);
  });

  it("initializes the first Discord route as canonical Chat state before turn admission", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "discord-inbound-session-"));
    const rawStorage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    const storage = createSqliteAsyncStorage(rawStorage);
    const services: InboundChannelEventService[] = [];
    const tasks = new Set<Promise<void>>();
    cleanups.push(async () => {
      services.forEach((item) => item.close());
      await Promise.allSettled([...tasks]);
      await storage.close();
      await rm(root, { recursive: true, force: true });
    });
    const connection = await storage.integrationConnections.create({
      catalogId: "channel.discord",
      kind: "channel",
      key: "discord",
      label: "Discord",
      enabled: true,
      status: "connected",
      workspaceId: "workspace-a",
      config: {},
    });
    const eventIngest = new EventIngestService(storage);
    const runtimeGrants = vi.fn(async () => undefined);
    const chatDeps: ChatSessionDependencies = {
      storage,
      operatorSummaryCache: { invalidate: vi.fn() },
      normalizeWorkspaceId: (workspaceId) => workspaceId?.trim() || "default",
      ensureChatSessionRuntimeGrants: runtimeGrants,
      requireChatSession: async () => {
        throw new Error("not used by inbound binding initialization");
      },
      getSession: async (sessionId) => storage.sessions.getBySessionId(sessionId),
      publishRealtime: vi.fn(async () => undefined),
      clearChatTurnWriteLease: vi.fn(),
      removeChatSessionStoredFile: vi.fn(async () => undefined),
      copyChatSessionStoredFile: vi.fn(async (storageRelPath) => storageRelPath),
      ensureChatSessionModelDefaults: (_sessionId, prefs) => prefs,
      hydrateChatPrefsWithAutonomy: async (_sessionId, prefs) => prefs,
      patchSessionAutonomyPrefs: vi.fn(async () => undefined),
    };
    const respondToExistingChatMessage = vi.fn<InboundChannelEventServiceDeps["respondToExistingChatMessage"]>(
      async (sessionId, _messageId, options) => {
        expect(await storage.chatSessionMeta.get(sessionId)).toMatchObject({ workspaceId: "workspace-a" });
        expect(await storage.chatSessionPrefs.get(sessionId)).toBeDefined();
        expect(await storage.chatSessionBindings.get(sessionId)).toMatchObject({
          transport: "integration",
          connectionId: connection.connectionId,
          target: "discord-channel-1",
          writable: true,
        });
        options.inboundDurableIdentity.onDurableRunLaunched?.(options.inboundDurableIdentity.durableRunId);
        options.inboundDurableIdentity.onDeliveryEnqueued?.({
          deliveryId: "discord-delivery-1",
          providerMessageId: "discord-reply-1",
          idempotencyKey: options.inboundDurableIdentity.deliveryIdempotencyKey,
        });
        return buildResponse(options.inboundDurableIdentity, sessionId);
      },
    );
    const service = new InboundChannelEventService({
      storage,
      ownerId: "discord-test-worker",
      isClosing: () => false,
      registerBackgroundTask: (task) => {
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      },
      getIntegrationConnection: async (connectionId) => storage.integrationConnections.get(connectionId),
      ensureInboundChatSession: async (input) => await ensureInboundIntegrationChatSession(chatDeps, input),
      ingestChannelMessage: async (channel, idempotencyKey, message) => {
        const resolution = resolveSessionRoute({
          channel,
          account: message.account,
          peer: message.peer,
          room: message.room,
          threadId: message.threadId,
        });
        expect(await storage.chatSessionMeta.get(resolution.sessionId)).toMatchObject({ workspaceId: "workspace-a" });
        expect(await storage.chatSessionPrefs.get(resolution.sessionId)).toBeDefined();
        expect(
          (await storage.chatSessionBindings.listBySessionIds([resolution.sessionId], "workspace-a")).get(
            resolution.sessionId,
          ),
        ).toMatchObject({
          transport: "integration",
          connectionId: connection.connectionId,
          target: "discord-channel-1",
          writable: true,
        });
        return await eventIngest.ingest({
          endpoint: "/api/v1/gateway/events",
          idempotencyKey,
          sourceAuthority: "external_channel",
          payload: {
            eventId: message.eventId,
            route: {
              channel,
              account: message.account,
              peer: message.peer,
              room: message.room,
              threadId: message.threadId,
            },
            actor: { type: message.actorType ?? "user", id: message.actorId },
            message: { role: "user", content: message.content },
          },
        });
      },
      hasRunningTurn: async () => false,
      respondToExistingChatMessage,
      transcribeChannelVoice: vi.fn(async () => ({ ok: false as const, reason: "transcription_failed" })),
      executeInboundCommand: vi.fn(async () => ({ resultText: "Command completed." })),
      decideBotLoop: () => ({ action: "allow" }),
      emitChannelActivity: vi.fn(async () => undefined),
      recordDevDiagnostic: vi.fn(),
    });
    services.push(service);

    const accepted = await service.accept({
      channel: "discord",
      connectionId: connection.connectionId,
      idempotencyKey: "discord:message:first",
      eventType: "discord-gateway-message",
      bindingTarget: "discord-channel-1",
      dispatchKind: "agent_turn",
      message: {
        eventId: "discord-message-1",
        account: connection.connectionId,
        room: "discord-channel-1",
        actorId: "discord-user-1",
        actorType: "user",
        content: "hello from Discord",
      },
    });

    await waitFor(() => {
      const status = rawStorage.inboundChannelEvents.get(accepted.inboundEventId)?.status;
      return status === "completed" || status === "retry_wait" || status === "failed";
    });
    const event = rawStorage.inboundChannelEvents.get(accepted.inboundEventId);
    expect(event).toMatchObject({
      status: "completed",
      attemptCount: 1,
      sessionId: expect.stringMatching(/^sess_/),
      durableRunId: expect.stringMatching(/^inbound-run-/),
      deliveryId: "discord-delivery-1",
      providerMessageId: "discord-reply-1",
      lastError: undefined,
    });
    const bindingWorkspace = rawStorage.db
      .prepare("SELECT workspace_id FROM chat_session_bindings WHERE session_id = ?")
      .get(event?.sessionId) as { workspace_id: string } | undefined;
    expect(bindingWorkspace?.workspace_id).toBe("workspace-a");
    expect(respondToExistingChatMessage).toHaveBeenCalledTimes(1);
    expect(runtimeGrants).toHaveBeenCalledTimes(1);
  });

  it("does not recover or claim inbound work after shared-host admission closes", async () => {
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    await lifecycle.drain({
      mode: "graceful",
      reason: "test",
      actorId: "test",
      timeoutMs: 10,
    });
    const harness = await createHarness({ sharedHostLifecycle: lifecycle });
    const recover = vi.spyOn(harness.storage.inboundChannelEvents, "recoverExpiredClaims");
    const claim = vi.spyOn(harness.storage.inboundChannelEvents, "claimDue");

    await harness.service.drain();

    expect(recover).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(lifecycle.snapshot()).toMatchObject({ state: "quiesced", activeCount: 0 });
  });

  it("dedupes concurrent callbacks into one claim and one deterministic turn", async () => {
    const response = deferred<ChatSendMessageResponse>();
    let responseIdentity!: InboundChannelDeterministicIdentity;
    const harness = await createHarness({
      respondToExistingChatMessage: vi.fn(async (_sessionId, _eventId, options) => {
        responseIdentity = options.inboundDurableIdentity;
        options.inboundDurableIdentity.onDurableRunLaunched?.(options.inboundDurableIdentity.durableRunId);
        return response.promise;
      }),
    });

    const [first, duplicate] = await Promise.all([
      harness.service.accept(buildInput()),
      harness.service.accept(buildInput()),
    ]);
    expect(first.inboundEventId).toBe(duplicate.inboundEventId);
    expect([first.deduped, duplicate.deduped].sort()).toEqual([false, true]);
    await waitFor(() => harness.respondToExistingChatMessage.mock.calls.length === 1);
    response.resolve(buildResponse(responseIdentity));
    await waitFor(() => harness.storage.inboundChannelEvents.get(first.inboundEventId)?.status === "completed");
    expect(harness.ingestChannelMessage).toHaveBeenCalledTimes(1);
    expect(harness.respondToExistingChatMessage).toHaveBeenCalledTimes(1);
  });

  it("fails closed when one provider identity is reused with different content", async () => {
    const harness = await createHarness({ hasRunningTurn: () => true });
    await harness.service.accept(buildInput());

    await expect(
      harness.service.accept(
        buildInput({
          message: { ...buildInput().message, content: "different content" },
        }),
      ),
    ).rejects.toThrow("different normalized payload");
  });

  it("atomically accepts every event in a provider batch before scheduling work", async () => {
    const harness = await createHarness({ hasRunningTurn: () => true });
    const second = buildInput({
      idempotencyKey: "telegram:update-2",
      message: { ...buildInput().message, eventId: "provider-message-2", content: "second message" },
    });

    const results = await harness.service.acceptMany([buildInput(), second]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.durableAccepted)).toBe(true);
    expect(
      harness.storage.inboundChannelEvents.getByIdentity({
        channelKey: "telegram",
        connectionId: "connection-1",
        idempotencyKey: "telegram:update-1",
      }),
    ).toBeDefined();
    expect(
      harness.storage.inboundChannelEvents.getByIdentity({
        channelKey: "telegram",
        connectionId: "connection-1",
        idempotencyKey: "telegram:update-2",
      }),
    ).toBeDefined();
  });

  it("rolls back a whole provider batch when any duplicate has conflicting content", async () => {
    const harness = await createHarness({ hasRunningTurn: () => true });
    await harness.service.accept(buildInput());
    const newEvent = buildInput({
      idempotencyKey: "telegram:update-new",
      message: { ...buildInput().message, eventId: "provider-message-new" },
    });
    const conflict = buildInput({
      message: { ...buildInput().message, content: "conflicting replay" },
    });

    await expect(harness.service.acceptMany([newEvent, conflict])).rejects.toThrow("different normalized payload");
    expect(
      harness.storage.inboundChannelEvents.getByIdentity({
        channelKey: "telegram",
        connectionId: "connection-1",
        idempotencyKey: "telegram:update-new",
      }),
    ).toBeUndefined();
  });

  it("recovers a message-recorded event after restart without duplicating its turn", async () => {
    let running = true;
    const ingest = vi
      .fn<InboundChannelEventServiceDeps["ingestChannelMessage"]>()
      .mockResolvedValueOnce({ deduped: false, session: { sessionId: "session-1", sessionKey: "channel:test" } })
      .mockResolvedValue({ deduped: true, session: { sessionId: "session-1", sessionKey: "channel:test" } });
    const respond = vi.fn(async (_sessionId, _eventId, options) => {
      options.inboundDurableIdentity.onDurableRunLaunched?.(options.inboundDurableIdentity.durableRunId);
      options.inboundDurableIdentity.onDeliveryEnqueued?.({
        deliveryId: "delivery-1",
        idempotencyKey: options.inboundDurableIdentity.deliveryIdempotencyKey,
      });
      return buildResponse(options.inboundDurableIdentity);
    });
    const first = await createHarness({
      ingestChannelMessage: ingest,
      hasRunningTurn: () => running,
      respondToExistingChatMessage: respond,
    });
    const accepted = await first.service.accept(buildInput());
    await waitFor(() => first.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "retry_wait");
    expect(first.storage.inboundChannelEvents.get(accepted.inboundEventId)).toMatchObject({
      messageId: expect.stringMatching(/^inbound-message-/),
      sessionId: "session-1",
    });
    first.service.close();

    first.storage.db
      .prepare("UPDATE inbound_channel_events SET next_attempt_at = ? WHERE event_id = ?")
      .run(new Date(0).toISOString(), accepted.inboundEventId);
    running = false;
    const second = first.createAdditionalService();
    await second.drain();
    await waitFor(() => first.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "completed");

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(first.storage.inboundChannelEvents.get(accepted.inboundEventId)).toMatchObject({
      durableRunId: expect.stringMatching(/^inbound-run-/),
      deliveryId: "delivery-1",
    });
  });

  it("charges the bot-loop guard once across repeated active-turn retries", async () => {
    let running = true;
    const decideBotLoop = vi.fn(() => ({ action: "allow" as const }));
    const harness = await createHarness({
      hasRunningTurn: () => running,
      decideBotLoop,
    });
    const accepted = await harness.service.accept(buildInput());
    await waitFor(() => harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "retry_wait");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      harness.storage.db
        .prepare("UPDATE inbound_channel_events SET next_attempt_at = ? WHERE event_id = ?")
        .run(new Date(0).toISOString(), accepted.inboundEventId);
      await harness.service.drain();
      await waitFor(() => harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "retry_wait");
    }

    expect(decideBotLoop).toHaveBeenCalledTimes(1);
    expect(harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.botLoopDecision).toBe("allow");
    running = false;
    harness.storage.db
      .prepare("UPDATE inbound_channel_events SET next_attempt_at = ? WHERE event_id = ?")
      .run(new Date(0).toISOString(), accepted.inboundEventId);
    await harness.service.drain();
    await waitFor(() => harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "completed");
    expect(decideBotLoop).toHaveBeenCalledTimes(1);
  });

  it("recovers an incomplete durable bot-loop evaluation after restart without recharging the guard", async () => {
    const decideBotLoop = vi.fn(() => {
      throw new Error("worker crashed during guard evaluation");
    });
    const first = await createHarness({ decideBotLoop });
    const accepted = await first.service.accept(buildInput());
    await waitFor(() => first.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "retry_wait");
    expect(first.storage.inboundChannelEvents.get(accepted.inboundEventId)?.botLoopDecision).toBe("evaluating");
    expect(decideBotLoop).toHaveBeenCalledTimes(1);
    first.service.close();

    first.storage.db
      .prepare("UPDATE inbound_channel_events SET next_attempt_at = ? WHERE event_id = ?")
      .run(new Date(0).toISOString(), accepted.inboundEventId);
    const restarted = first.createAdditionalService();
    await restarted.drain();
    await waitFor(() => first.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "completed");

    expect(decideBotLoop).toHaveBeenCalledTimes(1);
    expect(first.storage.inboundChannelEvents.get(accepted.inboundEventId)).toMatchObject({
      botLoopDecision: "allow",
      botLoopReason: "recovered_incomplete_evaluation",
    });
  });

  it("persists a secret-free voice reference and transcribes it exactly once across duplicate callbacks", async () => {
    const transcribe = vi.fn(async () => ({ ok: true as const, transcript: "remember the rent" }));
    const harness = await createHarness({ transcribeChannelVoice: transcribe });
    const input = buildInput({
      dispatchKind: "voice_agent_turn",
      voiceRequest: {
        channel: "telegram",
        connectionConfig: { botToken: "must-not-persist" },
        fileId: "voice-file-1",
        mimeType: "audio/ogg",
      },
      voiceFallbackContent: "[telegram voice message]",
      message: {
        ...buildInput().message,
        metadata: { safe: "kept", authorization: "Bearer must-not-persist", token: "must-not-persist" },
      },
    });

    const [first, duplicate] = await Promise.all([harness.service.accept(input), harness.service.accept(input)]);
    await waitFor(() => harness.storage.inboundChannelEvents.get(first.inboundEventId)?.status === "completed");

    expect(duplicate.deduped).toBe(true);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(harness.ingestChannelMessage).toHaveBeenCalledWith(
      "telegram",
      first.inboundEventId,
      expect.objectContaining({ content: expect.stringContaining("remember the rent") }),
    );
    const persisted = JSON.stringify(harness.storage.inboundChannelEvents.get(first.inboundEventId)?.payload);
    expect(persisted).not.toContain("must-not-persist");
    expect(persisted).toContain("voice-file-1");
  });

  it("terminalizes post-send ambiguity for manual reconciliation without replay", async () => {
    const emitChannelActivity = vi.fn(async () => undefined);
    const respond = vi.fn(async (_sessionId, _eventId, options) => {
      options.inboundDurableIdentity.onDurableRunLaunched?.(options.inboundDurableIdentity.durableRunId);
      throw Object.assign(new Error("provider may have accepted the reply"), {
        name: "IntegrationDeliveryPostCommitError",
        mutationCommitted: true,
      });
    });
    const harness = await createHarness({ respondToExistingChatMessage: respond, emitChannelActivity });
    const accepted = await harness.service.accept(buildInput());
    await waitFor(
      () =>
        harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "manual_reconciliation_required",
    );

    await harness.service.drain();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.reconciliationReason).toContain(
      "provider boundary",
    );
    expect(emitChannelActivity).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "failed" }));
  });

  it("retains thinking during retry wait and emits failed after exhausting retries", async () => {
    const emitChannelActivity = vi.fn(async () => undefined);
    const respond = vi.fn(async () => {
      throw new Error("model boundary unavailable");
    });
    const harness = await createHarness({ respondToExistingChatMessage: respond, emitChannelActivity });
    const accepted = await harness.service.accept(buildInput());
    await waitFor(() => harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "retry_wait");

    expect(emitChannelActivity.mock.calls.map(([activity]) => activity.phase)).toEqual(["seen", "thinking"]);
    expect(harness.storage.inboundChannelEvents.get(accepted.inboundEventId)).toMatchObject({
      status: "retry_wait",
      attemptCount: 1,
    });

    harness.service.close();
    harness.storage.db
      .prepare("UPDATE inbound_channel_events SET attempt_count = 7, next_attempt_at = ? WHERE event_id = ?")
      .run(new Date(0).toISOString(), accepted.inboundEventId);
    const restarted = harness.createAdditionalService();
    await restarted.drain();
    await waitFor(() => harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "failed");

    expect(harness.storage.inboundChannelEvents.get(accepted.inboundEventId)).toMatchObject({
      status: "failed",
      attemptCount: 8,
      lastError: "model boundary unavailable",
    });
    expect(emitChannelActivity.mock.calls.filter(([activity]) => activity.phase === "failed")).toHaveLength(1);
    expect(emitChannelActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "failed",
        messageId: "provider-message-1",
        sessionId: "session-1",
        target: "chat-1",
        correlationId: buildInput().idempotencyKey,
      }),
    );
  });

  it("terminalizes a non-replayable pre-bind turn failure on its first attempt", async () => {
    const emitChannelActivity = vi.fn(async () => undefined);
    const harness = await createHarness({
      emitChannelActivity,
      respondToExistingChatMessage: vi.fn(async () => {
        throw new InboundChannelTurnTerminalError("pre-durable authority was closed");
      }),
    });
    const accepted = await harness.service.accept(buildInput());
    await waitFor(() => harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "failed");

    expect(harness.storage.inboundChannelEvents.get(accepted.inboundEventId)).toMatchObject({
      status: "failed",
      attemptCount: 1,
      lastError: "pre-durable authority was closed",
    });
    expect(emitChannelActivity).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "failed" }));
  });

  it("records generic signed inbound events without launching an agent turn", async () => {
    const harness = await createHarness();
    const accepted = await harness.service.accept(buildInput({ dispatchKind: "record_only" }));
    await waitFor(() => harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "completed");

    expect(harness.ingestChannelMessage).toHaveBeenCalledTimes(1);
    expect(harness.respondToExistingChatMessage).not.toHaveBeenCalled();
  });

  it("settles a durable command once and replays its persisted response to duplicate callbacks", async () => {
    const executeInboundCommand = vi.fn(async () => ({ resultText: "Command completed once." }));
    const harness = await createHarness({ executeInboundCommand });
    const input = buildInput({ dispatchKind: "command", eventType: "discord-gateway-slash-command" });

    const accepted = await harness.service.accept(input);
    const result = await harness.service.awaitCommandResult(accepted.inboundEventId, { timeoutMs: 5_000 });
    expect(result).toEqual({ status: "completed", resultText: "Command completed once." });
    expect(executeInboundCommand).toHaveBeenCalledTimes(1);
    expect(executeInboundCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        inboundEventId: accepted.inboundEventId,
        operationKey: input.idempotencyKey,
        idempotencyKey: input.idempotencyKey,
        eventType: "discord-gateway-slash-command",
      }),
    );

    const duplicate = await harness.service.accept(input);
    expect(duplicate).toMatchObject({
      deduped: true,
      queued: false,
      commandResultText: "Command completed once.",
    });
    expect(await harness.service.awaitCommandResult(duplicate.inboundEventId)).toEqual(result);
    expect(executeInboundCommand).toHaveBeenCalledTimes(1);
  });

  it("preserves opaque approval linkage while dropping bearer-shaped metadata before persistence", async () => {
    const executeInboundCommand = vi.fn(async () => ({ resultText: "Approved approval-1." }));
    const harness = await createHarness({ executeInboundCommand });
    const base = buildInput({ dispatchKind: "command", eventType: "telegram-approval-callback" });
    const input: DurableInboundChannelAcceptInput = {
      ...base,
      message: {
        ...base.message,
        content: "/approve",
        metadata: {
          approvalActionId: "opaque-action-1",
          approvalDecision: "approve",
          callbackData: "gca:grat_secret:a",
          callbackQueryId: "callback-ephemeral-1",
          reply_token: "line-reply-capability",
          interactionToken: "discord-interaction-capability",
          response_url: "https://hooks.example.invalid/respond?token=reply-capability",
        },
      },
    };

    const accepted = await harness.service.accept(input);
    expect(await harness.service.awaitCommandResult(accepted.inboundEventId, { timeoutMs: 5_000 })).toEqual({
      status: "completed",
      resultText: "Approved approval-1.",
    });
    const executionInput = executeInboundCommand.mock.calls[0]?.[0];
    expect(executionInput?.message.metadata).toEqual({
      approvalActionId: "opaque-action-1",
      approvalDecision: "approve",
    });
    const stored = harness.storage.inboundChannelEvents.get(accepted.inboundEventId);
    expect(JSON.stringify(stored?.payload)).not.toContain("grat_secret");
    expect(JSON.stringify(stored?.payload)).not.toContain("callback-ephemeral-1");
    expect(JSON.stringify(stored?.payload)).not.toContain("line-reply-capability");
    expect(JSON.stringify(stored?.payload)).not.toContain("discord-interaction-capability");
    expect(JSON.stringify(stored?.payload)).not.toContain("hooks.example.invalid");
  });

  it("rejects raw approval bearer commands before the durable boundary", async () => {
    const harness = await createHarness();
    const base = buildInput({ dispatchKind: "command", eventType: "telegram-channel-command" });

    await expect(
      harness.service.accept({
        ...base,
        message: { ...base.message, content: "/approve grat_secret" },
      }),
    ).rejects.toThrow("converted to opaque action ids");
    expect(harness.storage.inboundChannelEvents.listDue()).toHaveLength(0);
  });

  it("rejects raw approval bearers even when an adapter misclassifies the dispatch kind", async () => {
    const harness = await createHarness();
    const cases: Array<{
      channel: "telegram" | "discord";
      dispatchKind: DurableInboundChannelAcceptInput["dispatchKind"];
      content: string;
    }> = [
      { channel: "telegram", dispatchKind: "agent_turn", content: "/approve grat_wrong_kind" },
      { channel: "discord", dispatchKind: "record_only", content: "/deny grat_wrong_kind" },
      { channel: "discord", dispatchKind: "voice_agent_turn", content: "/reject grat_wrong_kind" },
    ];

    for (const [index, item] of cases.entries()) {
      await expect(
        harness.service.accept({
          ...buildInput(),
          ...item,
          idempotencyKey: `${item.channel}:wrong-kind-${index}`,
          message: { ...buildInput().message, content: item.content },
        }),
      ).rejects.toThrow("converted to opaque action ids");
    }
    expect(harness.storage.inboundChannelEvents.listDue()).toHaveLength(0);
  });

  it("terminalizes a command callback failure for manual reconciliation and never replays it", async () => {
    const executeInboundCommand = vi.fn(async () => {
      throw new Error("command handler failed after boundary");
    });
    const harness = await createHarness({ executeInboundCommand });
    const input = buildInput({ dispatchKind: "command", eventType: "telegram-channel-command" });
    const accepted = await harness.service.accept(input);
    const result = await harness.service.awaitCommandResult(accepted.inboundEventId, { timeoutMs: 5_000 });

    expect(result).toMatchObject({ status: "manual_reconciliation_required" });
    expect(harness.storage.inboundChannelEvents.get(accepted.inboundEventId)).toMatchObject({
      status: "manual_reconciliation_required",
      commandOperationKey: input.idempotencyKey,
      lastError: "command handler failed after boundary",
    });
    await harness.service.accept(input);
    await harness.service.drain();
    expect(executeInboundCommand).toHaveBeenCalledTimes(1);
  });

  it("redacts provider capabilities from persisted settlement errors", async () => {
    const approvalBearer = `grat_${"a".repeat(43)}`;
    const authorizationBearer = "abcDEF-._~+/==";
    const responseCapability = "signed-response-capability";
    const executeInboundCommand = vi.fn(async () => {
      throw new Error(
        [
          `delivery failed Authorization: Bearer ${authorizationBearer}`,
          `response_url=https://hooks.example.invalid/respond?token=${responseCapability}`,
          `approval=${approvalBearer}`,
        ].join(" "),
      );
    });
    const harness = await createHarness({ executeInboundCommand });
    const accepted = await harness.service.accept(buildInput({ dispatchKind: "command" }));

    const result = await harness.service.awaitCommandResult(accepted.inboundEventId, { timeoutMs: 5_000 });
    const stored = harness.storage.inboundChannelEvents.get(accepted.inboundEventId);
    const persistedEvidence = JSON.stringify({ result, lastError: stored?.lastError });
    expect(persistedEvidence).toContain("[REDACTED]");
    expect(persistedEvidence).not.toContain(authorizationBearer);
    expect(persistedEvidence).not.toContain(responseCapability);
    expect(persistedEvidence).not.toContain(approvalBearer);
  });

  it("terminalizes an expired command-execution lease instead of replaying an ambiguous side effect", async () => {
    const command = deferred<{ resultText: string }>();
    const executeInboundCommand = vi.fn(async () => command.promise);
    const harness = await createHarness({ executeInboundCommand });
    const accepted = await harness.service.accept(buildInput({ dispatchKind: "command" }));
    await waitFor(
      () => harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "command_execution_started",
    );

    harness.service.close();
    harness.storage.db
      .prepare("UPDATE inbound_channel_events SET claim_expires_at = ? WHERE event_id = ?")
      .run(new Date(0).toISOString(), accepted.inboundEventId);
    expect(harness.storage.inboundChannelEvents.recoverExpiredClaims()).toBe(1);
    expect(harness.storage.inboundChannelEvents.get(accepted.inboundEventId)).toMatchObject({
      status: "manual_reconciliation_required",
      reconciliationReason: expect.stringContaining("automatic replay is unsafe"),
    });

    command.resolve({ resultText: "possibly applied" });
    await waitFor(() => harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.claimToken === undefined);
    const restarted = harness.createAdditionalService();
    await restarted.drain();
    expect(executeInboundCommand).toHaveBeenCalledTimes(1);
  });

  it("restarts an expired message-recorded command and crosses the execution boundary exactly once", async () => {
    const ingestChannelMessage = vi.fn(async () => ({
      deduped: true,
      session: { sessionId: "session-1", sessionKey: "channel:test" },
    }));
    const executeInboundCommand = vi.fn(async () => ({ resultText: "Recovered before boundary." }));
    const harness = await createHarness({ ingestChannelMessage, executeInboundCommand });
    const input = buildInput({ dispatchKind: "command", eventType: "telegram-channel-command" });
    const eventId = "command-crash-before-boundary";
    const messageId = `inbound-message-${createHash("sha256").update(eventId).digest("hex").slice(0, 32)}`;
    const baseMs = Date.now() - 10_000;
    const acceptedAt = new Date(baseMs).toISOString();
    const claimedAt = new Date(baseMs + 100).toISOString();
    const recordedAt = new Date(baseMs + 200).toISOString();
    const recoveredAt = new Date(baseMs + 2_000).toISOString();

    harness.storage.inboundChannelEvents.accept(
      {
        eventId,
        channelKey: input.channel,
        connectionId: input.connectionId,
        transport: "provider_webhook",
        dispatchKind: "command",
        providerSourceId: input.message.eventId,
        idempotencyKey: input.idempotencyKey,
        laneKey: "telegram:connection-1:chat-1",
        payload: {
          eventType: input.eventType,
          bindingTarget: input.bindingTarget,
          message: input.message,
          responseOptions: input.responseOptions,
        },
      },
      acceptedAt,
    );
    const [crashedClaim] = harness.storage.inboundChannelEvents.claimDue({
      ownerId: "crashed-worker",
      leaseDurationMs: 1_000,
      now: claimedAt,
    });
    expect(crashedClaim).toBeDefined();
    harness.storage.inboundChannelEvents.transitionClaimed(
      crashedClaim!,
      {
        status: "message_recorded",
        linkage: { sessionId: "session-1", sessionKey: "channel:test", messageId },
      },
      recordedAt,
    );
    expect(harness.storage.inboundChannelEvents.recoverExpiredClaims({ now: recoveredAt })).toBe(1);
    expect(harness.storage.inboundChannelEvents.get(eventId)).toMatchObject({
      status: "retry_wait",
      messageId,
      commandOperationKey: undefined,
    });

    harness.service.close();
    const restarted = harness.createAdditionalService();
    await restarted.drain();
    expect(await restarted.awaitCommandResult(eventId, { timeoutMs: 5_000 })).toEqual({
      status: "completed",
      resultText: "Recovered before boundary.",
    });
    expect(ingestChannelMessage).toHaveBeenCalledTimes(1);
    expect(executeInboundCommand).toHaveBeenCalledTimes(1);
    expect(harness.storage.inboundChannelEvents.get(eventId)).toMatchObject({
      status: "completed",
      commandOperationKey: input.idempotencyKey,
      commandResultText: "Recovered before boundary.",
    });
  });

  it("retries a command failure before the execution boundary and then executes it once", async () => {
    const ingest = vi
      .fn<InboundChannelEventServiceDeps["ingestChannelMessage"]>()
      .mockRejectedValueOnce(new Error("storage temporarily unavailable"))
      .mockResolvedValue({ deduped: false, session: { sessionId: "session-1", sessionKey: "channel:test" } });
    const executeInboundCommand = vi.fn(async () => ({ resultText: "Recovered command." }));
    const harness = await createHarness({ ingestChannelMessage: ingest, executeInboundCommand });
    const accepted = await harness.service.accept(buildInput({ dispatchKind: "command" }));
    await waitFor(() => harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "retry_wait");
    expect(executeInboundCommand).not.toHaveBeenCalled();

    harness.storage.db
      .prepare("UPDATE inbound_channel_events SET next_attempt_at = ? WHERE event_id = ?")
      .run(new Date(0).toISOString(), accepted.inboundEventId);
    await harness.service.drain();
    expect(await harness.service.awaitCommandResult(accepted.inboundEventId, { timeoutMs: 5_000 })).toEqual({
      status: "completed",
      resultText: "Recovered command.",
    });
    expect(executeInboundCommand).toHaveBeenCalledTimes(1);
  });

  async function createHarness(overrides: Partial<InboundChannelEventServiceDeps> = {}): Promise<{
    storage: Storage;
    service: InboundChannelEventService;
    createAdditionalService: () => InboundChannelEventService;
    ingestChannelMessage: ReturnType<typeof vi.fn<InboundChannelEventServiceDeps["ingestChannelMessage"]>>;
    respondToExistingChatMessage: ReturnType<
      typeof vi.fn<InboundChannelEventServiceDeps["respondToExistingChatMessage"]>
    >;
  }> {
    const root = await mkdtemp(path.join(tmpdir(), "inbound-channel-events-"));
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    const tasks = new Set<Promise<void>>();
    const services: InboundChannelEventService[] = [];
    const ingestChannelMessage =
      (overrides.ingestChannelMessage as ReturnType<
        typeof vi.fn<InboundChannelEventServiceDeps["ingestChannelMessage"]>
      >) ??
      vi.fn(async () => ({
        deduped: false,
        session: { sessionId: "session-1", sessionKey: "channel:test" },
      }));
    const respondToExistingChatMessage =
      (overrides.respondToExistingChatMessage as ReturnType<
        typeof vi.fn<InboundChannelEventServiceDeps["respondToExistingChatMessage"]>
      >) ??
      vi.fn(async (_sessionId, _eventId, options) => {
        options.inboundDurableIdentity.onDurableRunLaunched?.(options.inboundDurableIdentity.durableRunId);
        options.inboundDurableIdentity.onDeliveryEnqueued?.({
          deliveryId: "delivery-1",
          providerMessageId: "provider-message-1",
          idempotencyKey: options.inboundDurableIdentity.deliveryIdempotencyKey,
        });
        return buildResponse(options.inboundDurableIdentity);
      });
    const baseDeps: InboundChannelEventServiceDeps = {
      ownerId: "test-worker",
      isClosing: () => false,
      registerBackgroundTask: (task) => {
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      },
      getIntegrationConnection: () => ({ key: "telegram", enabled: true, status: "connected", config: {} }),
      ensureInboundChatSession: vi.fn(async () => ({
        sessionId: "session-1",
        sessionKey: "channel:test",
      })),
      hasRunningTurn: () => false,
      transcribeChannelVoice: vi.fn(async () => ({ ok: false as const, reason: "transcription_failed" })),
      executeInboundCommand: vi.fn(async () => ({ resultText: "Command completed." })),
      decideBotLoop: () => ({ action: "allow" }),
      emitChannelActivity: vi.fn(async () => undefined),
      recordDevDiagnostic: vi.fn(),
      ...overrides,
      storage,
      ingestChannelMessage,
      respondToExistingChatMessage,
    };
    const createAdditionalService = () => {
      const service = new InboundChannelEventService({
        ...baseDeps,
        ownerId: `test-worker-${services.length + 1}`,
      });
      services.push(service);
      return service;
    };
    const service = createAdditionalService();
    cleanups.push(async () => {
      services.forEach((item) => item.close());
      await Promise.allSettled([...tasks]);
      storage.close();
      await rm(root, { recursive: true, force: true });
    });
    return {
      storage,
      service,
      createAdditionalService,
      ingestChannelMessage,
      respondToExistingChatMessage,
    };
  }
});

function buildInput(overrides: Partial<DurableInboundChannelAcceptInput> = {}): DurableInboundChannelAcceptInput {
  return {
    channel: "telegram",
    connectionId: "connection-1",
    idempotencyKey: "telegram:update-1",
    eventType: "message",
    bindingTarget: "chat-1",
    inboundAccessConfig: { inboundAccessMode: "allowlist" },
    allowedSenders: ["user-1"],
    dispatchKind: "agent_turn",
    message: {
      eventId: "provider-message-1",
      account: "bot-1",
      peer: "user-1",
      room: "chat-1",
      actorId: "user-1",
      actorType: "user",
      content: "hello durable world",
    },
    responseOptions: { deliveryReplyToMessageId: "provider-message-1" },
    ...overrides,
  };
}

function buildResponse(
  identity: InboundChannelDeterministicIdentity,
  sessionId = "session-1",
): ChatSendMessageResponse {
  const now = new Date().toISOString();
  const userMessage: ChatMessageRecord = {
    messageId: identity.userMessageId,
    sessionId,
    role: "user",
    actorType: "user",
    actorId: "user-1",
    content: "hello durable world",
    timestamp: now,
  };
  return {
    sessionId,
    userMessage,
    assistantMessage: {
      messageId: identity.assistantMessageId,
      sessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: "hello back",
      timestamp: now,
    },
    transport: "integration",
    turnId: identity.turnId,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for inbound channel test condition.");
}
