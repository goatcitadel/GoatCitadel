import { describe, expect, it } from "vitest";
import { evaluateChannelInboundAccess } from "@goatcitadel/contracts";
import { normalizeGuidedChannelInboundAccess, hydrateGuidedChannelInboundAccess } from "./channel-setup-inbound-access.js";
import { approveTelegramPairingCode, authorizeTelegramChannelActor, revokeTelegramPairingActor } from "./telegram-channel-pairing.js";
describe("guided sender authorization", () => {
  it.each(["slack", "telegram", "whatsapp", "line", "nextcloud-talk"])("defaults %s to deny unknown senders and preserves deliberate fields", (key) => {
    const config = normalizeGuidedChannelInboundAccess(key, { draft: {} });
    expect(evaluateChannelInboundAccess({ config, actorId: "777" }).allowed).toBe(false);
    expect(normalizeGuidedChannelInboundAccess(key, { draft: { allowedSenders: [" 777 ", "777"] } })).toEqual({ inboundAccessMode: "allowlist", allowedSenders: ["777"] });
    expect(hydrateGuidedChannelInboundAccess(key, {})).toEqual({ inboundAccessMode: "open_legacy" });
  });
  it("commits pairing and sender trust together then revokes both without disturbing other users", () => {
    const now = new Date();
    const pending = authorizeTelegramChannelActor({ config: { inboundAccessMode: "allowlist", allowedSenders: ["888"] }, actorId: "777", chatId: "100", now });
    const code = (pending.configPatch!.telegramPairing as { pending: { code: string }[] }).pending[0]!.code;
    const base = { inboundAccessMode: "allowlist", allowedSenders: ["888"], ...pending.configPatch };
    const approved = { ...base, ...approveTelegramPairingCode(base, code, now).configPatch };
    expect(evaluateChannelInboundAccess({ config: approved, actorId: "777" }).allowed).toBe(true);
    expect(authorizeTelegramChannelActor({ config: approved, actorId: "777", chatId: "100", now }).authorized).toBe(true);
    const revoked = { ...approved, ...revokeTelegramPairingActor(approved, "777") };
    expect(evaluateChannelInboundAccess({ config: revoked, actorId: "777" }).allowed).toBe(false);
    expect(revoked.allowedSenders).toEqual(["888"]);
    expect(authorizeTelegramChannelActor({ config: revoked, actorId: "777", chatId: "100", now }).authorized).toBe(false);
  });
  it("rejects malformed access fields rather than silently opening", () => { expect(() => normalizeGuidedChannelInboundAccess("slack", { draft: { allowedSenders: "everyone" } })).toThrow(); });
});
