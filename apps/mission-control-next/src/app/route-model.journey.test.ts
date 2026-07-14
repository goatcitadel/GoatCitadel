import { describe, expect, it } from "vitest";
import { RAIL_ITEMS, buildAppHref, getRouteLabel, getRouteReleaseScope, parseAppRoute } from "./route-model";

describe("Library Journey route HX-402", () => {
  it("is a first-class read-only Library route", () => {
    const route = parseAppRoute("/library/journey");
    expect(route).toMatchObject({ area: "library", section: "journey" });
    expect(buildAppHref(route)).toBe("/library/journey");
    expect(getRouteLabel(route)).toBe("Journey");
    expect(RAIL_ITEMS.library.find((item) => item.id === "library-journey")?.section).toBe("journey");
    expect(getRouteReleaseScope(route)).toMatchObject({
      status: "experimental",
      note: expect.stringContaining("Skill Hub lifecycle events"),
    });
  });
});
