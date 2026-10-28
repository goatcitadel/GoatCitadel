import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventIngestService, resolveSessionRoute } from "@goatcitadel/gateway-core";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { CHANNEL_INGRESS_ACCEPTED_REVISION_KEY, NotFoundError } from "@goatcitadel/contracts";
import type {
  ChatChannelConversation,
  ChatMessageRecord,
  ChatSendMessageResponse,
  ChatSessionBindingRecord,
} from "@goatcitadel/contracts";
import {
  acceptOperatorDeskTurn,
  buildOperatorDeskGatewayEvent,
  recordInboundChannelMessage,
} from "./channel-desk-turn.js";
import { GatewayService } from "./gateway-service.js";
import {
  InboundChannelEventService,
  InboundChannelTurnTerminalError,
  type InboundChannelDeterministicIdentity,
  type InboundChannelEventServiceDeps,
} from "./inbound-channel-event-service.js";
import {
  VOICE_TRANSCRIPT_CONTENT_PREFIX,
  type DurableInboundChannelAcceptInput,
  type IngestChannelMessageInput,
} from "./channel-inbound-dispatch.js";
import {
  ensureInboundIntegrationChatSession,
  findChatSessionBinding,
  setChatSessionBinding,
  type ChatSessionDependencies,
} from "./chat-session-service.js";
import { SharedHostLifecycleService } from "./shared-host-lifecycle-service.js";
import { buildNewAdapterCases } from "./inbound-channel-event-service.new-adapters.fixtures.js";

