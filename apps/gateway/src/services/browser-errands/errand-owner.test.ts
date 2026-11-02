import { describe, expect, it } from "vitest";
import { isErrandOwner, type ErrandOwnerInput } from "./errand-owner.js";

const OWNER = "1001";
const FRIEND = "2002";

const allowlistConfig = {
  inboundAccessMode: "allowlist",
  allowedSenders: [OWNER, FRIEND],
  ownerActorIds: [OWNER],
};

const telegramPairingConfig = (approved: string[]) => ({
  inboundAccessMode: "pairing",
  ownerActorIds: [OWNER],
  telegramPairing: {
    approved: approved.map((actorId) => ({ actorId, approvedAt: "2026-11-01T00:00:00.000Z" })),
    pending: [],
  },
});

const discordPairingConfig = { inboundAccessMode: "pairing", ownerActorIds: [OWNER] };

const cases: Array<{ name: string; input: ErrandOwnerInput; expected: boolean }> = [
  {
    name: "an allowlisted owner",
    input: { channelKey: "slack", config: allowlistConfig, actorId: OWNER },
    expected: true,
  },
  {
    name: "an allowlisted owner, matched case-insensitively",
    input: {
      channelKey: "slack",
      config: { ...allowlistConfig, ownerActorIds: ["U01ABC"], allowedSenders: ["u01abc"] },
      actorId: " U01abc ",
    },
    expected: true,
  },
  {
    name: "an allowlisted sender who is not the owner",
    input: { channelKey: "slack", config: allowlistConfig, actorId: FRIEND },
    expected: false,
  },
  {
    name: "a Telegram owner whose pairing is approved",
    input: { channelKey: "telegram", config: telegramPairingConfig([OWNER, FRIEND]), actorId: OWNER },
    expected: true,
  },
  {
    name: "a Telegram owner whose pairing was revoked",
    input: { channelKey: "telegram", config: telegramPairingConfig([FRIEND]), actorId: OWNER },
    expected: false,
  },
  {
    name: "a paired Telegram sender who is not the owner",
    input: { channelKey: "telegram", config: telegramPairingConfig([OWNER, FRIEND]), actorId: FRIEND },
    expected: false,
  },
  {
    name: "a Discord owner with an approved pairing",
    input: { channelKey: "discord", config: discordPairingConfig, actorId: OWNER, discordApprovedActorIds: [OWNER] },
    expected: true,
  },
  {
    name: "a Discord owner whose pairing was revoked (no approved record)",
    input: { channelKey: "discord", config: discordPairingConfig, actorId: OWNER, discordApprovedActorIds: [] },
    expected: false,
  },
  {
    name: "a paired Discord sender who is not the owner",
    input: {
      channelKey: "discord",
      config: discordPairingConfig,
      actorId: FRIEND,
      discordApprovedActorIds: [OWNER, FRIEND],
    },
    expected: false,
  },
  {
    name: "Telegram pairing records do not count on Discord",
    input: { channelKey: "discord", config: { ...telegramPairingConfig([OWNER]) }, actorId: OWNER },
    expected: false,
  },
  {
    name: "an owner on an open_legacy connection without pairing",
    input: {
      channelKey: "telegram",
      config: { inboundAccessMode: "open_legacy", ownerActorIds: [OWNER] },
      actorId: OWNER,
    },
    expected: false,
  },
  {
    name: "an owner on another channel kind with no allowlist",
    input: { channelKey: "slack", config: { inboundAccessMode: "pairing", ownerActorIds: [OWNER] }, actorId: OWNER },
    expected: false,
  },
  {
    name: "an approved Telegram pairing without the owner mark",
    input: { channelKey: "telegram", config: { ...telegramPairingConfig([OWNER]), ownerActorIds: [] }, actorId: OWNER },
    expected: false,
  },
  {
    name: "a blank sender",
    input: { channelKey: "telegram", config: telegramPairingConfig([OWNER]), actorId: "  " },
    expected: false,
  },
];

describe("isErrandOwner", () => {
  it.each(cases)("$name → $expected", ({ input, expected }) => {
    expect(isErrandOwner(input)).toBe(expected);
  });

  it("ignores malformed Telegram pairing entries", () => {
    const config = {
      ownerActorIds: [OWNER],
      telegramPairing: { approved: [null, 7, { actorId: 42 }, { actorId: OWNER, approvedAt: "x" }] },
    };
    expect(isErrandOwner({ channelKey: "telegram", config, actorId: OWNER })).toBe(true);
    expect(isErrandOwner({ channelKey: "telegram", config: { ...config, telegramPairing: "x" }, actorId: OWNER })).toBe(
      false,
    );
  });
});
