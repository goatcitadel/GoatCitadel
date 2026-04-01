import { describe, expect, it, vi } from "vitest";
import { sendTelegramTypingIndicator } from "./telegram-typing.js";

describe("sendTelegramTypingIndicator", () => {
  it("sends a Telegram typing action and returns an expiry window", async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    const result = await sendTelegramTypingIndicator({
      connectionId: "telegram-1",
      target: "-1001234567890",
      token: "telegram-token",
      chatId: "-1001234567890",
      threadId: "42",
      durationMs: 8_000,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-token/sendChatAction",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const request = fetcher.mock.calls[0]?.[1];
    if (!request) {
      throw new Error("Expected Telegram typing fetcher to be called.");
    }
    expect(typeof request.body).toBe("string");
    expect(JSON.parse(String(request.body))).toEqual({
      chat_id: "-1001234567890",
      action: "typing",
      message_thread_id: 42,
    });
    expect(result).toMatchObject({
      channelKey: "telegram",
      connectionId: "telegram-1",
      target: "-1001234567890",
      supported: true,
      status: "sent",
    });
    expect(result.expiresAt).toBeDefined();
    expect(Date.parse(result.expiresAt ?? "")).toBeGreaterThan(Date.now());
  });

  it("surfaces provider failures", async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({
        ok: false,
        description: "Forbidden: bot was kicked from the supergroup chat",
      }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }));

    await expect(sendTelegramTypingIndicator({
      connectionId: "telegram-1",
      target: "-1001234567890",
      token: "telegram-token",
      chatId: "-1001234567890",
      fetcher,
    })).rejects.toThrow(
      "telegram.typing failed (403): Forbidden: bot was kicked from the supergroup chat",
    );
  });
});
