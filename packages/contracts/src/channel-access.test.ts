import { describe, expect, it } from "vitest";
import {
  ChannelInboundAccessConfigSchema,
  evaluateChannelInboundAccess,
  isSenderAllowed,
  resolveAllowedSenders,
} from "./channel-access.js";

describe("ChannelInboundAccessConfigSchema", () => {
  it("treats allowedSenders as optional (opt-in, default unset)", () => {
    const result = ChannelInboundAccessConfigSchema.parse({ signingSecret: "shh" });
    expect(result.allowedSenders).toBeUndefined();
  });

  it("accepts a populated allowlist and preserves unrelated config via passthrough", () => {
    const result = ChannelInboundAccessConfigSchema.parse({
      inboundAccessMode: "allowlist",
      allowedSenders: ["U123", "u456"],
      slackBotUserId: "BOT",
    });
    expect(result.inboundAccessMode).toBe("allowlist");
    expect(result.allowedSenders).toEqual(["U123", "u456"]);
    expect((result as Record<string, unknown>).slackBotUserId).toBe("BOT");
  });

  it("accepts explicit legacy-open mode for migration compatibility", () => {
    const result = ChannelInboundAccessConfigSchema.parse({ inboundAccessMode: "open_legacy" });
    expect(result.inboundAccessMode).toBe("open_legacy");
  });

  it("rejects unknown inbound access modes", () => {
    expect(() => ChannelInboundAccessConfigSchema.parse({ inboundAccessMode: "open" })).toThrow();
  });

  it("rejects a non-string entry in allowedSenders", () => {
    expect(() => ChannelInboundAccessConfigSchema.parse({ allowedSenders: ["ok", 42] })).toThrow();
  });
});

describe("resolveAllowedSenders", () => {
  it("returns an empty list for unset or non-array config", () => {
    expect(resolveAllowedSenders(undefined)).toEqual([]);
    expect(resolveAllowedSenders({})).toEqual([]);
    expect(resolveAllowedSenders({ allowedSenders: "U1" })).toEqual([]);
  });

  it("trims, lowercases, drops blanks, and de-duplicates", () => {
    expect(resolveAllowedSenders({ allowedSenders: ["  U1 ", "u1", "U2", "", "   ", 5 as unknown as string] })).toEqual(
      ["u1", "u2"],
    );
  });
});

describe("isSenderAllowed", () => {
  it("default-allows when the allowlist is empty/unset", () => {
    expect(isSenderAllowed([], "anyone")).toBe(true);
    expect(isSenderAllowed([], undefined)).toBe(true);
  });

  it("permits a listed sender (case-insensitive, trimmed)", () => {
    const allow = resolveAllowedSenders({ allowedSenders: ["U-Owner"] });
    expect(isSenderAllowed(allow, "u-owner")).toBe(true);
    expect(isSenderAllowed(allow, "  U-OWNER  ")).toBe(true);
  });

  it("rejects an unlisted sender when the allowlist is active", () => {
    const allow = resolveAllowedSenders({ allowedSenders: ["U-Owner"] });
    expect(isSenderAllowed(allow, "U-Intruder")).toBe(false);
  });

  it("rejects a blank/undefined sender when the allowlist is active", () => {
    const allow = resolveAllowedSenders({ allowedSenders: ["U-Owner"] });
    expect(isSenderAllowed(allow, "")).toBe(false);
    expect(isSenderAllowed(allow, undefined)).toBe(false);
  });
});

