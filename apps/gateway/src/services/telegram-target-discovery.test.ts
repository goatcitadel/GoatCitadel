import { describe, expect, it, vi } from "vitest";
import { discoverTelegramTargets, parseTelegramUpdateTargets } from "./telegram-target-discovery.js";

describe("telegram target discovery", () => {
  it("parses recent updates into unique candidate targets and prioritizes setup-code matches", () => {
    const targets = parseTelegramUpdateTargets(
      {
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              message_id: 10,
              text: "hello",
              chat: { id: 123, type: "private", first_name: "Ada", last_name: "Lovelace" },
            },
          },
          {
            update_id: 2,
            channel_post: {
              message_id: 20,
              text: "setup goat-123",
              chat: { id: "-100456", type: "channel", title: "Ops Channel" },
            },
          },
          {
            update_id: 3,
            message: {
              message_id: 11,
              text: "another",
              chat: { id: 123, type: "private", first_name: "Ada", last_name: "Lovelace" },
            },
          },
        ],
      },
      "goat-123",
    );

    expect(targets).toEqual([
      expect.objectContaining({
        id: "telegram:-100456",
        label: "Ops Channel",
        chatId: "-100456",
        kind: "channel",
        setupCodeMatched: true,
        lastMessageId: 20,
      }),
      expect.objectContaining({
        id: "telegram:123",
        label: "Ada Lovelace",
        chatId: "123",
        kind: "private",
        lastMessageId: 11,
      }),
    ]);
  });

  it("calls Telegram getUpdates and surfaces API errors plainly", async () => {
    const fetcher = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 });
    });

    await expect(discoverTelegramTargets({ token: "bad-token", fetcher })).rejects.toThrow("Unauthorized");
    expect(fetcher).toHaveBeenCalledWith("https://api.telegram.org/botbad-token/getUpdates");
  });
});
