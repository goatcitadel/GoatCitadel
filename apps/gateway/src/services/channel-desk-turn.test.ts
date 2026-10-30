import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSessionRoute } from "@goatcitadel/gateway-core";
import { Storage } from "@goatcitadel/storage";
import {
  WHATSAPP_REPLY_WINDOW_CLOSED,
  type ChatSessionBindingRecord,
  type IntegrationConnection,
} from "@goatcitadel/contracts";
import {
  acceptOperatorDeskTurn,
  buildDeskDeliveryPrefix,
  buildDeskLaneKey,
  buildOperatorDeskAcceptance,
  describeBlockedDeskReply,
  recordInboundChannelMessage,
  resolveDeskConversationMode,
  resolveDeskQuestionGate,
  routeOperatorDeskSend,
} from "./channel-desk-turn.js";
import type { DurableInboundChannelAcceptInput } from "./channel-inbound-dispatch.js";
import { handleDiscordRuntimeInbound, type DiscordRuntimeBridgeHost } from "./discord-runtime-bridge-service.js";
import { InboundChannelEventService } from "./inbound-channel-event-service.js";
import { SharedHostLifecycleService } from "./shared-host-lifecycle-service.js";
import { normalizeSlackWebhookPayload } from "./slack-webhook.js";
import { applyTelegramChannelSessionRotation, createTelegramChannelSessionPatch } from "./telegram-channel-sessions.js";
import { normalizeTelegramWebhookPayload } from "./telegram-webhook.js";
import { normalizeWhatsAppWebhookPayloads } from "./whatsapp-webhook.js";

const OWNER_ID = "4242";

function connection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    connectionId: "telegram-1",
    revision: "r1",
    catalogId: "channel.telegram",
    kind: "channel",
    key: "telegram",
    label: "Telegram",
    enabled: true,
    status: "connected",
    config: { ownerActorIds: [OWNER_ID] },
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
    ...overrides,
  };
}

function binding(overrides: Partial<ChatSessionBindingRecord> = {}): ChatSessionBindingRecord {
  return {
    sessionId: "sess-1",
    transport: "integration",
    connectionId: "telegram-1",
    target: OWNER_ID,
    conversation: { kind: "direct", counterpartActorId: OWNER_ID, title: "You" },
    writable: true,
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
    ...overrides,
  };
}

