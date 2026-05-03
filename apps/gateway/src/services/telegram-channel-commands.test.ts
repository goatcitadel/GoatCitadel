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
  it("rotates the Telegram channel session for /new", async () => {
    const result = await handleTelegramChannelCommand({
      connection: baseConnection,
      chatId: "-100123",
      threadId: "42",
      actorId: "777",
      content: "/new",
    });

    const sessions = result.configPatch?.telegramChannelSessions as Record<string, unknown> | undefined;
    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain("fresh GoatCitadel session");
    expect(sessions).toBeDefined();
    expect(Object.keys(sessions ?? {})).toHaveLength(1);
  });

  it("stops the active Telegram channel session when a cancel callback is available", async () => {
    const cancelActiveSession = vi.fn(async () => ({
      status: "cancelled" as const,
      sessionId: "sess-telegram",
      turnId: "turn-1",
      durableRunId: "run-1",
      durableCancelled: true,
    }));
    const result = await handleTelegramChannelCommand({
      connection: baseConnection,
      chatId: "-100123",
      actorId: "777",
      content: "/stop",
      cancelActiveSession,
    });

    expect(cancelActiveSession).toHaveBeenCalledTimes(1);
    expect(result.response?.text).toContain("Stopped the active Telegram channel run");
    expect(result.response?.text).toContain("Linked durable run run-1");
  });

  it("reports no active Telegram run truthfully", async () => {
    const result = await handleTelegramChannelCommand({
      connection: baseConnection,
      chatId: "-100123",
      actorId: "777",
      content: "/stop",
      cancelActiveSession: vi.fn(async () => ({ status: "no_active_run" as const, sessionId: "sess-telegram" })),
    });

    expect(result.response?.text).toContain("No active Telegram channel run");
  });

  it("surfaces Telegram stop failures without claiming success", async () => {
    const result = await handleTelegramChannelCommand({
      connection: baseConnection,
      chatId: "-100123",
      actorId: "777",
      content: "/stop",
      cancelActiveSession: vi.fn(async () => ({
        status: "failed" as const,
        sessionId: "sess-telegram",
        error: "trace unavailable",
      })),
    });

    expect(result.response?.text).toContain("Could not stop");
    expect(result.response?.text).toContain("trace unavailable");
  });

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