describe("InboundChannelEventService", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
    vi.restoreAllMocks();
  });

  it("binds accepted ingress to its trusted revision and strips provider spoofing while preserving retry identity", async () => {
    const harness = await createHarness();
    const input = buildInput({ acceptedConnectionRevision: "a".repeat(64) });
    input.message.metadata = { [CHANNEL_INGRESS_ACCEPTED_REVISION_KEY]: "spoofed" };
    const first = await harness.service.accept(input);
    const original = harness.storage.inboundChannelEvents.get(first.inboundEventId)!;
    expect(original.payload[CHANNEL_INGRESS_ACCEPTED_REVISION_KEY]).toBe("a".repeat(64));
    expect(
      (original.payload.message as { metadata?: Record<string, unknown> }).metadata?.[
        CHANNEL_INGRESS_ACCEPTED_REVISION_KEY
      ],
    ).toBeUndefined();
    const retry = await harness.service.accept({ ...input, acceptedConnectionRevision: "b".repeat(64) });
    expect(retry.inboundEventId).toBe(first.inboundEventId);
    expect(
      harness.storage.inboundChannelEvents.get(first.inboundEventId)?.payload[CHANNEL_INGRESS_ACCEPTED_REVISION_KEY],
    ).toBe("a".repeat(64));
    // First test in the file pays the cold module and SQLite harness setup (~10s on a loaded host).
  }, 60_000);

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

  it.each(["telegram", "discord", "slack"] as const)(
    "parks %s approval-required turns without advancing to delivery or replaying on reconnect",
    async (channel) => {
      const respondToExistingChatMessage = vi.fn<InboundChannelEventServiceDeps["respondToExistingChatMessage"]>(
        async (_sessionId, _messageId, options) => {
          await options.inboundDurableIdentity.onDurableRunLaunched?.(options.inboundDurableIdentity.durableRunId);
          return {
            ...buildResponse(options.inboundDurableIdentity),
            trace: { status: "waiting_for_approval" } as ChatSendMessageResponse["trace"],
          };
        },
      );
      const activity = vi.fn<InboundChannelEventServiceDeps["emitChannelActivity"]>(async () => undefined);
      const harness = await createHarness({
        respondToExistingChatMessage,
        emitChannelActivity: activity,
        getIntegrationConnection: () => ({ key: channel, enabled: true, status: "connected", config: {} }),
      });

      const input = buildInput({ channel, idempotencyKey: `${channel}:approval-1` });
      const accepted = await harness.service.accept(input);
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
      expect(activity.mock.calls.map(([input]) => input.phase)).toContain("waiting_approval");
      harness.service.close();
      const restarted = harness.createAdditionalService();
      const replay = await restarted.accept(input);
      await restarted.drain();
      expect(replay.inboundEventId).toBe(accepted.inboundEventId);
      expect(respondToExistingChatMessage).toHaveBeenCalledTimes(1);
    },
  );

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

  it("stores conversation details on the session binding", async () => {
    // The harness owns the storage, so the session dependencies are built right after it exists.
    const harness = await createHarness({
      ensureInboundChatSession: async (input) => await ensureInboundIntegrationChatSession(chatDeps, input),
      ingestChannelMessage: vi.fn(async (channel, _idempotencyKey, message) => ({
        deduped: false,
        session: resolveSessionRoute({
          channel,
          account: message.account,
          peer: message.peer,
          room: message.room,
          threadId: message.threadId,
        }),
      })),
      respondToExistingChatMessage: vi.fn(async (sessionId, _messageId, options) =>
        buildResponse(options.inboundDurableIdentity, sessionId),
      ),
    });
    const connection = harness.storage.integrationConnections.create({
      catalogId: "channel.telegram",
      kind: "channel",
      key: "telegram",
      label: "Telegram",
      enabled: true,
      status: "connected",
      workspaceId: "workspace-a",
      config: {},
    });
    const chatDeps: ChatSessionDependencies = {
      storage: createSqliteAsyncStorage(harness.storage),
      operatorSummaryCache: { invalidate: vi.fn() },
      normalizeWorkspaceId: (workspaceId) => workspaceId?.trim() || "default",
      ensureChatSessionRuntimeGrants: vi.fn(async () => undefined),
      requireChatSession: async () => {
        throw new Error("not used by inbound binding initialization");
      },
      getSession: async (sessionId) => harness.storage.sessions.getBySessionId(sessionId),
      publishRealtime: vi.fn(async () => undefined),
      clearChatTurnWriteLease: vi.fn(),
      removeChatSessionStoredFile: vi.fn(async () => undefined),
      copyChatSessionStoredFile: vi.fn(async (storageRelPath) => storageRelPath),
      ensureChatSessionModelDefaults: (_sessionId, prefs) => prefs,
      hydrateChatPrefsWithAutonomy: async (_sessionId, prefs) => prefs,
      patchSessionAutonomyPrefs: vi.fn(async () => undefined),
    };

    const acceptAndSettle = async (n: number, conversation?: ChatChannelConversation) => {
      const accepted = await harness.service.accept(
        buildInput({
          channel: "telegram",
          connectionId: connection.connectionId,
          idempotencyKey: `telegram:conversation-${n}`,
          bindingTarget: "42",
          conversation,
          message: {
            eventId: `provider-message-${n}`,
            account: connection.connectionId,
            peer: "42",
            actorId: "42",
            actorType: "user",
            content: `hello ${n}`,
          },
        }),
      );
      await waitFor(() => harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.status === "completed");
      const sessionId = harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.sessionId;
      return harness.storage.chatSessionBindings.get(sessionId ?? "missing");
    };

    // The first event creates the session and records who the conversation is with.
    const direct: ChatChannelConversation = { kind: "direct", counterpartActorId: "42", title: "Sam Lee" };
    const first = await acceptAndSettle(1, direct);
    expect(first).toMatchObject({ transport: "integration", target: "42" });
    expect(first?.conversation).toEqual(direct);

    // The session already exists, so the refresh has to happen on later events too.
    const renamed: ChatChannelConversation = { kind: "direct", counterpartActorId: "42", title: "Samuel Lee" };
    expect((await acceptAndSettle(2, renamed))?.conversation).toEqual(renamed);

    // An event that carries no details leaves the stored ones alone.
    const unchanged = await acceptAndSettle(3);
    expect(unchanged?.conversation).toEqual(renamed);
    expect(unchanged?.target).toBe("42");
  });

  it("records a desk message with operator authority and skips the bot-loop guard", async () => {
    const decideBotLoop = vi.fn<InboundChannelEventServiceDeps["decideBotLoop"]>(() => ({
      action: "suppress",
      reason: "rate-cap",
      cooldownExpiresAt: new Date().toISOString(),
    }));
    const activity = vi.fn<InboundChannelEventServiceDeps["emitChannelActivity"]>(async () => undefined);
    const desk = await createDeskHarness({ decideBotLoop, emitChannelActivity: activity });

    const { response, eventId } = await desk.ask("What's on my calendar today?");
    await waitFor(() => desk.harness.storage.inboundChannelEvents.get(eventId)?.status === "completed");

    const message = desk.harness.storage.chatMessages.get(response.userMessage.messageId);
    expect(message).toMatchObject({
      sessionId: desk.session.sessionId,
      role: "user",
      actorType: "user",
      actorId: "operator",
      sourceAuthority: "operator",
      content: "What's on my calendar today?",
    });
    expect(desk.ingest).toHaveBeenCalledWith(
      "telegram",
      eventId,
      expect.objectContaining({ actorId: "operator", actorType: "user" }),
      "operator_desk",
    );
    expect(decideBotLoop).not.toHaveBeenCalled();
    expect(desk.harness.storage.inboundChannelEvents.get(eventId)?.botLoopDecision).toBeUndefined();
    // The desk message never arrived through the channel, so nothing is marked seen or typed on it there.
    expect(activity).not.toHaveBeenCalled();
    expect(desk.gateway.commsSend).toHaveBeenCalledTimes(1);
  });

  it("delivers the answer with the desk prefix", async () => {
    const desk = await createDeskHarness();

    const { eventId, response } = await desk.ask("Where did I park?");
    await waitFor(() => desk.harness.storage.inboundChannelEvents.get(eventId)?.status === "completed");

    expect(desk.gateway.commsSend).toHaveBeenCalledTimes(1);
    const delivery = desk.gateway.commsSend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(delivery.message).startsWith('From your desk: "')).toBe(true);
    expect(delivery).toMatchObject({
      connectionId: "telegram-1",
      target: "4242",
      message: 'From your desk: "Where did I park?"\n\nLevel 3, near the lifts.',
      sessionId: desk.session.sessionId,
    });
    // The desk question has no message in the channel to reply to, so the answer is a plain post.
    expect(delivery.replyToMessageId).toBeUndefined();
    expect(desk.harness.storage.inboundChannelEvents.get(eventId)).toMatchObject({
      status: "completed",
      messageId: response.userMessage.messageId,
      turnId: response.turnId,
      deliveryId: "desk-delivery-1",
    });
  });

  it("keeps a desk turn retryable while its answer waits for approval", async () => {
    const desk = await createDeskHarness({ answerStatus: "waiting_for_approval" });

    const { eventId } = await desk.ask("Book the usual table for Friday.");
    await waitFor(() => desk.harness.storage.inboundChannelEvents.get(eventId)?.status === "waiting");
    expect(desk.harness.storage.inboundChannelEvents.get(eventId)).toMatchObject({
      status: "waiting",
      deliveryId: undefined,
      terminalAt: undefined,
    });
    expect(desk.gateway.commsSend).not.toHaveBeenCalled();

    // The operator approves; the durable run settles the turn with its answer.
    desk.settleApprovedTurn("Booked for 7pm.");
    desk.harness.service.close();
    desk.harness.storage.db
      .prepare("UPDATE inbound_channel_events SET claim_expires_at = ? WHERE event_id = ?")
      .run(new Date(0).toISOString(), eventId);
    const restarted = desk.harness.createAdditionalService();
    await restarted.drain();
    await waitFor(() => desk.harness.storage.inboundChannelEvents.get(eventId)?.status === "completed");

    expect(desk.gateway.consumePreparedAgentChatTurn).toHaveBeenCalledTimes(1);
    expect(desk.gateway.commsSend).toHaveBeenCalledTimes(1);
    expect(desk.gateway.commsSend.mock.calls[0]?.[0]).toMatchObject({
      message: 'From your desk: "Book the usual table for Friday."\n\nBooked for 7pm.',
    });
    expect(desk.harness.storage.inboundChannelEvents.get(eventId)?.deliveryId).toBe("desk-delivery-1");
  });

  it("escapes an underscore in the quoted question for a Markdown Telegram connection", async () => {
    const desk = await createDeskHarness({ parseMode: "Markdown" });

    const { eventId } = await desk.ask("status of PR_123?");
    await waitFor(() => desk.harness.storage.inboundChannelEvents.get(eventId)?.status === "completed");

    // Unescaped, Telegram would refuse the whole message ("can't parse entities") and the answer would never arrive.
    expect(desk.gateway.commsSend.mock.calls[0]?.[0]).toMatchObject({
      message: 'From your desk: "status of PR\\_123?"\n\nLevel 3, near the lifts.',
    });
    // The recorded question keeps the operator's own text.
    const recorded = desk.harness.storage.inboundChannelEvents.get(eventId);
    expect(desk.harness.storage.chatMessages.get(recorded!.messageId!)?.content).toBe("status of PR_123?");
  });

  it("answers a desk question with the operator's provider and model, also after an approval wait", async () => {
    const desk = await createDeskHarness({ answerStatus: "waiting_for_approval" });

    const { eventId } = await desk.ask("Book the usual table.", "request-1", {
      providerId: "openai",
      model: "gpt-5.1",
    });
    await waitFor(() => desk.harness.storage.inboundChannelEvents.get(eventId)?.status === "waiting");
    expect(desk.gateway.prepareAgentChatTurn).toHaveBeenCalledWith(
      desk.session.sessionId,
      expect.objectContaining({ providerId: "openai", model: "gpt-5.1" }),
      expect.any(Object),
    );
    expect(desk.gateway.sessionControlRuntimeOwner.admitSystemChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ providerId: "openai", model: "gpt-5.1" }) }),
    );

    desk.settleApprovedTurn("Booked.");
    desk.harness.service.close();
    desk.harness.storage.db
      .prepare("UPDATE inbound_channel_events SET claim_expires_at = ? WHERE event_id = ?")
      .run(new Date(0).toISOString(), eventId);
    await desk.harness.createAdditionalService().drain();
    await waitFor(() => desk.harness.storage.inboundChannelEvents.get(eventId)?.status === "completed");

    // The retry re-reads the choice from the durable event, not from the original request.
    expect(desk.harness.respondToExistingChatMessage).toHaveBeenCalledTimes(2);
    for (const [, , options] of desk.harness.respondToExistingChatMessage.mock.calls) {
      expect(options).toMatchObject({ providerId: "openai", model: "gpt-5.1" });
    }
  });

  it("never answers a desk question once the conversation is no longer the operator's own", async () => {
    const desk = await createDeskHarness({ ownerActorIds: ["someone-else"] });

    const { eventId } = await desk.ask("Is this still me?");
    await waitFor(() => desk.harness.storage.inboundChannelEvents.get(eventId)?.status === "suppressed");

    expect(desk.harness.respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(desk.gateway.commsSend).not.toHaveBeenCalled();
  });

  it("answers an owner's desk question end to end, and suppresses one once the owner is removed", async () => {
    const { harness, connection, session, replyGateway, channelIngest, ask } = await createEndToEndDeskHarness();

    const first = await ask("Where did I park?", "request-1");
    await waitFor(() => harness.storage.inboundChannelEvents.get(first.eventId)?.status === "completed");

    expect(harness.storage.chatMessages.get(first.response.userMessage.messageId)).toMatchObject({
      sessionId: session.sessionId,
      actorId: "operator",
      sourceAuthority: "operator",
      content: "Where did I park?",
    });
    expect(channelIngest).not.toHaveBeenCalled();
    expect(harness.respondToExistingChatMessage).toHaveBeenCalledTimes(1);
    expect(replyGateway.consumePreparedAgentChatTurn).toHaveBeenCalledTimes(1);
    expect(replyGateway.commsSend).toHaveBeenCalledTimes(1);
    expect(replyGateway.commsSend.mock.calls[0]?.[0]).toMatchObject({
      connectionId: connection.connectionId,
      target: "4242",
      message: 'From your desk: "Where did I park?"\n\nLevel 3, near the lifts.',
    });
    // The real ensure kept the conversation the phone message recorded.
    expect(harness.storage.chatSessionBindings.get(session.sessionId)?.conversation).toMatchObject({
      kind: "direct",
      counterpartActorId: "4242",
    });

    // The owner is taken off the connection while a desk question is already accepted: it is never answered.
    const current = harness.storage.integrationConnections.get(connection.connectionId);
    harness.storage.integrationConnections.update(connection.connectionId, {
      expectedRevision: current.revision,
      config: { ownerActorIds: [] },
    });
    const second = await ask("Is this still me?", "request-2");
    await waitFor(() => harness.storage.inboundChannelEvents.get(second.eventId)?.status === "suppressed");

    // Checked before anything is recorded: the question is neither recorded nor answered.
    expect(harness.storage.chatMessages.get(second.response.userMessage.messageId)).toBeUndefined();
    expect(harness.respondToExistingChatMessage).toHaveBeenCalledTimes(1);
    expect(replyGateway.consumePreparedAgentChatTurn).toHaveBeenCalledTimes(1);
    expect(replyGateway.commsSend).toHaveBeenCalledTimes(1);
  });

  it("never answers a queued desk question once its binding is read-only, and leaves the binding as set", async () => {
    const desk = await createEndToEndDeskHarness();
    const accepted = desk.currentBinding();
    // The operator switches the conversation to read-only after the desk send was accepted, before it is processed.
    const readOnly = await setChatSessionBinding(desk.chatDeps(), {
      sessionId: desk.session.sessionId,
      transport: "integration",
      connectionId: desk.connection.connectionId,
      target: "4242",
      writable: false,
    });

    const { response, eventId } = await desk.ask("Still there?", "request-ro", accepted);
    await waitFor(() => desk.harness.storage.inboundChannelEvents.get(eventId)?.status === "suppressed");

    expect(desk.harness.storage.inboundChannelEvents.get(eventId)).toMatchObject({
      status: "suppressed",
      lastError: expect.stringMatching(/read-only/),
      sessionId: desk.session.sessionId,
    });
    expect(desk.ensureInboundChatSession).not.toHaveBeenCalled();
    expect(desk.harness.ingestChannelMessage).not.toHaveBeenCalled();
    expect(desk.harness.storage.chatMessages.get(response.userMessage.messageId)).toBeUndefined();
    expect(desk.harness.respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(desk.replyGateway.commsSend).not.toHaveBeenCalled();
    expect(desk.currentBinding()).toEqual(readOnly);
  });

  it("never answers a queued desk question after its binding is re-pointed, and keeps the new target", async () => {
    const desk = await createEndToEndDeskHarness();
    const accepted = desk.currentBinding();
    const repointed = await setChatSessionBinding(desk.chatDeps(), {
      sessionId: desk.session.sessionId,
      transport: "integration",
      connectionId: desk.connection.connectionId,
      target: "9999",
      writable: true,
    });

    const { response, eventId } = await desk.ask("Still there?", "request-moved", accepted);
    await waitFor(() => desk.harness.storage.inboundChannelEvents.get(eventId)?.status === "suppressed");

    expect(desk.harness.storage.inboundChannelEvents.get(eventId)?.lastError).toMatch(/somewhere else/);
    expect(desk.ensureInboundChatSession).not.toHaveBeenCalled();
    expect(desk.harness.storage.chatMessages.get(response.userMessage.messageId)).toBeUndefined();
    expect(desk.harness.respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(desk.replyGateway.commsSend).not.toHaveBeenCalled();
    // The refresh that used to run here would have pointed the binding back at the desk question's target.
    expect(desk.currentBinding()).toEqual(repointed);
  });

  it("never answers a queued desk question once its binding is removed, while a phone message still initialises it", async () => {
    const desk = await createEndToEndDeskHarness();
    const accepted = desk.currentBinding();
    desk.harness.storage.db
      .prepare("DELETE FROM chat_session_bindings WHERE session_id = ?")
      .run(desk.session.sessionId);

    const { response, eventId } = await desk.ask("Still there?", "request-gone", accepted);
    await waitFor(() => desk.harness.storage.inboundChannelEvents.get(eventId)?.status === "suppressed");

    expect(desk.harness.storage.inboundChannelEvents.get(eventId)?.lastError).toMatch(/no longer bound/);
    expect(desk.ensureInboundChatSession).not.toHaveBeenCalled();
    expect(desk.harness.storage.chatMessages.get(response.userMessage.messageId)).toBeUndefined();
    expect(desk.harness.respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(desk.replyGateway.commsSend).not.toHaveBeenCalled();
    expect(desk.currentBinding()).toBeUndefined();

    // A message from the phone still runs provider-ingress initialization, exactly as before.
    const phone = await desk.harness.service.accept(
      buildInput({
        channel: "telegram",
        connectionId: desk.connection.connectionId,
        idempotencyKey: "telegram:phone-after-removal",
        bindingTarget: "4242",
        dispatchKind: "record_only",
        conversation: { kind: "direct", counterpartActorId: "4242", title: "Alex Rivera" },
        responseOptions: undefined,
        message: {
          eventId: "telegram-message-9",
          account: desk.connection.connectionId,
          peer: "4242",
          actorId: "4242",
          actorType: "user",
          content: "Back on the phone.",
        },
      }),
    );
    await waitFor(() => desk.harness.storage.inboundChannelEvents.get(phone.inboundEventId)?.status === "completed");
    expect(desk.ensureInboundChatSession).toHaveBeenCalledExactlyOnceWith({
      route: { channel: "telegram", account: desk.connection.connectionId, peer: "4242" },
      connectionId: desk.connection.connectionId,
      target: "4242",
      conversation: { kind: "direct", counterpartActorId: "4242", title: "Alex Rivera" },
    });
    expect(desk.currentBinding()).toMatchObject({
      transport: "integration",
      connectionId: desk.connection.connectionId,
      target: "4242",
      writable: true,
      conversation: { kind: "direct", counterpartActorId: "4242" },
    });
  });

  it("checks the binding again when a desk question is retried after its approval wait", async () => {
    const desk = await createEndToEndDeskHarness("waiting_for_approval");

    const { eventId } = await desk.ask("Book the usual table.", "request-approval");
    await waitFor(() => desk.harness.storage.inboundChannelEvents.get(eventId)?.status === "waiting");
    expect(desk.harness.respondToExistingChatMessage).toHaveBeenCalledTimes(1);

    // While the answer waits for approval, the operator makes the conversation read-only, then approves the turn.
    const readOnly = await setChatSessionBinding(desk.chatDeps(), {
      sessionId: desk.session.sessionId,
      transport: "integration",
      connectionId: desk.connection.connectionId,
      target: "4242",
      writable: false,
    });
    desk.replyGateway.settleApprovedTurn("Booked for 7pm.");
    desk.harness.service.close();
    desk.harness.storage.db
      .prepare("UPDATE inbound_channel_events SET claim_expires_at = ? WHERE event_id = ?")
      .run(new Date(0).toISOString(), eventId);
    await desk.harness.createAdditionalService().drain();
    await waitFor(() => desk.harness.storage.inboundChannelEvents.get(eventId)?.status === "suppressed");

    expect(desk.harness.storage.inboundChannelEvents.get(eventId)?.lastError).toMatch(/read-only/);
    expect(desk.ensureInboundChatSession).not.toHaveBeenCalled();
    expect(desk.harness.respondToExistingChatMessage).toHaveBeenCalledTimes(1);
    expect(desk.replyGateway.commsSend).not.toHaveBeenCalled();
    expect(desk.currentBinding()).toEqual(readOnly);
  });

  it("decides each desk send from the binding, the connection and the session it names", async () => {
    const desk = await createDeskHarness();
    const connection = {
      connectionId: "telegram-1",
      key: "telegram",
      label: "Telegram",
      enabled: true,
      status: "connected",
      config: { ownerActorIds: ["4242"] },
    };
    const deskBinding = {
      sessionId: desk.session.sessionId,
      transport: "integration",
      connectionId: "telegram-1",
      target: "4242",
      conversation: { kind: "direct", counterpartActorId: "4242" },
      writable: true,
    };
    let binding: Record<string, unknown> | undefined = deskBinding;
    let connectionExists = true;
    const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
    gateway.inboundChannelEventService = desk.harness.service;
    gateway.storage = {
      chatSessionBindings: { get: async () => binding },
      integrationConnections: {
        get: async (connectionId: string) => {
          if (!connectionExists) {
            throw new NotFoundError({ entity: "Integration connection", id: connectionId });
          }
          return connection;
        },
      },
      sessions: { getBySessionId: async () => ({ sessionKey: desk.session.sessionKey }) },
    };
    const send = () =>
      gateway.sendOperatorDeskMessage(desk.session.sessionId, { content: "Any news?", idempotencyKey: "request-9" });

    const asked = await send();
    expect(asked).toMatchObject({ mode: "ask", response: { userMessage: { sourceAuthority: "operator" } } });
    expect(
      desk.harness.storage.inboundChannelEvents.getByIdentity({
        channelKey: "telegram",
        connectionId: "telegram-1",
        idempotencyKey: `desk:${desk.session.sessionId}:request-9`,
      }),
    ).toMatchObject({ dispatchKind: "operator_desk_turn", transport: "operator_desk" });

    connectionExists = false;
    await expect(send()).resolves.toEqual({
      mode: "blocked",
      message: "This channel was removed. Its conversations stay readable.",
    });
    binding = { ...deskBinding, transport: "llm", connectionId: undefined, target: undefined };
    await expect(send()).resolves.toEqual({ mode: "post" });
    binding = undefined;
    await expect(send()).resolves.toEqual({ mode: "post" });
  });

  it("refuses desk events through the provider acceptance path", async () => {
    const harness = await createHarness();
    await expect(
      harness.service.accept({
        ...buildInput(),
        dispatchKind: "operator_desk_turn" as never,
      }),
    ).rejects.toThrow();
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

  it.each(["ntfy", "mattermost", "matrix", "google-chat", "qqbot", "wecom"] as const)(
    "accepts a %s adapter event exactly once across reconnect replay and restart",
    async (name) => {
      const { input, expectedKey } = (await buildNewAdapterCases()).find((entry) => entry.name === name)!;
      expect(input.idempotencyKey).toBe(expectedKey);
      expect(input).not.toHaveProperty("inboundAccessConfig");
      expect(input).not.toHaveProperty("allowedSenders");
      const harness = await createHarness();

      const first = await harness.service.accept(input);
      expect(first.deduped).toBe(false);
      await waitFor(() => harness.storage.inboundChannelEvents.get(first.inboundEventId)?.status === "completed");

      const replay = await harness.service.accept(structuredClone(input));
      expect(replay.deduped).toBe(true);
      expect(replay.inboundEventId).toBe(first.inboundEventId);

      harness.service.close();
      const restarted = harness.createAdditionalService();
      const afterRestart = await restarted.accept(structuredClone(input));
      await restarted.drain();
      expect(afterRestart.deduped).toBe(true);
      expect(afterRestart.inboundEventId).toBe(first.inboundEventId);
      expect(harness.ingestChannelMessage).toHaveBeenCalledTimes(1);
      expect(harness.respondToExistingChatMessage).toHaveBeenCalledTimes(1);
    },
  );

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

  it("persists Slack and Discord voice references without connection config and transcribes them in the worker", async () => {
    const transcribe = vi.fn(async () => ({ ok: true as const, transcript: "voice transcript" }));
    const harness = await createHarness({ transcribeChannelVoice: transcribe });
    const slack = await harness.service.accept(
      buildInput({
        channel: "slack",
        idempotencyKey: "slack:conn:EvVoice1",
        dispatchKind: "voice_agent_turn",
        voiceRequest: {
          channel: "slack",
          connectionConfig: { botToken: "must-not-persist" },
          fileId: "F0VOICE01",
          downloadUrl: "https://files.slack.com/files-pri/T1-F0VOICE01/download/a.webm",
          mimeType: "audio/webm",
        },
        voiceFallbackContent: "[voice message]",
        message: { ...buildInput().message, eventId: "slack-voice-1" },
      }),
    );
    const discord = await harness.service.accept(
      buildInput({
        channel: "discord",
        idempotencyKey: "discord:conn:msg-voice-1",
        dispatchKind: "voice_agent_turn",
        voiceRequest: {
          channel: "discord",
          connectionConfig: { botToken: "must-not-persist" },
          attachmentId: "222333444555",
          url: "https://cdn.discordapp.com/attachments/1/222333444555/voice-message.ogg",
          mimeType: "audio/ogg",
        },
        voiceFallbackContent: "[voice message]",
        message: { ...buildInput().message, eventId: "discord-voice-1" },
      }),
    );
    await waitFor(
      () =>
        harness.storage.inboundChannelEvents.get(slack.inboundEventId)?.status === "completed" &&
        harness.storage.inboundChannelEvents.get(discord.inboundEventId)?.status === "completed",
    );

    // The download reads keys as the connection the event arrived on (the claim names it), and as no other.
    const owner = { connectionId: "connection-1" };
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        fileId: "F0VOICE01",
        downloadUrl: "https://files.slack.com/files-pri/T1-F0VOICE01/download/a.webm",
        mimeType: "audio/webm",
      }),
      owner,
    );
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        attachmentId: "222333444555",
        url: "https://cdn.discordapp.com/attachments/1/222333444555/voice-message.ogg",
      }),
      owner,
    );
    for (const accepted of [slack, discord]) {
      const persisted = JSON.stringify(harness.storage.inboundChannelEvents.get(accepted.inboundEventId)?.payload);
      expect(persisted).not.toContain("must-not-persist");
      expect(persisted).not.toContain("connectionConfig");
    }
  });

  it("keeps the typed caption alongside a successful Slack or Discord transcript", async () => {
    const transcribe = vi.fn(async () => ({ ok: true as const, transcript: "remember the rent" }));
    const harness = await createHarness({ transcribeChannelVoice: transcribe });
    const voiceRequests = {
      slack: {
        channel: "slack" as const,
        connectionConfig: {},
        fileId: "F0VOICE02",
        downloadUrl: "https://files.slack.com/files-pri/T1-F0VOICE02/download/a.webm",
      },
      discord: {
        channel: "discord" as const,
        connectionConfig: {},
        attachmentId: "222333444556",
        url: "https://cdn.discordapp.com/attachments/1/222333444556/voice-message.ogg",
      },
    };
    const accepted = [];
    for (const channel of ["slack", "discord"] as const) {
      accepted.push(
        await harness.service.accept(
          buildInput({
            channel,
            idempotencyKey: `${channel}:conn:caption-1`,
            dispatchKind: "voice_agent_turn",
            voiceRequest: voiceRequests[channel],
            voiceFallbackContent: "[voice message] please file this",
            voiceCaption: "please file this",
            message: { ...buildInput().message, eventId: `${channel}-caption-1` },
          }),
        ),
      );
    }
    await waitFor(() =>
      accepted.every((item) => harness.storage.inboundChannelEvents.get(item.inboundEventId)?.status === "completed"),
    );

    for (const channel of ["slack", "discord"]) {
      expect(harness.ingestChannelMessage).toHaveBeenCalledWith(
        channel,
        expect.any(String),
        expect.objectContaining({
          content: `${VOICE_TRANSCRIPT_CONTENT_PREFIX} remember the rent\nplease file this`,
        }),
      );
    }
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

  /**
   * The operator's own Telegram conversation with the real Chat session ensure, binding repository and binding read,
   * the Gateway's own ingest (the desk branch and ingestEvent) and its reply owner. Only turn admission, model
   * execution and the channel send are doubles. The owner wrote to the bot from their phone first: that is what made
   * this their own conversation.
   */
  async function createEndToEndDeskHarness(answerStatus: "completed" | "waiting_for_approval" = "completed") {
    const getStorage = (): Storage => harness.storage;
    const ingestGateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
    let eventIngest: EventIngestService | undefined;
    const getEventIngest = () => (eventIngest ??= new EventIngestService(createSqliteAsyncStorage(getStorage())));
    Object.defineProperty(ingestGateway, "eventIngestService", { get: getEventIngest });
    ingestGateway.publishRealtime = vi.fn(async () => undefined);
    ingestGateway.operatorSummaryCache = { invalidate: vi.fn() };
    // Only a message from the phone is recorded as channel input.
    const channelIngest = vi.fn(async (channel: string, idempotencyKey: string, message: IngestChannelMessageInput) =>
      getEventIngest().ingest({
        endpoint: "/api/v1/gateway/events",
        idempotencyKey,
        sourceAuthority: "external_channel",
        payload: {
          eventId: message.eventId,
          route: { channel, account: message.account, peer: message.peer },
          actor: { type: "user", id: message.actorId },
          message: { role: "user", content: message.content },
        },
      }),
    );
    const chatDeps = (): ChatSessionDependencies => ({
      storage: createSqliteAsyncStorage(getStorage()),
      operatorSummaryCache: { invalidate: vi.fn() },
      normalizeWorkspaceId: (workspaceId) => workspaceId?.trim() || "default",
      ensureChatSessionRuntimeGrants: vi.fn(async () => undefined),
      requireChatSession: async () => {
        throw new Error("not used by inbound binding initialization");
      },
      getSession: async (sessionId) => getStorage().sessions.getBySessionId(sessionId),
      publishRealtime: vi.fn(async () => undefined),
      clearChatTurnWriteLease: vi.fn(),
      removeChatSessionStoredFile: vi.fn(async () => undefined),
      copyChatSessionStoredFile: vi.fn(async (storageRelPath) => storageRelPath),
      ensureChatSessionModelDefaults: (_sessionId, prefs) => prefs,
      hydrateChatPrefsWithAutonomy: async (_sessionId, prefs) => prefs,
      patchSessionAutonomyPrefs: vi.fn(async () => undefined),
    });
    // The reply owner reads the binding as stored, not a fixed one.
    const replyGateway = createDeskReplyGateway(getStorage, undefined as never, answerStatus);
    replyGateway.storage.chatSessionBindings = {
      get: async (sessionId: string) => getStorage().chatSessionBindings.get(sessionId),
    };
    const ensureInboundChatSession = vi.fn<InboundChannelEventServiceDeps["ensureInboundChatSession"]>(
      async (input) => await ensureInboundIntegrationChatSession(chatDeps(), input),
    );
    const harness = await createHarness({
      getIntegrationConnection: async (connectionId) => getStorage().integrationConnections.get(connectionId),
      ensureInboundChatSession,
      readChatSessionBinding: async (sessionId) => await findChatSessionBinding(chatDeps(), sessionId),
      ingestChannelMessage: vi.fn<InboundChannelEventServiceDeps["ingestChannelMessage"]>(
        async (channel, idempotencyKey, message, origin) =>
          await recordInboundChannelMessage(
            { channel, idempotencyKey, message, origin },
            (key, event, options) => GatewayService.prototype.ingestEvent.call(ingestGateway, key, event, options),
            channelIngest,
          ),
      ),
      respondToExistingChatMessage: vi.fn<InboundChannelEventServiceDeps["respondToExistingChatMessage"]>(
        async (sessionId, messageId, options) =>
          await GatewayService.prototype.respondToExistingChatMessage.call(replyGateway, sessionId, messageId, options),
      ),
    });
    const connection = harness.storage.integrationConnections.create({
      catalogId: "channel.telegram",
      kind: "channel",
      key: "telegram",
      label: "Telegram",
      enabled: true,
      status: "connected",
      workspaceId: "default",
      config: { ownerActorIds: ["4242"] },
    });
    const session = await ensureInboundIntegrationChatSession(chatDeps(), {
      route: { channel: "telegram", account: connection.connectionId, peer: "4242" },
      connectionId: connection.connectionId,
      target: "4242",
      conversation: { kind: "direct", counterpartActorId: "4242", title: "Alex Rivera" },
    });
    const currentBinding = () => harness.storage.chatSessionBindings.get(session.sessionId);
    /** Accepts a desk send against the binding the desk saw when it was sent (by default, the binding as stored). */
    const ask = async (content: string, idempotencyKey: string, binding = currentBinding()!) => {
      const response = await acceptOperatorDeskTurn(
        (acceptance) => harness.service.acceptOperatorDeskEvent(acceptance),
        { sessionId: session.sessionId, sessionKey: session.sessionKey, binding, content, idempotencyKey },
      );
      const event = harness.storage.inboundChannelEvents.getByIdentity({
        channelKey: "telegram",
        connectionId: connection.connectionId,
        idempotencyKey: `desk:${session.sessionId}:${idempotencyKey}`,
      });
      return { response, eventId: event!.eventId };
    };
    return {
      harness,
      connection,
      session,
      chatDeps,
      replyGateway,
      channelIngest,
      ensureInboundChatSession,
      currentBinding,
      ask,
    };
  }

  /**
   * A desk question in the operator's own Telegram conversation, run by the real worker, real Chat ingest and the
   * real Gateway reply owner. Only model execution, turn admission and the channel send are doubles.
   */
  async function createDeskHarness(
    options: Partial<InboundChannelEventServiceDeps> & {
      answerStatus?: "completed" | "waiting_for_approval";
      ownerActorIds?: string[];
      parseMode?: string;
    } = {},
  ) {
    const { answerStatus = "completed", ownerActorIds = ["4242"], parseMode, ...overrides } = options;
    const session = resolveSessionRoute({ channel: "telegram", account: "telegram-1", peer: "4242" });
    const deskBinding: ChatSessionBindingRecord = {
      sessionId: session.sessionId,
      transport: "integration",
      connectionId: "telegram-1",
      target: "4242",
      conversation: { kind: "direct", counterpartActorId: "4242", title: "You" },
      writable: true,
      createdAt: "2026-10-25T10:00:00.000Z",
      updatedAt: "2026-10-25T10:00:00.000Z",
    };
    // The harness owns the storage; these closures only run once it exists.
    const getStorage = (): Storage => harness.storage;
    let eventIngest: EventIngestService | undefined;
    const ingest = vi.fn<InboundChannelEventServiceDeps["ingestChannelMessage"]>(
      async (channel, idempotencyKey, message, origin) => {
        eventIngest ??= new EventIngestService(createSqliteAsyncStorage(getStorage()));
        const fromDesk = origin === "operator_desk";
        return await eventIngest.ingest({
          endpoint: "/api/v1/gateway/events",
          idempotencyKey,
          sourceAuthority: fromDesk ? "operator" : "external_channel",
          payload: fromDesk
            ? buildOperatorDeskGatewayEvent(channel, message)
            : {
                eventId: message.eventId,
                route: { channel, account: message.account, peer: message.peer },
                actor: { type: "user", id: message.actorId },
                message: { role: "user", content: message.content },
              },
        });
      },
    );
    const gateway = createDeskReplyGateway(getStorage, deskBinding, answerStatus);
    const harness = await createHarness({
      getIntegrationConnection: () => ({
        key: "telegram",
        enabled: true,
        status: "connected",
        config: { ownerActorIds, ...(parseMode ? { parseMode } : {}) },
      }),
      ensureInboundChatSession: vi.fn(async () => {
        throw new Error("a desk question never runs provider-ingress initialization");
      }),
      readChatSessionBinding: vi.fn(async () => deskBinding),
      ingestChannelMessage: ingest,
      respondToExistingChatMessage: vi.fn<InboundChannelEventServiceDeps["respondToExistingChatMessage"]>(
        async (sessionId, messageId, respondOptions) =>
          await GatewayService.prototype.respondToExistingChatMessage.call(
            gateway,
            sessionId,
            messageId,
            respondOptions,
          ),
      ),
      ...overrides,
    });
    const ask = async (
      content: string,
      idempotencyKey = "request-1",
      selection: { providerId?: string; model?: string } = {},
    ) => {
      const response = await acceptOperatorDeskTurn(
        (acceptance) => harness.service.acceptOperatorDeskEvent(acceptance),
        {
          sessionId: session.sessionId,
          sessionKey: session.sessionKey,
          binding: deskBinding,
          content,
          idempotencyKey,
          ...selection,
        },
      );
      const event = harness.storage.inboundChannelEvents.getByIdentity({
        channelKey: "telegram",
        connectionId: "telegram-1",
        idempotencyKey: `desk:${session.sessionId}:${idempotencyKey}`,
      });
      return { response, eventId: event!.eventId };
    };
    return { harness, session, ingest, gateway, ask, settleApprovedTurn: gateway.settleApprovedTurn };
  }

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
      readChatSessionBinding: vi.fn(async () => undefined),
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

/**
 * A Gateway double for the shipped `respondToExistingChatMessage`: turn admission, model execution and the channel
 * send are stubs, while the reply owner's own replay, approval-wait and delivery logic runs unchanged.
 */
function createDeskReplyGateway(
  getStorage: () => Storage,
  binding: ChatSessionBindingRecord,
  answerStatus: "completed" | "waiting_for_approval",
) {
  const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
  let admission: { requestClaim?: unknown } | undefined;
  let identity: Record<string, string> = {};
  let settledTrace: Record<string, unknown> | undefined;
  let settledAnswer: ChatMessageRecord | undefined;
  gateway.config = { assistant: { deploymentProfile: "local_dev", features: {} } };
  gateway.runtimeDecisionRecorder = { record: vi.fn() };
  gateway.isFeatureEnabled = vi.fn(async () => false);
  gateway.recordDevDiagnostic = vi.fn();
  gateway.withChatTurnWriteLease = vi.fn(
    async (_sessionId: string, _operation: string, work: () => Promise<unknown>) => await work(),
  );
  gateway.sessionControlRuntimeOwner = {
    admitSystemChatTurn: vi.fn(async () => {
      admission = { requestClaim: { runtimeOwnerId: "runtime-desk", leaseRevision: 1 } };
      return admission;
    }),
    renewRequestLease: vi.fn(async () => admission),
    startRequestLeaseHeartbeat: vi.fn(() => ({ assertHealthy: vi.fn(), stop: vi.fn() })),
    closeTurnWrite: vi.fn(),
  };
  gateway.prepareAgentChatTurn = vi.fn(
    async (sessionId: string, _request: unknown, prepare: Record<string, string>) => {
      identity = {
        sessionId,
        turnId: prepare.turnId!,
        userMessageId: prepare.userMessageId!,
        assistantMessageId: prepare.assistantMessageId!,
      };
      return { userEventId: prepare.userMessageId, turnId: prepare.turnId };
    },
  );
  gateway.consumePreparedAgentChatTurn = vi.fn(
    async (sessionId: string, _request: unknown, prepared: { turnId: string }, ...rest: unknown[]) => {
      identity.durableRunId = (rest[2] as { durableRunId: string }).durableRunId;
      // The real durable launch transfers request authority before returning.
      admission!.requestClaim = undefined;
      return answerStatus === "completed"
        ? {
            sessionId,
            turnId: prepared.turnId,
            assistantMessage: { messageId: identity.assistantMessageId, content: "Level 3, near the lifts." },
            trace: { status: "completed" },
          }
        : { sessionId, turnId: prepared.turnId, trace: { status: "waiting_for_approval" } };
    },
  );
  gateway.ensureSessionInternalToolGrant = vi.fn();
  gateway.commsSend = vi.fn(async () => ({ status: "queued", deliveryId: "desk-delivery-1" }));
  gateway.requireExecutedToolResult = vi.fn(() => ({
    deliveryId: "desk-delivery-1",
    providerMessageId: "telegram-reply-1",
  }));
  gateway.storage = {
    chatMessages: {
      get: async (messageId: string) =>
        messageId === settledAnswer?.messageId ? settledAnswer : getStorage().chatMessages.get(messageId),
    },
    chatSessionBindings: { get: async () => binding },
    chatTurnTraces: {
      get: async (turnId: string) => {
        if (settledTrace?.turnId !== turnId) {
          throw new NotFoundError({ entity: "Chat turn trace", id: turnId });
        }
        return settledTrace;
      },
    },
  };
  /** Stands in for the durable run finishing after the operator approves. */
  const settleApprovedTurn = (content: string): void => {
    settledAnswer = {
      messageId: identity.assistantMessageId!,
      sessionId: identity.sessionId!,
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      sourceAuthority: "agent_proposed",
      content,
      timestamp: new Date().toISOString(),
    };
    settledTrace = {
      turnId: identity.turnId,
      sessionId: identity.sessionId,
      userMessageId: identity.userMessageId,
      assistantMessageId: identity.assistantMessageId,
      durable: { runId: identity.durableRunId },
      status: "completed",
    };
  };
  return Object.assign(gateway, { settleApprovedTurn });
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
