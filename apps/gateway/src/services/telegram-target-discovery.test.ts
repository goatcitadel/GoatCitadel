import { describe, expect, it, vi } from "vitest";
import {
  discoverTelegramTargets,
  findTelegramStartCodeSender,
  parseTelegramUpdateTargets,
} from "./telegram-target-discovery.js";

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

describe("telegram setup code sender", () => {
  const code = "Ab3dEf7hJk";
  const from = { id: 42, first_name: "Sam", last_name: "Lee", username: "sam" };
  const privateUpdate = (
    updateId: number,
    text: string,
    sender: Record<string, unknown> = from,
    chatType = "private",
  ) => ({
    update_id: updateId,
    message: { message_id: updateId, text, from: sender, chat: { id: sender.id, type: chatType } },
  });

  it("finds the sender of /start <code> in a private chat", () => {
    expect(findTelegramStartCodeSender({ ok: true, result: [privateUpdate(1, `/start ${code}`)] }, code)).toEqual({
      actorId: "42",
      chatId: "42",
      displayName: "Sam Lee",
      username: "sam",
    });
  });

  it("accepts /start@bot <code> and the bare code", () => {
    expect(findTelegramStartCodeSender({ result: [privateUpdate(1, `/start@goat_bot ${code}`)] }, code)?.actorId).toBe(
      "42",
    );
    expect(findTelegramStartCodeSender({ result: [privateUpdate(1, `  ${code}  `)] }, code)?.actorId).toBe("42");
  });

  it("ignores groups, other codes, codes inside other text and bots", () => {
    const ignored = [
      privateUpdate(1, `/start ${code}`, from, "group"),
      privateUpdate(2, "/start other"),
      privateUpdate(3, `hello ${code}`),
      privateUpdate(4, `x${code}`),
      privateUpdate(5, `/start ${code}`, { ...from, is_bot: true }),
      privateUpdate(6, `/start ${code} extra`),
    ];
    for (const update of ignored)
      expect(findTelegramStartCodeSender({ ok: true, result: [update] }, code)).toBeUndefined();
    expect(findTelegramStartCodeSender({ ok: true, result: [] }, code)).toBeUndefined();
    expect(findTelegramStartCodeSender({ ok: true }, code)).toBeUndefined();
    expect(findTelegramStartCodeSender(undefined, code)).toBeUndefined();
    expect(findTelegramStartCodeSender({ result: [privateUpdate(1, `/start ${code}`)] }, "")).toBeUndefined();
  });

  it("uses the latest matching message", () => {
    const first = { id: 7, first_name: "Early" };
    const latest = { id: 9, first_name: "Late" };
    expect(
      findTelegramStartCodeSender(
        { result: [privateUpdate(1, `/start ${code}`, first), privateUpdate(2, `/start ${code}`, latest)] },
        code,
      )?.actorId,
    ).toBe("9");
    expect(
      findTelegramStartCodeSender(
        { result: [privateUpdate(2, `/start ${code}`, latest), privateUpdate(1, `/start ${code}`, first)] },
        code,
      )?.actorId,
    ).toBe("9");
    const unnumbered = [first, latest].map((sender) => ({
      message: { text: `/start ${code}`, from: sender, chat: { id: sender.id, type: "private" } },
    }));
    expect(findTelegramStartCodeSender({ result: unnumbered }, code)?.actorId).toBe("9");
  });
});
