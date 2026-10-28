import { describe, expect, it, vi } from "vitest";
import { GatewayDevDiagnosticsService } from "../dev-diagnostics/service.js";
import {
  dispatchInboundVoiceWebhookMessage,
  dispatchInboundWebhookBatch,
  dispatchInboundWebhookMessage,
  type IntegrationWebhookRouteLike,
} from "./channel-inbound-dispatch.js";

/**
 * Direct tests for the shared default-deny sender-allowlist gate in
 * channel-inbound-dispatch.ts (evaluateInboundWebhookAccess, invoked at the
 * top of dispatchInboundWebhookMessage). This is the exact seam every
 * inbound-capable webhook channel (Telegram, Slack, WhatsApp, LINE, and
 * Nextcloud Talk) dispatches through, so it is tested here
 * independent of any single channel's webhook route/signature verification.
 *
 * Channel-specific route tests (e.g. whatsapp-webhook.test.ts) and the
 * contract-level evaluateChannelInboundAccess tests
 * (packages/contracts/src/channel-access.test.ts) already exist; this file
 * pins the gate behavior AT THIS MODULE so a future refactor of the shared
 * seam is caught here directly, not only transitively through one channel's
 * route test.
 */

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";

function createGateway(): IntegrationWebhookRouteLike & {
  ingestChannelMessage: ReturnType<typeof vi.fn>;
  setChatSessionBinding: ReturnType<typeof vi.fn>;
  respondToExistingChatMessage: ReturnType<typeof vi.fn>;
  emitChannelActivity: ReturnType<typeof vi.fn>;
  recordDevDiagnostic: ReturnType<typeof vi.fn>;
  acceptInboundChannelEvent: ReturnType<typeof vi.fn>;
} {
  return {
    getIntegrationConnection: vi.fn(),
    cancelLatestActiveChatTurnForSession: vi.fn(),
    ingestChannelMessage: vi.fn(async () => ({
      deduped: false,
      session: { sessionId: "session-1" },
    })),
    setChatSessionBinding: vi.fn(),
    respondToExistingChatMessage: vi.fn(async () => ({ turnId: "turn-1" })),
    resolveApprovalWithRemoteTokenId: vi.fn(),
    resolveApprovalWithRemoteToken: vi.fn(),
    hasRunningTurn: vi.fn(() => false),
    parseChatCommand: vi.fn(),
    emitChannelActivity: vi.fn(async () => ({ effects: [] }) as never),
    recordDevDiagnostic: vi.fn(),
    updateIntegrationConnection: vi.fn(),
    acceptInboundChannelEvent: vi.fn(async (input: { eventType: string; message: { eventId: string } }) => ({
      accepted: true as const,
      durableAccepted: true as const,
      deduped: false,
      replied: false as const,
      queued: true,
      eventType: input.eventType,
      inboundEventId: `inbound:${input.message.eventId}`,
    })),
  } as unknown as IntegrationWebhookRouteLike & {
    ingestChannelMessage: ReturnType<typeof vi.fn>;
    setChatSessionBinding: ReturnType<typeof vi.fn>;
    respondToExistingChatMessage: ReturnType<typeof vi.fn>;
    emitChannelActivity: ReturnType<typeof vi.fn>;
    recordDevDiagnostic: ReturnType<typeof vi.fn>;
    acceptInboundChannelEvent: ReturnType<typeof vi.fn>;
  };
}