describe("channel desk turns", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("asks GoatCitadel in the operator's own direct conversation", () => {
    expect(resolveDeskConversationMode(binding(), connection())).toBe("ask");
    // Owner ids are matched the same forgiving way as the sender allowlist.
    expect(
      resolveDeskConversationMode(
        binding({ conversation: { kind: "direct", counterpartActorId: " UserABC " } }),
        connection({ config: { ownerActorIds: ["userabc"] } }),
      ),
    ).toBe("ask");
  });

  it("posts verbatim when the direct conversation is someone else's", () => {
    expect(resolveDeskConversationMode(binding(), connection({ config: { ownerActorIds: ["9999"] } }))).toBe("post");
    expect(resolveDeskConversationMode(binding(), connection({ config: {} }))).toBe("post");
    // Anything less certain than a recorded counterpart in the owner list is not the operator's own conversation.
    expect(resolveDeskConversationMode(binding({ conversation: { kind: "direct" } }), connection())).toBe("post");
    expect(resolveDeskConversationMode(binding({ conversation: undefined }), connection())).toBe("post");
    expect(resolveDeskConversationMode(binding({ writable: false }), connection())).toBe("post");
    expect(resolveDeskConversationMode(binding({ target: undefined }), connection())).toBe("post");
    expect(
      resolveDeskConversationMode(binding({ transport: "llm", connectionId: undefined, target: undefined }), undefined),
    ).toBe("post");
  });

  it("posts verbatim in group conversations", () => {
    expect(
      resolveDeskConversationMode(binding({ conversation: { kind: "group", title: "Family group" } }), connection()),
    ).toBe("post");
    // A group never carries a counterpart, even if a stored value claims one.
    expect(
      resolveDeskConversationMode(
        binding({ conversation: { kind: "group", counterpartActorId: OWNER_ID } as never }),
        connection(),
      ),
    ).toBe("post");
  });

  it("blocks desk replies when the channel is off or removed", () => {
    expect(resolveDeskConversationMode(binding(), connection({ enabled: false }))).toBe("blocked");
    expect(resolveDeskConversationMode(binding(), connection({ status: "error" }))).toBe("blocked");
    expect(resolveDeskConversationMode(binding(), connection({ status: "paused" }))).toBe("blocked");
    expect(resolveDeskConversationMode(binding(), undefined)).toBe("blocked");
    // Blocked wins over the conversation kind: an off channel can't take a verbatim post either.
    expect(
      resolveDeskConversationMode(binding({ conversation: { kind: "group" } }), connection({ enabled: false })),
    ).toBe("blocked");

    expect(describeBlockedDeskReply(connection({ enabled: false, label: "Family bot" }))).toBe(
      "Turn Family bot back on to reply.",
    );
    expect(describeBlockedDeskReply(connection({ status: "error", label: "Family bot" }))).toBe(
      "Family bot isn't connected right now. Check its channel page.",
    );
    // Like Messaging's status, only a switched-off channel asks to be turned back on: an enabled channel that is
    // paused or disconnected shows "Turn off" on its page, so it is pointed there instead.
    for (const status of ["paused", "disconnected"] as const) {
      expect(describeBlockedDeskReply(connection({ status, label: "Family bot" }))).toBe(
        "Family bot isn't connected right now. Check its channel page.",
      );
    }
    expect(describeBlockedDeskReply(connection({ enabled: false, status: "paused", label: "Family bot" }))).toBe(
      "Turn Family bot back on to reply.",
    );
    expect(describeBlockedDeskReply(undefined)).toBe("This channel was removed. Its conversations stay readable.");
  });

  it("accepts a durable desk event with a stable idempotency key", async () => {
    const { service } = await createAcceptingService();
    const route = { channel: "telegram", account: "telegram-1", peer: "chat:4242" };
    const session = resolveSessionRoute(route);
    const input = {
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      binding: binding({ sessionId: session.sessionId, target: "chat:4242" }),
      content: "  What's on my calendar today?  ",
      idempotencyKey: "request-1",
    };
    const host = vi.fn((acceptance: Parameters<InboundChannelEventService["acceptOperatorDeskEvent"]>[0]) =>
      service.acceptOperatorDeskEvent(acceptance),
    );

    const first = await acceptOperatorDeskTurn(host, input);
    const second = await acceptOperatorDeskTurn(host, input);

    expect(host).toHaveBeenCalledTimes(2);
    expect(host.mock.calls[0]?.[0]).toEqual({
      channelKey: "telegram",
      connectionId: "telegram-1",
      transport: "operator_desk",
      dispatchKind: "operator_desk_turn",
      idempotencyKey: `desk:${session.sessionId}:request-1`,
      // The lane provider ingress gives this conversation, so a phone message and a desk question keep their order.
      laneKey: "telegram:telegram-1:chat:4242",
      payload: {
        eventType: "operator_desk_turn",
        bindingTarget: "chat:4242",
        message: {
          eventId: `desk:${session.sessionId}:request-1`,
          account: "telegram-1",
          // The session key stores the peer percent-encoded; the payload carries the decoded route.
          peer: "chat:4242",
          actorId: "operator",
          actorType: "user",
          content: "What's on my calendar today?",
        },
      },
    });
    const first0 = await host.mock.results[0]?.value;
    const second0 = await host.mock.results[1]?.value;
    expect(second0.event.eventId).toBe(first0.event.eventId);
    expect(first.userMessage.messageId).toBe(second.userMessage.messageId);
    expect(first.userMessage.messageId).toMatch(/^inbound-message-[a-f0-9]{32}$/);
    expect(first).toMatchObject({
      sessionId: session.sessionId,
      transport: "integration",
      turnId: expect.stringMatching(/^inbound-turn-[a-f0-9]{32}$/),
      userMessage: {
        sessionId: session.sessionId,
        role: "user",
        actorType: "user",
        actorId: "operator",
        sourceAuthority: "operator",
        content: "What's on my calendar today?",
      },
    });

    // A different request key is a different question.
    const third = await acceptOperatorDeskTurn(host, { ...input, idempotencyKey: "request-2" });
    expect(third.userMessage.messageId).not.toBe(first.userMessage.messageId);
  });

  it("routes a desk send only in the operator's own conversation and refuses it while the channel is off", async () => {
    const route = { channel: "telegram", account: "telegram-1", peer: OWNER_ID };
    const session = resolveSessionRoute(route);
    const host = vi.fn(async () => {
      throw new Error("must not accept");
    });
    const base = {
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      content: "hi",
      idempotencyKey: "request-1",
    };

    await expect(routeOperatorDeskSend({ ...base, binding: undefined, connection: undefined }, host)).resolves.toEqual({
      mode: "post",
    });
    await expect(
      routeOperatorDeskSend(
        { ...base, binding: binding({ conversation: { kind: "group" } }), connection: connection() },
        host,
      ),
    ).resolves.toEqual({ mode: "post" });
    await expect(
      routeOperatorDeskSend({ ...base, binding: binding(), connection: connection({ enabled: false }) }, host),
    ).resolves.toEqual({ mode: "blocked", message: "Turn Telegram back on to reply." });
    expect(host).not.toHaveBeenCalled();
  });

  it("refuses a WhatsApp desk send outside the window, in both modes", async () => {
    const now = new Date("2026-10-29T12:00:00.000Z");
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
    const whatsapp = connection({
      connectionId: "whatsapp-1",
      catalogId: "channel.whatsapp",
      key: "whatsapp",
      label: "WhatsApp",
    });
    const session = resolveSessionRoute({ channel: "whatsapp", account: "whatsapp-1", peer: OWNER_ID });
    const base = {
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      content: "hi",
      idempotencyKey: "request-1",
      now: () => now,
    };
    const own = binding({ sessionId: session.sessionId, connectionId: "whatsapp-1" });
    const someoneElses = binding({
      sessionId: session.sessionId,
      connectionId: "whatsapp-1",
      conversation: { kind: "direct", counterpartActorId: "9999" },
    });
    const host = vi.fn(async () => ({
      event: { receivedAt: now.toISOString() },
      messageId: "message-1",
      turnId: "turn-1",
    }));
    const route = (input: Parameters<typeof routeOperatorDeskSend>[0]) =>
      routeOperatorDeskSend(input, host as unknown as Parameters<typeof routeOperatorDeskSend>[1]);
    const closed = { mode: "blocked", message: WHATSAPP_REPLY_WINDOW_CLOSED };

    // Closed: their last message is 25 hours old, or there is none on record. Nothing is accepted.
    for (const lastInboundAt of [hoursAgo(25), hoursAgo(24), undefined]) {
      await expect(route({ ...base, binding: own, connection: whatsapp, lastInboundAt })).resolves.toEqual(closed);
      await expect(route({ ...base, binding: someoneElses, connection: whatsapp, lastInboundAt })).resolves.toEqual(
        closed,
      );
    }
    expect(host).not.toHaveBeenCalled();

    // Open: their last message is an hour old, so the send goes on as it does today.
    await expect(
      route({ ...base, binding: someoneElses, connection: whatsapp, lastInboundAt: hoursAgo(1) }),
    ).resolves.toEqual({ mode: "post" });
    await expect(
      route({ ...base, binding: own, connection: whatsapp, lastInboundAt: hoursAgo(1) }),
    ).resolves.toMatchObject({ mode: "ask", response: { sessionId: session.sessionId, turnId: "turn-1" } });
    expect(host).toHaveBeenCalledOnce();

    // Another channel has no window, and no last message on record keeps its send as it is today.
    host.mockClear();
    const telegram = resolveSessionRoute({ channel: "telegram", account: "telegram-1", peer: OWNER_ID });
    const telegramBase = { ...base, sessionId: telegram.sessionId, sessionKey: telegram.sessionKey };
    await expect(
      route({
        ...telegramBase,
        binding: binding({
          sessionId: telegram.sessionId,
          conversation: { kind: "direct", counterpartActorId: "9999" },
        }),
        connection: connection(),
      }),
    ).resolves.toEqual({ mode: "post" });
    await expect(
      route({ ...telegramBase, binding: binding({ sessionId: telegram.sessionId }), connection: connection() }),
    ).resolves.toMatchObject({ mode: "ask" });
    expect(host).toHaveBeenCalledOnce();

    // A channel that is switched off says so, whatever the window says.
    await expect(
      route({
        ...base,
        binding: own,
        connection: { ...whatsapp, enabled: false },
        lastInboundAt: hoursAgo(25),
      }),
    ).resolves.toEqual({ mode: "blocked", message: "Turn WhatsApp back on to reply." });
  });

  it("keeps a local or mission chat bound to WhatsApp sending as it did, with no reply window", async () => {
    const now = new Date("2026-10-29T12:00:00.000Z");
    const whatsapp = connection({
      connectionId: "whatsapp-1",
      catalogId: "channel.whatsapp",
      key: "whatsapp",
      label: "WhatsApp",
    });
    // "Save binding" on a local chat: no channel conversation, and no message from the person on record.
    const { conversation: _conversation, ...savedBinding } = binding({
      sessionId: "local-1",
      connectionId: "whatsapp-1",
    });
    const host = vi.fn();
    await expect(
      routeOperatorDeskSend(
        {
          sessionId: "local-1",
          sessionKey: "local-1",
          content: "hi",
          idempotencyKey: "request-1",
          binding: savedBinding,
          connection: whatsapp,
          now: () => now,
        },
        host,
      ),
    ).resolves.toEqual({ mode: "post" });
    expect(host).not.toHaveBeenCalled();
  });

  it("refuses a desk question whose session key does not name its session", async () => {
    const host = vi.fn();
    await expect(
      acceptOperatorDeskTurn(host, {
        sessionId: "sess_not-this-one",
        sessionKey: "telegram:telegram-1:4242",
        binding: binding(),
        content: "hi",
        idempotencyKey: "request-1",
      }),
    ).rejects.toThrow();
    await expect(
      acceptOperatorDeskTurn(host, {
        ...validDeskInput(),
        content: "   ",
      }),
    ).rejects.toThrow();
    await expect(acceptOperatorDeskTurn(host, { ...validDeskInput(), idempotencyKey: " " })).rejects.toThrow();
    expect(host).not.toHaveBeenCalled();
  });

  it("records a desk question as the operator with operator authority, and anything else as channel input", async () => {
    const ingestEvent = vi.fn(async () => "operator-recorded");
    const ingestChannelMessage = vi.fn(async () => "channel-recorded");
    const message = { eventId: "message-1", account: "telegram-1", peer: OWNER_ID, actorId: "someone", content: "hi" };

    await expect(
      recordInboundChannelMessage(
        { channel: "telegram", idempotencyKey: "event-1", message, origin: "operator_desk" },
        ingestEvent,
        ingestChannelMessage,
      ),
    ).resolves.toBe("operator-recorded");
    expect(ingestEvent).toHaveBeenCalledExactlyOnceWith(
      "event-1",
      expect.objectContaining({ actor: { type: "user", id: "operator" }, message: { role: "user", content: "hi" } }),
      { sourceAuthority: "operator" },
    );
    expect(ingestChannelMessage).not.toHaveBeenCalled();

    await expect(
      recordInboundChannelMessage(
        { channel: "telegram", idempotencyKey: "event-2", message },
        ingestEvent,
        ingestChannelMessage,
      ),
    ).resolves.toBe("channel-recorded");
    expect(ingestChannelMessage).toHaveBeenCalledExactlyOnceWith("telegram", "event-2", message);
    expect(ingestEvent).toHaveBeenCalledOnce();
  });

  it("quotes at most the first 200 characters of the desk question", () => {
    expect(buildDeskDeliveryPrefix("  Where is the spare key?  ")).toBe(
      'From your desk: "Where is the spare key?"\n\n',
    );
    const long = "x".repeat(250);
    // A cut quote says so inside its closing quote mark.
    expect(buildDeskDeliveryPrefix(long)).toBe(`From your desk: "${"x".repeat(200)}…"\n\n`);
    expect(buildDeskDeliveryPrefix("x".repeat(200))).toBe(`From your desk: "${"x".repeat(200)}"\n\n`);
  });

  it("escapes the quoted question for the Telegram connection's parse mode", () => {
    const telegram = (parseMode?: string) => ({ key: "telegram", config: parseMode ? { parseMode } : {} });
    // Telegram's guided setup saves Markdown; an unmatched underscore would make it reject the whole answer.
    expect(buildDeskDeliveryPrefix("status of PR_123?", telegram("Markdown"))).toBe(
      'From your desk: "status of PR\\_123?"\n\n',
    );
    expect(buildDeskDeliveryPrefix("a *b* `c` [d]", telegram("markdown"))).toBe(
      'From your desk: "a \\*b\\* \\`c\\` \\[d]"\n\n',
    );
    expect(buildDeskDeliveryPrefix("PR_1 (v2.0)! a-b \\ ok", telegram("MarkdownV2"))).toBe(
      'From your desk: "PR\\_1 \\(v2\\.0\\)\\! a\\-b \\\\ ok"\n\n',
    );
    expect(buildDeskDeliveryPrefix("Is 1 < 2 & 3 > 2?", telegram("HTML"))).toBe(
      'From your desk: "Is 1 &lt; 2 &amp; 3 &gt; 2?"\n\n',
    );
    // No parse mode, or another channel, sends the text as typed.
    expect(buildDeskDeliveryPrefix("status of PR_123?", telegram())).toBe('From your desk: "status of PR_123?"\n\n');
    expect(buildDeskDeliveryPrefix("PR_123", { key: "slack", config: { parseMode: "Markdown" } })).toBe(
      'From your desk: "PR_123"\n\n',
    );
    // The cut happens before escaping, so an escape is never split and the ellipsis stays outside it.
    expect(buildDeskDeliveryPrefix(`${"x".repeat(199)}_tail`, telegram("Markdown"))).toBe(
      `From your desk: "${"x".repeat(199)}\\_…"\n\n`,
    );
  });

  it("refuses files and templates in the operator's own conversation, before accepting anything", async () => {
    const session = resolveSessionRoute({ channel: "telegram", account: "telegram-1", peer: OWNER_ID });
    const host = vi.fn(async () => {
      throw new Error("must not accept");
    });
    const base = {
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      content: "hi",
      idempotencyKey: "request-1",
      binding: binding({ sessionId: session.sessionId }),
      connection: connection(),
    };
    const refused = { mode: "refused", message: "Files and templates aren't sent in channel conversations." };
    for (const extra of [
      { attachments: ["attachment-1"] },
      {
        parts: [
          { type: "text", text: "hi" },
          { type: "image_ref", attachmentId: "attachment-1" },
        ],
      },
      { templateInvocation: { ownerKind: "prompt_pack", ownerId: "pack-1" } },
      { workspaceSnapshot: { mode: "summary" } },
    ]) {
      await expect(routeOperatorDeskSend({ ...base, ...extra }, host)).resolves.toEqual(refused);
    }
    expect(host).not.toHaveBeenCalled();
    // Text-only parts and an empty attachment list carry nothing extra.
    await expect(
      routeOperatorDeskSend({ ...base, attachments: [], parts: [{ type: "text", text: "hi" }] }, async () => {
        throw new Error("accepted");
      }),
    ).rejects.toThrow("accepted");
    // A verbatim post keeps today's path, whatever it carries.
    await expect(
      routeOperatorDeskSend(
        { ...base, binding: binding({ conversation: { kind: "group" } }), attachments: ["a"] },
        host,
      ),
    ).resolves.toEqual({ mode: "post" });
  });

  it("carries the operator's provider and model choice into the desk event", () => {
    expect(
      buildOperatorDeskAcceptance({ ...validDeskInput(), providerId: " openai ", model: "gpt-5.1" }).payload,
    ).toMatchObject({ responseOptions: { providerId: "openai", model: "gpt-5.1" } });
    expect(buildOperatorDeskAcceptance(validDeskInput()).payload).not.toHaveProperty("responseOptions");
  });

  it("answers a queued desk question only against the binding as it is now", () => {
    const check = (overrides: Partial<Parameters<typeof resolveDeskQuestionGate>[0]> = {}) =>
      resolveDeskQuestionGate({
        binding: binding(),
        connectionId: "telegram-1",
        bindingTarget: OWNER_ID,
        connection: connection(),
        ...overrides,
      });
    const suppressed = (reason: RegExp) => ({ action: "suppress", reason: expect.stringMatching(reason) });

    expect(check()).toEqual({ action: "allow" });
    // The session or its binding is gone, or the conversation is no longer a channel conversation.
    expect(check({ binding: undefined })).toEqual(suppressed(/no longer bound/));
    expect(check({ binding: binding({ transport: "llm", connectionId: undefined, target: undefined }) })).toEqual(
      suppressed(/no longer bound/),
    );
    // The operator switched the conversation to read-only while the question waited.
    expect(check({ binding: binding({ writable: false }) })).toEqual(suppressed(/read-only/));
    // The binding was re-pointed at another connection or target while the question waited.
    expect(check({ binding: binding({ connectionId: "telegram-2" }) })).toEqual(suppressed(/somewhere else/));
    expect(check({ binding: binding({ target: "9999" }) })).toEqual(suppressed(/somewhere else/));
    expect(check({ bindingTarget: undefined })).toEqual(suppressed(/somewhere else/));
    // The channel is off or not connected.
    expect(check({ connection: connection({ enabled: false }) })).toEqual(suppressed(/off or not connected/));
    expect(check({ connection: connection({ status: "error" }) })).toEqual(suppressed(/off or not connected/));
    // The conversation is no longer provably the operator's own.
    expect(check({ connection: connection({ config: { ownerActorIds: [] } }) })).toEqual(suppressed(/your own/));
    expect(check({ binding: binding({ conversation: { kind: "group" } }) })).toEqual(suppressed(/your own/));
  });

  it("queues a desk question in the lane provider ingress gives the same conversation", async () => {
    const { service, storage } = await createAcceptingService();
    const rotated = createTelegramChannelSessionPatch({ config: {}, chatId: OWNER_ID, actorId: OWNER_ID });
    const cases: Array<{ name: string; input: DurableInboundChannelAcceptInput }> = [
      { name: "Telegram private chat", input: telegramPrivateChat({}) },
      { name: "Telegram private chat after /new", input: telegramPrivateChat(rotated) },
      { name: "Slack IM", input: slackIm() },
      { name: "WhatsApp chat", input: whatsAppChat() },
      { name: "Discord DM", input: await discordDm() },
    ];

    for (const { name, input } of cases) {
      const phone = await service.accept(input);
      const phoneLane = storage.inboundChannelEvents.get(phone.inboundEventId)?.laneKey;
      // The session this conversation's phone messages land in, which is the session the desk question names.
      const session = resolveSessionRoute({ channel: input.channel, ...input.message });
      const desk = await acceptOperatorDeskTurn((acceptance) => service.acceptOperatorDeskEvent(acceptance), {
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        binding: binding({
          sessionId: session.sessionId,
          connectionId: input.connectionId,
          target: input.bindingTarget,
        }),
        content: "And where did I park?",
        idempotencyKey: `desk-${name}`,
      });
      const deskEvent = storage.inboundChannelEvents.getByIdentity({
        channelKey: input.channel,
        connectionId: input.connectionId,
        idempotencyKey: `desk:${session.sessionId}:desk-${name}`,
      });
      expect({ name, lane: deskEvent?.laneKey }).toEqual({ name, lane: phoneLane });
      expect(desk.sessionId).toBe(session.sessionId);
    }

    // A later desk question waits until the earlier phone message in its conversation settles.
    const due = storage.inboundChannelEvents.claimDue({ ownerId: "lane-probe", leaseDurationMs: 30_000, limit: 50 });
    expect(due.map((claim) => claim.event.transport)).toEqual(cases.map(() => "provider_webhook"));
  });

  it("keeps the session's own lane only when its address names no conversation", () => {
    expect(buildDeskLaneKey({ channel: "telegram", account: "telegram-1" }, "telegram-1", "sess-1")).toBe(
      "session:sess-1",
    );
    expect(
      buildDeskLaneKey({ channel: "slack", account: "slack-1", room: "C1", threadId: "171.2" }, "slack-1", "sess-2"),
    ).toBe("slack:slack-1:C1:171.2");
  });

  async function createAcceptingService(): Promise<{ service: InboundChannelEventService; storage: Storage }> {
    const root = await mkdtemp(path.join(tmpdir(), "channel-desk-turn-"));
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    // Admission stays closed for workers, so the accepted event is only committed here, never processed.
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    await lifecycle.drain({ mode: "graceful", reason: "test", actorId: "test", timeoutMs: 10 });
    const tasks = new Set<Promise<void>>();
    const service = new InboundChannelEventService({
      storage,
      ownerId: "desk-test-worker",
      isClosing: () => false,
      registerBackgroundTask: (task) => {
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      },
      sharedHostLifecycle: lifecycle,
      getIntegrationConnection: async () => {
        throw new Error("not processed in this test");
      },
      ingestChannelMessage: vi.fn(),
      ensureInboundChatSession: vi.fn(),
      readChatSessionBinding: vi.fn(),
      hasRunningTurn: async () => false,
      respondToExistingChatMessage: vi.fn(),
      transcribeChannelVoice: vi.fn(),
      executeInboundCommand: vi.fn(),
      decideBotLoop: () => ({ action: "allow" }),
      emitChannelActivity: vi.fn(),
    });
    cleanups.push(async () => {
      service.close();
      await Promise.allSettled([...tasks]);
      storage.close();
      await rm(root, { recursive: true, force: true });
    });
    return { service, storage };
  }
});

