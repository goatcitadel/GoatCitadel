import { describe, expect, it } from "vitest";
import type { AddonCatalogEntry, AddonDashboardSlotDeclaration } from "./addons.js";

describe("AddonCatalogEntry dashboard slots", () => {
  it("supports dashboardSlots declarations targeting specific routes", () => {
    const slot: AddonDashboardSlotDeclaration = {
      slot: "ops.approvals.actions",
      route: "/ops/approvals",
    };
    const entry: AddonCatalogEntry = {
      addonId: "test",
      label: "Test",
      description: "Test addon",
      owner: "owner-1",
      repoUrl: "https://example.com/repo",
      sameOwnerAsGoatCitadel: false,
      trustTier: "trusted",
      category: "productivity",
      runtimeType: "separate_repo_app",
      installCommands: [],
      webEntryMode: "none",
      requiresSeparateRepoDownload: true,
      healthChecks: [],
      dashboardSlots: [slot],
    };
    expect(entry.dashboardSlots?.[0]?.slot).toBe("ops.approvals.actions");
    expect(entry.dashboardSlots?.[0]?.route).toBe("/ops/approvals");
  });

  it("allows omitting route for global slot rendering", () => {
    const slot: AddonDashboardSlotDeclaration = { slot: "ops.runtime.statusbar" };
    expect(slot.route).toBeUndefined();
  });

  it("allows priority for ordering within a slot", () => {
    const slot: AddonDashboardSlotDeclaration = { slot: "ops.approvals.actions", priority: 90 };
    expect(slot.priority).toBe(90);
  });
});
