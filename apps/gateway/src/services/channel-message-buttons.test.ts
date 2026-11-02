import { describe, expect, it, vi } from "vitest";
import { clearTelegramMessageButtons } from "./channel-message-buttons.js";

const TOKEN = "123456:secret-bot-token";

function telegramReply(status: number, body: Record<string, unknown>) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

describe("clearTelegramMessageButtons", () => {
  it("removes the inline keyboard from the sent message", async () => {
    const fetcher = telegramReply(200, { ok: true, result: { message_id: 77 } });

    await clearTelegramMessageButtons(TOKEN, "4242", "77", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/editMessageReplyMarkup`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: "4242",
      message_id: 77,
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("counts a message that has no buttons left as done", async () => {
    const fetcher = telegramReply(400, {
      ok: false,
      description:
        "Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
    });

    await expect(clearTelegramMessageButtons(TOKEN, "4242", "77", fetcher)).resolves.toBeUndefined();
  });

  it("fails with Telegram's bounded reason, never the bot token", async () => {
    const fetcher = telegramReply(400, { ok: false, description: `Bad Request: message to edit not found ${TOKEN}` });

    const failure = clearTelegramMessageButtons(TOKEN, "4242", "77", fetcher);

    await expect(failure).rejects.toThrow(
      /telegram\.edit_buttons failed \(400\): Bad Request: message to edit not found/,
    );
    await expect(failure).rejects.not.toThrow(TOKEN);
  });

  it("refuses a message id Telegram could not have sent, without calling it", async () => {
    const fetcher = telegramReply(200, { ok: true });

    await expect(clearTelegramMessageButtons(TOKEN, "4242", "telegram-1730000000000", fetcher)).rejects.toThrow(
      "Telegram message id is not a number.",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
