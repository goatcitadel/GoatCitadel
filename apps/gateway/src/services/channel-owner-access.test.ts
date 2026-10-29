import { describe, expect, it } from "vitest";
import { isAllowlistedChannelOwner, resolveAllowlistedOwnerActorIds } from "./channel-owner-access.js";

const ALLOWLISTED_OWNER = { inboundAccessMode: "allowlist", allowedSenders: ["333"], ownerActorIds: ["333"] };

describe("an owner an allowlist-mode connection lets in without pairing", () => {
  it("is someone who is both an owner and on the sender allowlist", () => {
    expect(isAllowlistedChannelOwner(ALLOWLISTED_OWNER, "333")).toBe(true);
    expect(resolveAllowlistedOwnerActorIds(ALLOWLISTED_OWNER)).toEqual(["333"]);
  });

  it("matches ids the forgiving way the lists are read: trimmed and case-insensitive", () => {
    const config = { inboundAccessMode: "allowlist", allowedSenders: [" UserABC "], ownerActorIds: ["userabc "] };

    expect(isAllowlistedChannelOwner(config, " USERabc")).toBe(true);
    expect(resolveAllowlistedOwnerActorIds(config)).toEqual(["userabc"]);
  });

  it("is not someone who is only marked as an owner", () => {
    const config = { inboundAccessMode: "allowlist", allowedSenders: ["999"], ownerActorIds: ["333"] };

    expect(isAllowlistedChannelOwner(config, "333")).toBe(false);
    expect(resolveAllowlistedOwnerActorIds(config)).toEqual([]);
  });

  it("is not someone who is only on the allowlist", () => {
    const config = { inboundAccessMode: "allowlist", allowedSenders: ["333"], ownerActorIds: ["999"] };

    expect(isAllowlistedChannelOwner(config, "333")).toBe(false);
    expect(resolveAllowlistedOwnerActorIds(config)).toEqual([]);
  });

  it("stops being someone once they are taken off the allowlist", () => {
    const withoutThem = { ...ALLOWLISTED_OWNER, allowedSenders: ["555"] };

    expect(isAllowlistedChannelOwner(withoutThem, "333")).toBe(false);
    expect(resolveAllowlistedOwnerActorIds(withoutThem)).toEqual([]);
    expect(isAllowlistedChannelOwner({ ...ALLOWLISTED_OWNER, allowedSenders: [] }, "333")).toBe(false);
  });

  it("is nobody on a connection that is not in allowlist mode", () => {
    for (const mode of [undefined, "open_legacy", "carrier-pigeon"]) {
      const config = { ...ALLOWLISTED_OWNER, inboundAccessMode: mode };

      expect(isAllowlistedChannelOwner(config, "333"), String(mode)).toBe(false);
      expect(resolveAllowlistedOwnerActorIds(config), String(mode)).toEqual([]);
    }
  });

  it("is nobody when the access settings are malformed", () => {
    const config = { ...ALLOWLISTED_OWNER, allowedSenders: "333" };

    expect(isAllowlistedChannelOwner(config, "333")).toBe(false);
    expect(resolveAllowlistedOwnerActorIds(config)).toEqual([]);
  });

  it("keeps only the owners who are also allowed when the lists differ", () => {
    const config = {
      inboundAccessMode: "allowlist",
      allowedSenders: ["444", "555"],
      ownerActorIds: ["333", "444"],
    };

    expect(resolveAllowlistedOwnerActorIds(config)).toEqual(["444"]);
    expect(isAllowlistedChannelOwner(config, "333")).toBe(false);
    expect(isAllowlistedChannelOwner(config, "444")).toBe(true);
  });
});