/**
 * Each provider event below is built the way its channel's producer builds it: the real webhook normalizer, then
 * the route's own mapping into the durable acceptance (Telegram, Slack, WhatsApp), or the real Discord producer.
 */
function telegramPrivateChat(config: Record<string, unknown>): DurableInboundChannelAcceptInput {
  const parsed = normalizeTelegramWebhookPayload({
    connectionId: "telegram-1",
    payload: {
      update_id: 1,
      message: {
        message_id: 7,
        from: { id: Number(OWNER_ID), is_bot: false, first_name: "Alex" },
        chat: { id: Number(OWNER_ID), type: "private" },
        text: "Parked on level 3.",
      },
    },
  });
  if (parsed.kind !== "message") {
    throw new Error(`Telegram fixture was not a message: ${parsed.kind}`);
  }
  const routed = applyTelegramChannelSessionRotation(config, {
    peer: parsed.peer,
    room: parsed.room,
    threadId: parsed.threadId,
  });
  return {
    channel: "telegram",
    connectionId: "telegram-1",
    idempotencyKey: `telegram:update-1:${Object.keys(config).length}`,
    eventType: parsed.eventType,
    bindingTarget: parsed.room ?? parsed.peer,
    dispatchKind: "agent_turn",
    message: {
      eventId: parsed.eventId,
      account: parsed.account,
      peer: routed.peer,
      room: routed.room,
      threadId: routed.threadId,
      actorId: parsed.actorId,
      actorType: parsed.actorType,
      content: parsed.content,
    },
  };
}