describe("channel-inbound-dispatch shared sender-allowlist gate", () => {
  it("denies with allowlist_empty when allowlist mode is enabled and no senders are configured", async () => {
    const gateway = createGateway();

    const result = await dispatchInboundWebhookMessage(gateway, {
      channel: "slack",
      connectionId: CONNECTION_ID,
      idempotencyKey: "slack:event-empty",
      eventType: "message",
      bindingTarget: "C1",
      inboundAccessConfig: { inboundAccessMode: "allowlist" },
      message: {
        eventId: "event-empty",
        account: CONNECTION_ID,
        room: "C1",
        actorId: "U-Owner",
        content: "hello",
      },
    });

    expect(result).toEqual({
      accepted: true,
      replied: false,
      ignored: true,
      reason: "allowlist_empty",
      eventType: "message",
      inboundAccess: {
        mode: "allowlist",
        reason: "allowlist_empty",
      },
    });
    // Deny short-circuits BEFORE ingest/binding/response — the sender never
    // opens or continues a session.
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(gateway.setChatSessionBinding).not.toHaveBeenCalled();
    expect(gateway.respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(gateway.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        category: "channels",
        event: "channel.inbound_allowlist_empty",
        context: expect.objectContaining({
          channel: "slack",
          connectionId: CONNECTION_ID,
          reason: "allowlist_empty",
          allowedSenderCount: 0,
        }),
      }),
    );
  });

  it("allows a matching sender and commits it through durable acceptance", async () => {
    const gateway = createGateway();

    const result = await dispatchInboundWebhookMessage(gateway, {
      channel: "slack",
      connectionId: CONNECTION_ID,
      idempotencyKey: "slack:event-match",
      eventType: "message",
      bindingTarget: "C1",
      allowedSenders: ["u-owner"],
      message: {
        eventId: "event-match",
        account: CONNECTION_ID,
        room: "C1",
        actorId: "u-owner",
        content: "hello",
      },
    });

    expect(result).toEqual({
      accepted: true,
      durableAccepted: true,
      deduped: false,
      replied: false,
      queued: true,
      eventType: "message",
      inboundEventId: "inbound:event-match",
    });
    expect(gateway.acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchKind: "agent_turn", bindingTarget: "C1" }),
    );
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(gateway.setChatSessionBinding).not.toHaveBeenCalled();
    expect(gateway.respondToExistingChatMessage).not.toHaveBeenCalled();
    // No deny diagnostic should be recorded on the allow path.
    expect(gateway.recordDevDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.sender_not_allowlisted" }),
    );
  });

  it("denies with sender_not_allowlisted when the sender does not match the populated allowlist", async () => {
    const gateway = createGateway();

    const result = await dispatchInboundWebhookMessage(gateway, {
      channel: "slack",
      connectionId: CONNECTION_ID,
      idempotencyKey: "slack:event-mismatch",
      eventType: "message",
      bindingTarget: "C1",
      allowedSenders: ["u-owner"],
      message: {
        eventId: "event-mismatch",
        account: CONNECTION_ID,
        room: "C1",
        actorId: "u-intruder",
        content: "let me in",
      },
    });

    expect(result).toEqual({
      accepted: true,
      replied: false,
      ignored: true,
      reason: "sender_not_allowlisted",
      eventType: "message",
      inboundAccess: {
        mode: "allowlist",
        reason: "sender_not_allowlisted",
      },
    });
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(gateway.setChatSessionBinding).not.toHaveBeenCalled();
    expect(gateway.respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(gateway.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        category: "channels",
        event: "channel.sender_not_allowlisted",
        context: expect.objectContaining({
          channel: "slack",
          connectionId: CONNECTION_ID,
          reason: "sender_not_allowlisted",
          allowedSenderCount: 1,
        }),
      }),
    );
  });

  it("normalizes the inbound actorId (trims whitespace, lowercases) against a pre-normalized allowlist", async () => {
    // dispatchInboundWebhookMessage forwards options.allowedSenders straight
    // into evaluateChannelInboundAccess's `allowedSenders` input, which is
    // used VERBATIM (see packages/contracts/src/channel-access.ts:123 —
    // `input.allowedSenders ?? resolveAllowedSenders(config)`): only a
    // config-derived allowlist runs through resolveAllowedSenders' trim +
    // lowercase. Real callers (see whatsapp-webhook.ts) always pass an
    // already-lowercased `allowedSenders` array, so this pins the actual
    // contract: the actorId side is normalized (trimmed + lowercased) even
    // though the explicit allowedSenders array itself is taken as-is.
    const gateway = createGateway();

    const result = await dispatchInboundWebhookMessage(gateway, {
      channel: "slack",
      connectionId: CONNECTION_ID,
      idempotencyKey: "slack:event-normalize",
      eventType: "message",
      bindingTarget: "C1",
      allowedSenders: ["u-owner"],
      message: {
        eventId: "event-normalize",
        account: CONNECTION_ID,
        room: "C1",
        actorId: "  U-Owner  ",
        content: "hello",
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        durableAccepted: true,
        replied: false,
        queued: true,
      }),
    );
    expect(gateway.acceptInboundChannelEvent).toHaveBeenCalledTimes(1);
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(gateway.recordDevDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.sender_not_allowlisted" }),
    );
  });

  it("normalizes a config-derived allowlist (trims + lowercases entries) as well as the actorId", async () => {
    // When allowedSenders is NOT explicitly passed, dispatchInboundWebhookMessage
    // derives it from inboundAccessConfig via resolveAllowedSenders, which DOES
    // trim + lowercase every entry (packages/contracts/src/channel-access.ts,
    // resolveAllowedSenders). A mixed-case, whitespace-padded config entry must
    // still match a differently-cased actorId.
    const gateway = createGateway();

    const result = await dispatchInboundWebhookMessage(gateway, {
      channel: "slack",
      connectionId: CONNECTION_ID,
      idempotencyKey: "slack:event-normalize-config",
      eventType: "message",
      bindingTarget: "C1",
      inboundAccessConfig: {
        inboundAccessMode: "allowlist",
        allowedSenders: ["  U-Owner  "],
      },
      message: {
        eventId: "event-normalize-config",
        account: CONNECTION_ID,
        room: "C1",
        actorId: "u-owner",
        content: "hello",
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        durableAccepted: true,
        replied: false,
        queued: true,
      }),
    );
    expect(gateway.acceptInboundChannelEvent).toHaveBeenCalledTimes(1);
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(gateway.recordDevDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.sender_not_allowlisted" }),
    );
  });
});

