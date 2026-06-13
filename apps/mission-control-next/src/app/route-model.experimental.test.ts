import { describe, expect, it } from "vitest";

import { isExperimentalRoute } from "./route-model";

describe("isExperimentalRoute (NAV-02 rail gating)", () => {
  it("flags every experimental surface that is gated out of the primary rails", () => {
    const experimental = [
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
});
