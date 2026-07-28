import { describe, expect, it } from "vitest";

import { isExperimentalRoute, isHiddenRoute, isPrimaryRailRoute } from "./route-model";

describe("isExperimentalRoute (NAV-02 rail gating)", () => {
  it("flags every experimental surface independently of its navigation treatment", () => {
    const experimental = [
      { area: "library", section: "journey" },
      { area: "library", section: "curator" },
      { area: "ops", section: "improvement" },
      { area: "ops", section: "kanban" },
      { area: "settings", section: "personalities" },
      { area: "settings", section: "addons" },
    ] as const;
    for (const route of experimental) {
      expect(isExperimentalRoute(route)).toBe(true);
    }
  });

  it("does not flag shipped surfaces or shallow work areas", () => {
    const shipped = [
      { area: "ops", section: "activity" },
      { area: "library", section: "agents" },
      { area: "settings", section: "general" },
      { area: "chat" },
      { area: "cowork", section: "tasks" },
    ] as const;
    for (const route of shipped) {
      expect(isExperimentalRoute(route)).toBe(false);
    }
  });

  it("keeps the promoted Citadel surfaces out of experimental gating so they render in the primary rail", () => {
    const citadelSections = [
      "citadel-overview",
      "citadel",
      "citadel-wards",
      "citadel-council",
      "citadel-vault",
      "citadel-blueprint",
    ] as const;
    for (const section of citadelSections) {
      expect(isExperimentalRoute({ area: "library", section })).toBe(false);
    }
  });
});

describe("isHiddenRoute (release-only navigation gating)", () => {
  it("flags direct-URL-only capability settings without treating them as experimental", () => {
    const hidden = [
      { area: "settings", section: "workspace-capabilities" },
      { area: "settings", section: "citadel-capabilities" },
    ] as const;

    for (const route of hidden) {
      expect(isHiddenRoute(route)).toBe(true);
      expect(isExperimentalRoute(route)).toBe(false);
    }
  });

  it("does not hide release-bearing or experimental routes", () => {
    expect(isHiddenRoute({ area: "settings", section: "providers" })).toBe(false);
    expect(isHiddenRoute({ area: "settings", section: "addons" })).toBe(false);
    expect(isHiddenRoute({ area: "chat" })).toBe(false);
  });

  it("fails closed when a route is missing release metadata", () => {
    expect(isHiddenRoute({ area: "settings", section: "not-a-real-section" as never })).toBe(true);
  });
});

describe("isPrimaryRailRoute", () => {
  it("keeps the experimental personality catalog discoverable without promoting its release status", () => {
    const personalities = { area: "settings", section: "personalities" } as const;

    expect(isExperimentalRoute(personalities)).toBe(true);
    expect(isPrimaryRailRoute(personalities)).toBe(true);
    expect(isPrimaryRailRoute({ area: "settings", section: "addons" })).toBe(false);
  });

  it("includes shipped routes and excludes direct-URL-only routes", () => {
    expect(isPrimaryRailRoute({ area: "settings", section: "providers" })).toBe(true);
    expect(isPrimaryRailRoute({ area: "settings", section: "workspace-capabilities" })).toBe(false);
  });
});