describe("channel-inbound-dispatch durable boundary", () => {
  it("preserves the explicit binding target in the accepted envelope", async () => {
    const gateway = createGateway();

    await dispatchInboundWebhookMessage(gateway, {
      channel: "slack",
      connectionId: CONNECTION_ID,
      idempotencyKey: "slack:event-target-explicit",
      eventType: "message",
      bindingTarget: "explicit-target",
      allowedSenders: ["u-owner"],
      message: {
        eventId: "event-target-explicit",
        account: CONNECTION_ID,
        room: "room-should-be-ignored",
        peer: "peer-should-be-ignored",
        actorId: "u-owner",
        content: "hello",
      },
    });

    expect(gateway.acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingTarget: "explicit-target",
        dispatchKind: "agent_turn",
        message: expect.objectContaining({ room: "room-should-be-ignored", peer: "peer-should-be-ignored" }),
      }),
    );
    expect(gateway.emitChannelActivity).not.toHaveBeenCalled();
  });

  it("strips access configuration before the durable owner receives the envelope", async () => {
    const gateway = createGateway();
    await dispatchInboundWebhookMessage(gateway, {
      channel: "slack",
      connectionId: CONNECTION_ID,
      idempotencyKey: "slack:event-secret-free",
      eventType: "message",
      inboundAccessConfig: {
        inboundAccessMode: "allowlist",
        allowedSenders: ["u-owner"],
        signingSecret: "must-not-persist",
      },
      message: {
        eventId: "event-secret-free",
        account: CONNECTION_ID,
        room: "room-1",
        actorId: "u-owner",
        content: "hello",
      },
    });

    const accepted = gateway.acceptInboundChannelEvent.mock.calls[0]?.[0];
    expect(accepted).not.toHaveProperty("inboundAccessConfig");
    expect(accepted).not.toHaveProperty("allowedSenders");
    expect(JSON.stringify(accepted)).not.toContain("must-not-persist");
  });

  it("fails closed instead of acknowledging through an immediate fallback", async () => {
    const gateway = createGateway();
    Reflect.deleteProperty(gateway, "acceptInboundChannelEvent");

    await expect(
      dispatchInboundWebhookMessage(gateway, {
        channel: "slack",
        connectionId: CONNECTION_ID,
        idempotencyKey: "slack:event-no-owner",
        eventType: "message",
        allowedSenders: ["u-owner"],
        message: {
          eventId: "event-no-owner",
          account: CONNECTION_ID,
          actorId: "u-owner",
          content: "hello",
        },
      }),
    ).rejects.toThrow("Durable inbound channel acceptance is unavailable for message events");
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(gateway.respondToExistingChatMessage).not.toHaveBeenCalled();
  });
});

/**
 * The dropped-message diagnostic is where an operator who does not know their own sender id finds it: the guides
 * send them to System › Diagnostics, which shows the message text and not the context. So the message itself names
 * the sender. These tests run it through the real diagnostics service, so each id also has to survive the same
 * redaction the cockpit's copy goes through.
 */
