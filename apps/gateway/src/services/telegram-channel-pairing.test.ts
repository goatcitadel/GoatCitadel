import { describe, expect, it } from "vitest";
import {
  approveTelegramPairingCode,
  authorizeTelegramChannelActor,
  revokeTelegramPairingActor,
} from "./telegram-channel-pairing.js";

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
    expect(second.configPatch).toBeUndefined();
    expect(second.response?.text).toContain(pending[0]?.code);
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
  it("coordinates pairing with the explicit sender gate and revokes both authorities", () => {
    const now = new Date("2026-05-02T12:00:00.000Z");
    const decision = authorizeTelegramChannelActor({
      config: { inboundAccessMode: "allowlist", allowedSenders: ["888"] },
      chatId: "123",
      actorId: "777",
      now,
    });
    const pending = (decision.configPatch!.telegramPairing as { pending: Array<{ code: string }> }).pending;
    const approved = approveTelegramPairingCode(
      { inboundAccessMode: "allowlist", allowedSenders: ["888"], ...decision.configPatch },
      pending[0]!.code,
      now,
    );
    expect(approved.configPatch!.allowedSenders).toEqual(["888", "777"]);
    const revoked = revokeTelegramPairingActor({ inboundAccessMode: "allowlist", ...approved.configPatch }, "777");
    expect(revoked.allowedSenders).toEqual(["888"]);
    expect(authorizeTelegramChannelActor({ config: revoked, chatId: "123", actorId: "777", now }).authorized).toBe(
      false,
    );
  });

  describe("the owner the setup page proved", () => {
    // What the setup page writes once the operator says hi with the one-time code.
    const OWNER_CONFIG = { inboundAccessMode: "allowlist", allowedSenders: ["777"], ownerActorIds: ["777"] };

    it("authorizes an owner who is on the allowlist, without a pairing code", () => {
      expect(authorizeTelegramChannelActor({ config: OWNER_CONFIG, chatId: "777", actorId: "777" })).toEqual({
        authorized: true,
      });
      // Like an approved pairing, the owner is recognized in any chat, and ids match case-insensitively.
      expect(authorizeTelegramChannelActor({ config: OWNER_CONFIG, chatId: "-100", actorId: "777" }).authorized).toBe(
        true,
      );
      expect(
        authorizeTelegramChannelActor({
          config: { inboundAccessMode: "allowlist", allowedSenders: [" UserABC "], ownerActorIds: ["userabc"] },
          chatId: "1",
          actorId: "UserAbc",
        }).authorized,
      ).toBe(true);
    });

    it("does not authorize an owner who was taken off the allowlist", () => {
      for (const allowedSenders of [["888"], []]) {
        const decision = authorizeTelegramChannelActor({
          config: { ...OWNER_CONFIG, allowedSenders },
          chatId: "777",
          actorId: "777",
        });
        expect(decision.authorized).toBe(false);
        expect(decision.response?.text).toContain("Pairing code:");
      }
    });

    it("leaves an allowlisted sender who is not an owner to pairing, as before", () => {
      const decision = authorizeTelegramChannelActor({
        config: { ...OWNER_CONFIG, allowedSenders: ["777", "888"] },
        chatId: "888",
        actorId: "888",
      });
      expect(decision.authorized).toBe(false);
      expect(decision.response?.text).toContain("Pairing code:");
    });

    it("changes nothing for open_legacy or unset modes", () => {
      for (const inboundAccessMode of ["open_legacy", undefined]) {
        const decision = authorizeTelegramChannelActor({
          config: { ...OWNER_CONFIG, inboundAccessMode },
          chatId: "777",
          actorId: "777",
        });
        expect(decision.authorized).toBe(false);
        expect(decision.response?.text).toContain("Pairing code:");
      }
    });
  });
});
