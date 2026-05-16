import { describe, expect, it } from "vitest";
import { AddonSlotService } from "./addon-slot-service.js";

describe("AddonSlotService", () => {
  it("returns slots whose route matches", () => {
    const service = new AddonSlotService();
    service.registerDeclarations("test-addon", [
      { slot: "ops.approvals.actions", route: "/ops/approvals" },
      { slot: "library.skills.cards", route: "/library/skills" },
    ]);
    const matched = service.findSlotsForRoute("/ops/approvals");
    expect(matched).toHaveLength(1);
    expect(matched[0]?.slot).toBe("ops.approvals.actions");
    expect(matched[0]?.addonId).toBe("test-addon");
  });

  it("returns slots without a route on every match (global slots)", () => {
    const service = new AddonSlotService();
    service.registerDeclarations("test-addon", [{ slot: "ops.runtime.statusbar" }]);
    const matched = service.findSlotsForRoute("/anywhere");
    expect(matched).toHaveLength(1);
  });

  it("filters by slot when slotFilter provided", () => {
    const service = new AddonSlotService();
    service.registerDeclarations("a", [{ slot: "ops.approvals.actions" }]);
    service.registerDeclarations("b", [{ slot: "library.skills.cards" }]);
    const matched = service.findSlotsForRoute("/ops/approvals", "ops.approvals.actions");
    expect(matched).toHaveLength(1);
    expect(matched[0]?.slot).toBe("ops.approvals.actions");
  });

  it("orders slots by priority (higher first)", () => {
    const service = new AddonSlotService();
    service.registerDeclarations("low", [{ slot: "ops.approvals.actions", priority: 10 }]);
    service.registerDeclarations("high", [{ slot: "ops.approvals.actions", priority: 90 }]);
    const matched = service.findSlotsForRoute("/ops/approvals");
    expect(matched.map((m) => m.addonId)).toEqual(["high", "low"]);
  });

  it("missing priority sorts last (priority defaults to 0)", () => {
    const service = new AddonSlotService();
    service.registerDeclarations("noprio", [{ slot: "ops.approvals.actions" }]);
    service.registerDeclarations("withprio", [{ slot: "ops.approvals.actions", priority: 5 }]);
    const matched = service.findSlotsForRoute("/ops/approvals");
    expect(matched.map((m) => m.addonId)).toEqual(["withprio", "noprio"]);
  });

  it("registerDeclarations replaces previous registration for the same addon", () => {
    const service = new AddonSlotService();
    service.registerDeclarations("a", [{ slot: "ops.approvals.actions" }]);
    service.registerDeclarations("a", [{ slot: "library.skills.cards" }]);
    expect(service.findSlotsForRoute("/ops/approvals", "ops.approvals.actions")).toHaveLength(0);
    expect(service.findSlotsForRoute("/library/skills", "library.skills.cards")).toHaveLength(1);
  });

  it("unregister removes all declarations for an addon", () => {
    const service = new AddonSlotService();
    service.registerDeclarations("a", [{ slot: "ops.approvals.actions" }]);
    service.unregister("a");
    expect(service.findSlotsForRoute("/ops/approvals")).toEqual([]);
  });

  it("listAllRegistrations returns flattened registrations across addons", () => {
    const service = new AddonSlotService();
    service.registerDeclarations("a", [{ slot: "ops.approvals.actions" }]);
    service.registerDeclarations("b", [{ slot: "library.skills.cards" }, { slot: "ops.runtime.statusbar" }]);
    const all = service.listAllRegistrations();
    expect(all).toHaveLength(3);
    expect(all.filter((r) => r.addonId === "b")).toHaveLength(2);
  });
});