function slackIm(): DurableInboundChannelAcceptInput {
  const parsed = normalizeSlackWebhookPayload({
    connectionId: "slack-1",
    payload: {
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev1",
      event: { type: "message", channel: "D123", channel_type: "im", user: "U42", text: "Parked.", ts: "171.1" },
    },
  });
  if (parsed.kind !== "message") {
    throw new Error(`Slack fixture was not a message: ${parsed.kind}`);
  }
  return {
    channel: "slack",
    connectionId: "slack-1",
    idempotencyKey: "slack:Ev1",
    eventType: parsed.eventType,
    bindingTarget: parsed.room ?? parsed.peer,
    dispatchKind: "agent_turn",
    message: {
      eventId: parsed.eventId,
      account: parsed.account,
      peer: parsed.peer,
      room: parsed.room,
      threadId: parsed.threadId,
      actorId: parsed.actorId,
      actorType: parsed.actorType,
      content: parsed.content,
    },
  };
}

function whatsAppChat(): DurableInboundChannelAcceptInput {
  const [parsed] = normalizeWhatsAppWebhookPayloads({
    connectionId: "whatsapp-1",
    payload: {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "15551234567", profile: { name: "Alex" } }],
                messages: [{ from: "15551234567", id: "wamid.1", type: "text", text: { body: "Parked." } }],
              },
            },
          ],
        },
      ],
    },
  });
  if (parsed?.kind !== "message") {
    throw new Error(`WhatsApp fixture was not a message: ${parsed?.kind}`);
  }
  return {
    channel: "whatsapp",
    connectionId: "whatsapp-1",
    idempotencyKey: "whatsapp:wamid.1",
    eventType: parsed.eventType,
    bindingTarget: parsed.peer,
    dispatchKind: "agent_turn",
    message: {
      eventId: parsed.eventId,
      account: parsed.account,
      peer: parsed.peer,
      actorId: parsed.actorId,
      actorType: parsed.actorType,
      content: parsed.content,
    },
  };
}