describe("evaluateChannelInboundAccess", () => {
  it("preserves legacy-open behavior for old configs but returns migration evidence", () => {
    expect(evaluateChannelInboundAccess({ config: {}, actorId: "anyone" })).toEqual({
      allowed: true,
      mode: "open_legacy",
      reason: "legacy_open_unset",
      allowedSenders: [],
      legacyWarning:
        "Connection has no inboundAccessMode and no allowedSenders, so it is using legacy default-open inbound access.",
    });
  });

  it("denies empty allowlists when the connection explicitly opts into allowlist mode", () => {
    expect(evaluateChannelInboundAccess({ config: { inboundAccessMode: "allowlist" }, actorId: "U-Owner" })).toEqual({
      allowed: false,
      mode: "allowlist",
      reason: "allowlist_empty",
      allowedSenders: [],
    });
  });

  it("uses allowlist mode when old configs already contain allowed senders", () => {
    expect(evaluateChannelInboundAccess({ config: { allowedSenders: ["U-Owner"] }, actorId: "u-owner" })).toEqual({
      allowed: true,
      mode: "allowlist",
      reason: "allowlist_match",
      allowedSenders: ["u-owner"],
    });
  });

  it("fails closed for malformed inbound access config while preserving raw allowlist evidence", () => {
    expect(
      evaluateChannelInboundAccess({
        config: { inboundAccessMode: "allow_list", allowedSenders: ["U-Owner"] },
        actorId: "U-Intruder",
      }),
    ).toEqual({
      allowed: false,
      mode: "allowlist",
      reason: "invalid_config",
      allowedSenders: ["u-owner"],
    });
    expect(
      evaluateChannelInboundAccess({
        config: { inboundAccessMode: "allowlist", allowedSenders: ["U-Owner", 42] },
        actorId: "U-Owner",
      }),
    ).toEqual({
      allowed: false,
      mode: "allowlist",
      reason: "invalid_config",
      allowedSenders: ["u-owner"],
    });
  });

  it("rejects missing or unlisted actors under allowlist mode", () => {
    expect(
      evaluateChannelInboundAccess({
        config: { inboundAccessMode: "allowlist", allowedSenders: ["U-Owner"] },
        actorId: undefined,
      }),
    ).toEqual({
      allowed: false,
      mode: "allowlist",
      reason: "missing_actor",
      allowedSenders: ["u-owner"],
    });
    expect(
      evaluateChannelInboundAccess({
        config: { inboundAccessMode: "allowlist", allowedSenders: ["U-Owner"] },
        actorId: "U-Intruder",
      }),
    ).toEqual({
      allowed: false,
      mode: "allowlist",
      reason: "sender_not_allowlisted",
      allowedSenders: ["u-owner"],
    });
  });

  it("allows explicit open_legacy mode and marks it as migration debt", () => {
    expect(evaluateChannelInboundAccess({ config: { inboundAccessMode: "open_legacy" } })).toEqual({
      allowed: true,
      mode: "open_legacy",
      reason: "legacy_open_explicit",
      allowedSenders: [],
      legacyWarning: "Connection explicitly permits all inbound senders through open_legacy mode.",
    });
  });
});

describe("evaluateChannelInboundAccess default-safe posture for new connections", () => {
  // A NEW inbound-capable connection is stamped with inboundAccessMode:
  // "allowlist" at creation time (see applyChannelInboundAccessDefaults). With
  // an empty allowlist that means deny-until-allowed for unknown senders. These
  // tests pin that posture at the contract boundary, independent of the
  // service, for the channel shapes Discord/Telegram now produce.
  const newConnectionConfig = { inboundAccessMode: "allowlist", allowedSenders: [] as string[] };

  it("denies an unknown sender on a fresh Discord/Telegram-shaped connection", () => {
    expect(evaluateChannelInboundAccess({ config: newConnectionConfig, actorId: "dc-stranger" })).toEqual({
      allowed: false,
      mode: "allowlist",
      reason: "allowlist_empty",
      allowedSenders: [],
    });
  });

  it("allows the sender once an operator adds it to the allowlist", () => {
    expect(
      evaluateChannelInboundAccess({
        config: { inboundAccessMode: "allowlist", allowedSenders: ["U-Owner"] },
        actorId: "u-owner",
      }),
    ).toEqual({
      allowed: true,
      mode: "allowlist",
      reason: "allowlist_match",
      allowedSenders: ["u-owner"],
    });
  });

  it("allows everyone when the operator deliberately picks an open ('allow all') posture", () => {
    expect(
      evaluateChannelInboundAccess({
        config: { inboundAccessMode: "open_legacy" },
        actorId: "dc-stranger",
      }),
    ).toEqual({
      allowed: true,
      mode: "open_legacy",
      reason: "legacy_open_explicit",
      allowedSenders: [],
      legacyWarning: "Connection explicitly permits all inbound senders through open_legacy mode.",
    });
  });

  it("still treats a legacy connection (no mode, no senders) as open-with-warning for compatibility", () => {
    expect(evaluateChannelInboundAccess({ config: {}, actorId: "anyone" })).toEqual({
      allowed: true,
      mode: "open_legacy",
      reason: "legacy_open_unset",
      allowedSenders: [],
      legacyWarning:
        "Connection has no inboundAccessMode and no allowedSenders, so it is using legacy default-open inbound access.",
    });
  });
});
