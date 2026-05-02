import { describe, expect, it, vi } from "vitest";
import {
  buildChannelPersonalitySystemOverlay,
  handleTelegramChannelCommand,
  readActiveChannelPersonality,
} from "./telegram-channel-commands.js";

const baseConnection = {
  connectionId: "11111111-1111-4111-8111-111111111111",
  label: "Telegram",
  enabled: true,
  status: "connected" as const,
  config: {},
};

describe("telegram channel commands", () => {
  it("sets the current chat as the home channel", async () => {
    const result = await handleTelegramChannelCommand({
      connection: baseConnection,
      chatId: "-100123",
      actorId: "777",
      content: "/sethome",
    });

    expect(result.handled).toBe(true);
    expect(result.configPatch).toEqual(
      expect.objectContaining({
        defaultChannelId: "-100123",
        defaultChatId: "-100123",
      }),
    );
    expect(result.response?.text).toContain("Home channel set");
  });

  it("sets and clears visible personality overlays per chat", async () => {
    const setResult = await handleTelegramChannelCommand({
      connection: baseConnection,
      chatId: "-100123",
      actorId: "777",
      content: "/personality operator",
    });

    expect(setResult.configPatch?.channelPersonalities).toEqual({ "-100123": "operator" });
    expect(readActiveChannelPersonality(setResult.configPatch!, "-100123")).toBe("operator");
    expect(buildChannelPersonalitySystemOverlay(setResult.configPatch!, "-100123")).toContain("Operator");

    const clearResult = await handleTelegramChannelCommand({
      connection: {
        ...baseConnection,
        config: setResult.configPatch!,
      },
      chatId: "-100123",
      actorId: "777",
      content: "/personality none",
    });

    expect(clearResult.configPatch?.channelPersonalities).toEqual({});
  });

  it("leaves ordinary messages on the normal chat path", async () => {
    expect(
      await handleTelegramChannelCommand({
        connection: baseConnection,
        chatId: "-100123",
        actorId: "777",
        content: "please help me",
      }),
    ).toEqual({ handled: false });
  });

  it("resolves approval token fallback commands", async () => {
    const resolveApprovalToken = vi.fn(async () => ({ approvalId: "approval-1", status: "approved" }));
    const result = await handleTelegramChannelCommand({
      connection: baseConnection,
      chatId: "-100123",
      actorId: "777",
      content: "/approve grat_secret",
      resolveApprovalToken,
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain("Approved approval-1");
    expect(resolveApprovalToken).toHaveBeenCalledWith("grat_secret", "approve");
  });

  it("shows approval posture in channel tools", async () => {
    const result = await handleTelegramChannelCommand({
      connection: baseConnection,
      chatId: "-100123",
      actorId: "777",
      content: "/tools",
    });

    expect(result.response?.text).toContain("Terminal");
    expect(result.response?.text).toContain("always required");
  });
});
