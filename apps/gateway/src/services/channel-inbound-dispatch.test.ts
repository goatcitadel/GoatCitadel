import { describe, expect, it, vi } from "vitest";
import { dispatchInboundWebhookMessage, type IntegrationWebhookRouteLike } from "./channel-inbound-dispatch.js";

/**
 * Direct tests for the shared default-deny sender-allowlist gate in
 * channel-inbound-dispatch.ts (evaluateInboundWebhookAccess, invoked at the
 * top of dispatchInboundWebhookMessage). This is the exact seam every
 * inbound-capable channel (Telegram, Slack, WhatsApp, LINE, Nextcloud Talk,
 * plus the Signal bridge poller) dispatches through, so it is tested here
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
  } as unknown as IntegrationWebhookRouteLike & {
    ingestChannelMessage: ReturnType<typeof vi.fn>;
    setChatSessionBinding: ReturnType<typeof vi.fn>;
    respondToExistingChatMessage: ReturnType<typeof vi.fn>;
    emitChannelActivity: ReturnType<typeof vi.fn>;
    recordDevDiagnostic: ReturnType<typeof vi.fn>;
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

  it("allows a matching sender on a populated allowlist and proceeds through ingest", async () => {
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
      deduped: false,
      replied: true,
      sessionId: "session-1",
      turnId: "turn-1",
      eventType: "message",
    });
    expect(gateway.ingestChannelMessage).toHaveBeenCalledTimes(1);
    expect(gateway.setChatSessionBinding).toHaveBeenCalledWith({
      sessionId: "session-1",
      transport: "integration",
      connectionId: CONNECTION_ID,
      target: "C1",
      writable: true,
    });
    expect(gateway.respondToExistingChatMessage).toHaveBeenCalledTimes(1);
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
        replied: true,
        sessionId: "session-1",
      }),
    );
    expect(gateway.ingestChannelMessage).toHaveBeenCalledTimes(1);
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
        replied: true,
        sessionId: "session-1",
      }),
    );
    expect(gateway.ingestChannelMessage).toHaveBeenCalledTimes(1);
    expect(gateway.recordDevDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.sender_not_allowlisted" }),
    );
  });
});
