import { describe, it, expect } from "vitest";
import { resolveCitadelScope, isWithinCitadelScope } from "./citadels.js";

describe("resolveCitadelScope", () => {
  it("resolves citadelId from workspaceId when citadelId is absent", () => {
    expect(resolveCitadelScope({ workspaceId: "ws-1" })).toEqual({ citadelId: "ws-1" });
  });

  it("prefers an explicit citadelId over workspaceId", () => {
    expect(resolveCitadelScope({ citadelId: "c-1", workspaceId: "ws-1" })).toEqual({ citadelId: "c-1" });
  });

  it("includes chamberId when present", () => {
    expect(resolveCitadelScope({ workspaceId: "ws-1", chamberId: "ch-1" })).toEqual({
      citadelId: "ws-1",
      chamberId: "ch-1",
    });
  });

  it("returns undefined when no identity is present", () => {
    expect(resolveCitadelScope({})).toBeUndefined();
    expect(resolveCitadelScope(undefined)).toBeUndefined();
    expect(resolveCitadelScope({ workspaceId: "   " })).toBeUndefined();
  });
});

describe("isWithinCitadelScope", () => {
  it("lets an unscoped viewer (global operator inbox) see everything", () => {
    expect(isWithinCitadelScope({ citadelId: "a" }, undefined)).toBe(true);
    expect(isWithinCitadelScope(undefined, undefined)).toBe(true);
  });

  it("hides items that belong to a different citadel", () => {
    expect(isWithinCitadelScope({ citadelId: "a" }, { citadelId: "b" })).toBe(false);
  });

  it("hides unscoped items from a citadel-scoped viewer", () => {
    expect(isWithinCitadelScope(undefined, { citadelId: "a" })).toBe(false);
  });

  it("shows same-citadel items to a citadel-scoped viewer", () => {
    expect(isWithinCitadelScope({ citadelId: "a", chamberId: "ch-1" }, { citadelId: "a" })).toBe(true);
  });

  it("restricts a chamber-scoped viewer to that chamber plus citadel-general items", () => {
    expect(isWithinCitadelScope({ citadelId: "a", chamberId: "ch-1" }, { citadelId: "a", chamberId: "ch-1" })).toBe(
      true,
    );
    expect(isWithinCitadelScope({ citadelId: "a", chamberId: "ch-2" }, { citadelId: "a", chamberId: "ch-1" })).toBe(
      false,
    );
    // A citadel-general item (no chamber) stays visible to a chamber-scoped viewer.
    expect(isWithinCitadelScope({ citadelId: "a" }, { citadelId: "a", chamberId: "ch-1" })).toBe(true);
  });
});
