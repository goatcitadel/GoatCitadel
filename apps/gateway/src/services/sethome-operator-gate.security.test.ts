import { describe, expect, it } from "vitest";
import { isTelegramChannelOperator, handleTelegramChannelCommand } from "./telegram-channel-commands.js";
import { isDiscordChannelOperator } from "./discord-runtime-bridge-service.js";

// Regression coverage for CODEX_FINDING #4 (Discord) and #5 (Telegram):
// `/sethome` previously mutated operator config (defaultChannelId /
// defaultDiscordChannelId) for any paired user — including, on Telegram,
// any user when allowAllTelegramUsers was set. The fix requires the actor
// to be in an explicit per-connection operator allowlist before the
// configPatch is applied.

describe("isTelegramChannelOperator (codex #5)", () => {
  it("returns false on an empty operator list", () => {
    expect(isTelegramChannelOperator({}, "telegram:123")).toBe(false);
    expect(isTelegramChannelOperator({ telegramOperatorActors: [] }, "telegram:123")).toBe(false);
  });

  it("returns true when actor is in telegramOperatorActors", () => {
    expect(isTelegramChannelOperator({ telegramOperatorActors: ["telegram:123"] }, "telegram:123")).toBe(true);
  });

  it("accepts legacy operatorActorIds field too", () => {
    expect(isTelegramChannelOperator({ operatorActorIds: ["telegram:123"] }, "telegram:123")).toBe(true);
  });

  it("returns false on whitespace mismatch", () => {
    expect(isTelegramChannelOperator({ telegramOperatorActors: ["telegram:123"] }, "telegram:456")).toBe(false);
  });

  it("returns false for empty actorId", () => {
    expect(isTelegramChannelOperator({ telegramOperatorActors: ["telegram:123"] }, "")).toBe(false);
  });
});

describe("isDiscordChannelOperator (codex #4)", () => {
  it("returns false on an empty operator list", () => {
    expect(isDiscordChannelOperator({}, "discord:user-1")).toBe(false);
  });

  it("returns true when actor is in discordOperatorActors", () => {
    expect(isDiscordChannelOperator({ discordOperatorActors: ["discord:user-1"] }, "discord:user-1")).toBe(true);
  });

  it("accepts legacy operatorActorIds field too", () => {
    expect(isDiscordChannelOperator({ operatorActorIds: ["discord:user-1"] }, "discord:user-1")).toBe(true);
  });
});

describe("Telegram /sethome behaviour (codex #5)", () => {
  it("returns NO configPatch when actor is not an operator, regardless of pairing", async () => {
    const result = await handleTelegramChannelCommand({
      connection: {
        connectionId: "conn-1",
        label: "Telegram",
        config: { telegramAllowAllUsers: true },
        enabled: true,
        status: "ok" as never,
      },
      chatId: "chat-1",
      actorId: "telegram:non-operator",
      content: "/sethome",
    });
    expect(result.handled).toBe(true);
    expect(result.configPatch).toBeUndefined();
    expect(result.response?.text ?? "").toMatch(/Only operators/);
  });

  it("returns a configPatch when actor is in telegramOperatorActors", async () => {
    const result = await handleTelegramChannelCommand({
      connection: {
        connectionId: "conn-1",
        label: "Telegram",
        config: { telegramOperatorActors: ["telegram:operator"] },
        enabled: true,
        status: "ok" as never,
      },
      chatId: "chat-1",
      actorId: "telegram:operator",
      content: "/sethome",
    });
    expect(result.handled).toBe(true);
    expect(result.configPatch).toMatchObject({
      defaultChannelId: "chat-1",
      defaultChatId: "chat-1",
    });
  });
});
