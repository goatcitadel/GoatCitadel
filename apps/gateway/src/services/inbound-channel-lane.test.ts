import { describe, expect, it } from "vitest";
import { DISCORD_APPROVAL_BUTTON_EVENT_TYPE } from "./discord-approval-button.js";
import {
  buildInboundConversationLaneKey,
  buildInboundErrandControlLaneKey,
  INBOUND_ERRAND_CONTROL_LANE_PREFIX,
  isInboundApprovalCommand,
} from "./inbound-channel-lane.js";
import { TELEGRAM_APPROVAL_CALLBACK_EVENT_TYPE } from "./telegram-inbound-command-service.js";

describe("errand control lane", () => {
  it("keeps one control lane per conversation, apart from the conversation's own lane", () => {
    const conversation = buildInboundConversationLaneKey({
      channel: "telegram",
      connectionId: "connection-1",
      message: { account: "bot-1", room: "chat-1" },
    });
    expect(buildInboundErrandControlLaneKey(conversation)).toBe(`${INBOUND_ERRAND_CONTROL_LANE_PREFIX}${conversation}`);
    expect(buildInboundErrandControlLaneKey(conversation)).not.toBe(conversation);
  });

  it.each([TELEGRAM_APPROVAL_CALLBACK_EVENT_TYPE, DISCORD_APPROVAL_BUTTON_EVENT_TYPE])(
    "treats a %s command as an approval command",
    (eventType) => {
      expect(isInboundApprovalCommand({ dispatchKind: "command", eventType, message: {} })).toBe(true);
    },
  );

  it("reads approval commands from their secret-free decision metadata, and nothing else", () => {
    const command = (metadata?: Record<string, unknown>) => ({
      dispatchKind: "command",
      eventType: "telegram-channel-command",
      message: { ...(metadata ? { metadata } : {}) },
    });
    expect(isInboundApprovalCommand(command({ approvalDecision: "approve" }))).toBe(true);
    expect(isInboundApprovalCommand(command({ discordApprovalDecision: "reject" }))).toBe(true);
    expect(isInboundApprovalCommand(command())).toBe(false);
    expect(isInboundApprovalCommand(command({ approvalDecision: 1 }))).toBe(false);
    expect(
      isInboundApprovalCommand({
        dispatchKind: "agent_turn",
        eventType: TELEGRAM_APPROVAL_CALLBACK_EVENT_TYPE,
        message: { metadata: { approvalDecision: "approve" } },
      }),
    ).toBe(false);
  });
});
