import { describe, expect, it, vi } from "vitest";
import type { InboundChannelCommandExecutionInput } from "./inbound-channel-event-service.js";
import {
  executeTelegramInboundCommand,
  TELEGRAM_APPROVAL_CALLBACK_EVENT_TYPE,
  TELEGRAM_CHANNEL_COMMAND_EVENT_TYPE,
  type TelegramInboundCommandHost,
} from "./telegram-inbound-command-service.js";

describe("executeTelegramInboundCommand", () => {
  it("applies operator command mutations only inside the durable executor", async () => {
    const { host, update } = createHost({ telegramOperatorActors: ["777"] });

    const result = await executeTelegramInboundCommand(host, createInput({ content: "/sethome" }));

    expect(result.resultText).toContain("Home channel set");
    expect(update).toHaveBeenCalledWith(
      CONNECTION_ID,
      expect.objectContaining({
        config: expect.objectContaining({
          defaultChannelId: CHAT_ID,
          defaultChatId: CHAT_ID,
        }),
      }),
    );
  });

  it("resolves approval callbacks by opaque action id without a bearer token", async () => {
    const { host, resolveApprovalWithRemoteTokenId } = createHost();
    const input = createInput({
      eventType: TELEGRAM_APPROVAL_CALLBACK_EVENT_TYPE,
      content: "/approve",
      metadata: {
        approvalDecision: "approve",
        approvalActionId: "opaque-action-1",
        approvalActionLookupFailed: false,
      },
    });

    const result = await executeTelegramInboundCommand(host, input);

    expect(result.resultText).toContain("Approved approval-1");
    expect(resolveApprovalWithRemoteTokenId).toHaveBeenCalledWith({
      tokenId: "opaque-action-1",
      connectorId: `integration:${CONNECTION_ID}`,
      decision: "approve",
      resolvedBy: "telegram:777",
    });
    expect(JSON.stringify(input)).not.toContain("grat_secret");
  });

  it("does not execute an approval when token lookup failed before acceptance", async () => {
    const { host, resolveApprovalWithRemoteTokenId } = createHost();

    const result = await executeTelegramInboundCommand(
      host,
      createInput({
        eventType: TELEGRAM_APPROVAL_CALLBACK_EVENT_TYPE,
        content: "/reject",
        metadata: {
          approvalDecision: "reject",
          approvalActionLookupFailed: true,
        },
      }),
    );

    expect(result.resultText).toContain("could not match that approval action");
    expect(resolveApprovalWithRemoteTokenId).not.toHaveBeenCalled();
  });

  it("rejects approval envelopes that still contain a bearer token", async () => {
    const { host, resolveApprovalWithRemoteTokenId } = createHost();

    await expect(
      executeTelegramInboundCommand(
        host,
        createInput({
          eventType: TELEGRAM_APPROVAL_CALLBACK_EVENT_TYPE,
          content: "/approve grat_secret",
          metadata: {
            approvalDecision: "approve",
            approvalActionId: "opaque-action-1",
          },
        }),
      ),
    ).rejects.toThrow("does not match its secret-free command metadata");
    expect(resolveApprovalWithRemoteTokenId).not.toHaveBeenCalled();
  });

  it("rejects a command whose operation identity differs from its acceptance identity", async () => {
    const { host } = createHost();

    await expect(
      executeTelegramInboundCommand(host, {
        ...createInput({ content: "/status" }),
        operationKey: "different-operation",
      }),
    ).rejects.toThrow("operation identity does not match its acceptance identity");
  });
});

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_ID = "-100123";

function createInput(input: {
  eventType?: string;
  content: string;
  metadata?: Record<string, unknown>;
}): InboundChannelCommandExecutionInput {
  return {
    eventType: input.eventType ?? TELEGRAM_CHANNEL_COMMAND_EVENT_TYPE,
    inboundEventId: "inbound-1",
    operationKey: "telegram:command:1",
    idempotencyKey: "telegram:command:1",
    channel: "telegram",
    connectionId: CONNECTION_ID,
    bindingTarget: CHAT_ID,
    message: {
      eventId: "telegram-event-1",
      account: CONNECTION_ID,
      room: CHAT_ID,
      actorId: "777",
      actorType: "user",
      content: input.content,
      displayName: "Ada",
      metadata: input.metadata,
    },
  };
}

function createHost(config: Record<string, unknown> = {}) {
  const update = vi.fn();
  const resolveApprovalWithRemoteTokenId = vi.fn(async () => ({
    approval: { approvalId: "approval-1", status: "approved" },
  }));
  const host: TelegramInboundCommandHost = {
    storage: {
      integrationConnections: {
        get: () => ({
          connectionId: CONNECTION_ID,
          label: "Telegram",
          enabled: true,
          status: "connected",
          config,
        }),
        update,
      },
    },
    getPersonalityCatalog: () => ({ items: [], defaultPersonalityId: "default" }),
    hasRunningTurn: () => false,
    parseChatCommand: vi.fn(async () => ({ message: "Command completed." })),
    cancelLatestActiveChatTurnForSession: vi.fn(async () => ({ status: "no_active_run" as const })),
    resolveApprovalWithRemoteTokenId,
  };
  return { host, update, resolveApprovalWithRemoteTokenId };
}