describe("channel-inbound-dispatch dropped-message diagnostic names the sender", () => {
  const SENDER_IDS: ReadonlyArray<{ channel: string; name: string; actorId: string }> = [
    // QQ gives each sender an openid: 32 upper-case hex characters.
    { channel: "qqbot", name: "QQBot", actorId: "E4F5A6B7C8D90A1B2C3D4E5F60718293" },
    { channel: "matrix", name: "Matrix", actorId: "@alice:example.org" },
    { channel: "google-chat", name: "Google Chat", actorId: "users/123456789012345678901" },
    { channel: "slack", name: "Slack", actorId: "U0123ABCD" },
    { channel: "wecom", name: "WeCom", actorId: "ZhangSan" },
    { channel: "whatsapp", name: "WhatsApp", actorId: "15551234567" },
    { channel: "line", name: "LINE", actorId: "U4af4980629a1b2c3d4e5f60718293a4b" },
    { channel: "mattermost", name: "Mattermost", actorId: "b4f1ymmxa7fk7yoocguzuxcsne" },
    { channel: "nextcloud-talk", name: "Nextcloud Talk", actorId: "users/alice" },
    { channel: "ntfy", name: "ntfy", actorId: "ntfy-topic:goatcitadel-ops" },
    // Other shapes the same channels send: an external WeCom contact, a QQ guild member, a long Matrix id with
    // separators, a Slack Enterprise Grid id, a Google Chat id written with an email address.
    { channel: "wecom", name: "WeCom", actorId: "wmAbCdEfGhIjKlMnOpQrStUvWxYz012345" },
    { channel: "qqbot", name: "QQBot", actorId: "5124353476539285704" },
    { channel: "matrix", name: "Matrix", actorId: "@very.long_user-name:matrix.example.org" },
    { channel: "slack", name: "Slack", actorId: "W012A3CDE" },
    { channel: "google-chat", name: "Google Chat", actorId: "users/alice@example.org" },
  ];

  function createRecordingGateway() {
    const diagnostics = new GatewayDevDiagnosticsService(true, undefined, false, 20);
    const gateway = createGateway();
    gateway.recordDevDiagnostic.mockImplementation((input) => {
      diagnostics.record(input);
    });
    return { gateway, diagnostics };
  }

  function dispatchFrom(
    gateway: ReturnType<typeof createGateway>,
    input: { channel: string; actorId: string; allowedSenders?: string[] },
  ) {
    return dispatchInboundWebhookMessage(gateway, {
      channel: input.channel,
      connectionId: CONNECTION_ID,
      idempotencyKey: `${input.channel}:event-drop`,
      eventType: "message",
      bindingTarget: "room-1",
      inboundAccessConfig: {
        inboundAccessMode: "allowlist",
        ...(input.allowedSenders ? { allowedSenders: input.allowedSenders } : {}),
      },
      message: {
        eventId: "event-drop",
        account: CONNECTION_ID,
        room: "room-1",
        actorId: input.actorId,
        content: "hello",
      },
    });
  }

  function onlyDiagnostic(diagnostics: GatewayDevDiagnosticsService) {
    const items = diagnostics.list({ limit: 10 }).items;
    expect(items).toHaveLength(1);
    return items[0]!;
  }

  it.each(SENDER_IDS)(
    "names the $name sender when the allowed list is empty, and the id survives redaction",
    async ({ channel, name, actorId }) => {
      const { gateway, diagnostics } = createRecordingGateway();

      await dispatchFrom(gateway, { channel, actorId });

      const item = onlyDiagnostic(diagnostics);
      expect(item.event).toBe("channel.inbound_allowlist_empty");
      expect(item.message).toBe(
        `Dropped a ${name} message from ${actorId}: that sender isn't allowed yet. To allow them, add ${actorId} under Who may message this bot.`,
      );
      expect(item.context).toMatchObject({ channel, actorId });
    },
  );

  it.each(SENDER_IDS)(
    "names the $name sender when the allowed list does not include them, and the id survives redaction",
    async ({ channel, name, actorId }) => {
      const { gateway, diagnostics } = createRecordingGateway();

      await dispatchFrom(gateway, { channel, actorId, allowedSenders: ["someone-else"] });

      const item = onlyDiagnostic(diagnostics);
      expect(item.event).toBe("channel.sender_not_allowlisted");
      expect(item.message).toBe(
        `Dropped a ${name} message from ${actorId}: that sender isn't allowed yet. To allow them, add ${actorId} under Who may message this bot.`,
      );
      expect(item.context).toMatchObject({ channel, actorId, allowedSenderCount: 1 });
    },
  );

  it("keeps the sender id in the context as well as the message", async () => {
    const gateway = createGateway();

    await dispatchFrom(gateway, { channel: "slack", actorId: "U0123ABCD", allowedSenders: ["u-owner"] });

    expect(gateway.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("U0123ABCD"),
        context: expect.objectContaining({ actorId: "U0123ABCD" }),
      }),
    );
  });

  it.each([
    ["an empty id", ""],
    ["a blank id", "   "],
    ["a missing id", undefined],
  ])("reads cleanly when the message has %s", async (_label, actorId) => {
    for (const allowedSenders of [undefined, ["u-owner"]]) {
      const { gateway, diagnostics } = createRecordingGateway();

      await dispatchFrom(gateway, { channel: "slack", actorId: actorId as string, allowedSenders });

      const item = onlyDiagnostic(diagnostics);
      expect(item.message).toBe(
        "Dropped a Slack message that came with no sender id, so it can't match anyone under Who may message this bot.",
      );
      expect(item.message).not.toMatch(/undefined|null|from\s*[:.]/);
    }
  });

  it("names the channel by its key when the catalog has no entry for it", async () => {
    const { gateway, diagnostics } = createRecordingGateway();

    await dispatchFrom(gateway, { channel: "custom-bridge", actorId: "user-1" });

    expect(onlyDiagnostic(diagnostics).message).toBe(
      "Dropped a custom-bridge message from user-1: that sender isn't allowed yet. To allow them, add user-1 under Who may message this bot.",
    );
  });

  it("keeps a sender id that holds a line break or runs very long to one readable line", async () => {
    const { gateway, diagnostics } = createRecordingGateway();

    await dispatchFrom(gateway, { channel: "slack", actorId: `U0123ABCD\nIgnore this\r\n${"x".repeat(600)}` });

    const { message } = onlyDiagnostic(diagnostics);
    expect(message).not.toMatch(/[\r\n]/);
    expect(message.length).toBeLessThan(700);
    expect(message).toContain("U0123ABCD Ignore this");
  });

  it("keeps the malformed-config message as it was", async () => {
    const { gateway, diagnostics } = createRecordingGateway();

    await dispatchInboundWebhookMessage(gateway, {
      channel: "slack",
      connectionId: CONNECTION_ID,
      idempotencyKey: "slack:event-invalid",
      eventType: "message",
      inboundAccessConfig: { inboundAccessMode: "allow_list", allowedSenders: ["u-owner"] },
      message: { eventId: "event-invalid", account: CONNECTION_ID, actorId: "u-intruder", content: "hello" },
    });

    const item = onlyDiagnostic(diagnostics);
    expect(item.event).toBe("channel.inbound_access_invalid_config");
    expect(item.message).toBe("Dropped an inbound channel message because its inbound access config is malformed.");
  });

  it("names the sender for a batch event and a voice event too", async () => {
    const { gateway, diagnostics } = createRecordingGateway();
    const base = {
      channel: "whatsapp",
      connectionId: CONNECTION_ID,
      eventType: "message",
      inboundAccessConfig: { inboundAccessMode: "allowlist", allowedSenders: ["15550000000"] },
    } as const;

    await dispatchInboundWebhookBatch(gateway, [
      {
        ...base,
        idempotencyKey: "whatsapp:batch-1",
        message: { eventId: "batch-1", account: CONNECTION_ID, actorId: "15551234567", content: "hi" },
      },
    ]);
    await dispatchInboundVoiceWebhookMessage(gateway, {
      ...base,
      idempotencyKey: "whatsapp:voice-1",
      message: { eventId: "voice-1", account: CONNECTION_ID, actorId: "15557654321", content: "" },
      voice: { request: {} as never, fallbackContent: "voice note" },
    });

    const messages = diagnostics.list({ limit: 10 }).items.map((item) => item.message);
    expect(messages).toHaveLength(2);
    expect(messages.join("\n")).toContain("Dropped a WhatsApp message from 15551234567:");
    expect(messages.join("\n")).toContain("Dropped a WhatsApp message from 15557654321:");
  });
});
