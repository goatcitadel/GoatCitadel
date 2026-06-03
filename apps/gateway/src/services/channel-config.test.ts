import { describe, expect, it } from "vitest";
import { resolveChannelConfigTarget } from "./channel-config.js";

describe("resolveChannelConfigTarget", () => {
  it("uses channel-specific target precedence", () => {
    expect(
      resolveChannelConfigTarget("signal", {
        defaultTarget: "fallback",
        defaultRecipient: "+15551234567",
      }),
    ).toBe("+15551234567");

    expect(
      resolveChannelConfigTarget("imessage", {
        defaultTarget: "fallback",
        defaultHandle: "+15557654321",
      }),
    ).toBe("+15557654321");

    expect(
      resolveChannelConfigTarget("nextcloud-talk", {
        defaultConversationId: "conversation-9",
        defaultTarget: "fallback",
      }),
    ).toBe("conversation-9");

    expect(
      resolveChannelConfigTarget("line", {
        defaultUserId: "U1234567890",
        defaultTarget: "fallback",
      }),
    ).toBe("fallback");

    expect(
      resolveChannelConfigTarget("zalo", {
        defaultRecipientId: "recipient-123",
        defaultTarget: "fallback",
      }),
    ).toBe("recipient-123");

    expect(
      resolveChannelConfigTarget("ntfy", {
        topic: "goatcitadel-ops",
        defaultTarget: "fallback",
      }),
    ).toBe("goatcitadel-ops");
  });

  it("falls back to generic target fields for unknown channels", () => {
    expect(
      resolveChannelConfigTarget("custom-channel", {
        defaultTarget: "default-room",
      }),
    ).toBe("default-room");
    expect(
      resolveChannelConfigTarget("custom-channel", {
        target: "target-room",
      }),
    ).toBe("target-room");
  });

  it("returns undefined when no configured target exists", () => {
    expect(resolveChannelConfigTarget("signal", {})).toBeUndefined();
    expect(
      resolveChannelConfigTarget("discord", {
        defaultChannelId: "   ",
      }),
    ).toBeUndefined();
  });
});
