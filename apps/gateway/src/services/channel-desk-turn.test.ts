import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSessionRoute } from "@goatcitadel/gateway-core";
import { Storage } from "@goatcitadel/storage";
import type { ChatSessionBindingRecord, IntegrationConnection } from "@goatcitadel/contracts";
import {
  acceptOperatorDeskTurn,
  buildDeskDeliveryPrefix,
  buildOperatorDeskAcceptance,
  describeBlockedDeskReply,
  recordInboundChannelMessage,
  resolveDeskConversationMode,
  routeOperatorDeskSend,
} from "./channel-desk-turn.js";
import { InboundChannelEventService } from "./inbound-channel-event-service.js";
import { SharedHostLifecycleService } from "./shared-host-lifecycle-service.js";

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
    const service = await createAcceptingService();
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
      laneKey: `session:${session.sessionId}`,
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

  async function createAcceptingService(): Promise<InboundChannelEventService> {
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
    return service;
  }
});

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