/** What the real Discord producer hands to durable acceptance for a direct message. */
async function discordDm(): Promise<DurableInboundChannelAcceptInput> {
  let produced: DurableInboundChannelAcceptInput | undefined;
  const host = {
    storage: { systemSettings: { get: async () => undefined } },
    isFeatureEnabled: async () => false,
    acceptInboundChannelEvent: async (input: DurableInboundChannelAcceptInput) => {
      produced = input;
      return { accepted: true, durableAccepted: true, deduped: false, replied: false, queued: true };
    },
  } as unknown as DiscordRuntimeBridgeHost;
  await handleDiscordRuntimeInbound(host, {
    connectionId: "discord-1",
    target: "dm-channel-1",
    actorId: "u42",
    content: "Parked.",
    sourceMessageId: "m1",
    peer: "u42",
    room: "dm-channel-1",
    conversation: { kind: "direct", counterpartActorId: "u42" },
  });
  if (!produced) {
    throw new Error("The Discord producer accepted nothing.");
  }
  return produced;
}

function validDeskInput() {
  const session = resolveSessionRoute({ channel: "telegram", account: "telegram-1", peer: OWNER_ID });
  return {
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    binding: binding({ sessionId: session.sessionId }),
    content: "hi",
    idempotencyKey: "request-1",
  };
}
