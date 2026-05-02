import { describe, expect, it } from "vitest";
import { approveTelegramPairingCode, authorizeTelegramChannelActor } from "./telegram-channel-pairing.js";

describe("telegram channel pairing", () => {
  it("allows configured allow-all Telegram connections", () => {
    expect(
      authorizeTelegramChannelActor({
        config: { telegramAllowAllUsers: true },
        chatId: "123",
        actorId: "777",
      }),
    ).toEqual({ authorized: true });
  });

  it("creates and reuses a pending pairing code for unknown actors", () => {
    const now = new Date("2026-05-02T12:00:00.000Z");
    const first = authorizeTelegramChannelActor({
      config: {},
      chatId: "123",
      actorId: "777",
      actorDisplayName: "Matt",
      now,
    });
    const pending = (first.configPatch?.telegramPairing as { pending: Array<{ code: string }> }).pending;
    const second = authorizeTelegramChannelActor({
      config: first.configPatch!,
      chatId: "123",
      actorId: "777",
      actorDisplayName: "Matt",
      now,
    });

    expect(first.authorized).toBe(false);
    expect(first.response?.text).toContain("Pairing code:");
    expect(pending[0]?.code).toHaveLength(8);
    expect(second.configPatch).toEqual(first.configPatch);
  });

  it("promotes valid pending pairing codes to approved users", () => {
    const now = new Date("2026-05-02T12:00:00.000Z");
    const decision = authorizeTelegramChannelActor({
      config: {},
      chatId: "123",
      actorId: "777",
      actorDisplayName: "Matt",
      now,
    });
    const pending = (decision.configPatch?.telegramPairing as { pending: Array<{ code: string }> }).pending;
    const approved = approveTelegramPairingCode(decision.configPatch!, pending[0]?.code ?? "", now);

    expect(approved.approved).toBe(true);
    expect(approved.actorId).toBe("777");
    expect(
      authorizeTelegramChannelActor({
        config: approved.configPatch!,
        chatId: "123",
        actorId: "777",
        now,
      }).authorized,
    ).toBe(true);
  });
});
