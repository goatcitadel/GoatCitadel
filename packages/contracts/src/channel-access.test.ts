import { describe, expect, it } from "vitest";
import { ChannelInboundAccessConfigSchema, isSenderAllowed, resolveAllowedSenders } from "./channel-access.js";

describe("ChannelInboundAccessConfigSchema", () => {
  it("treats allowedSenders as optional (opt-in, default unset)", () => {
    const result = ChannelInboundAccessConfigSchema.parse({ signingSecret: "shh" });
    expect(result.allowedSenders).toBeUndefined();
  });

  it("accepts a populated allowlist and preserves unrelated config via passthrough", () => {
    const result = ChannelInboundAccessConfigSchema.parse({
      allowedSenders: ["U123", "u456"],
      slackBotUserId: "BOT",
    });
    expect(result.allowedSenders).toEqual(["U123", "u456"]);
    expect((result as Record<string, unknown>).slackBotUserId).toBe("BOT");
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
