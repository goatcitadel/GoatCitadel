import { describe, expect, it } from "vitest";

import { buildAppHref, parseAppRoute, RAIL_ITEMS, getRouteLabel } from "./route-model";

describe("mission-control-next route model loop 26 tails", () => {
  it("keeps generic area paths deterministic when a section is omitted", () => {
    expect(buildAppHref({ area: "ops", theme: "light" })).toBe("/ops/activity?theme=light");
    expect(buildAppHref({ area: "settings" })).toBe("/settings/general");
    expect(buildAppHref({ area: "ops", section: "" as never })).toBe("/ops/");
  });

  it("falls back from a missing project path segment to the query project id", () => {
    expect(parseAppRoute("http://goatcitadel.local/projects?projectId=query-project")).toMatchObject({
      area: "projects",
      projectId: "query-project",
    });
  });
});

describe("ops/kanban route", () => {
  it("parses /ops/kanban into area=ops, section=kanban", () => {
    const route = parseAppRoute("/ops/kanban");
    expect(route.area).toBe("ops");
    expect(route.section).toBe("kanban");
  });

  it("rail entry exists with stable id ops-kanban", () => {
    const entry = RAIL_ITEMS.ops.find((item) => item.id === "ops-kanban");
    expect(entry).toBeDefined();
    expect(entry?.section).toBe("kanban");
  });

  it("getRouteLabel returns 'Kanban' for the section", () => {
    expect(getRouteLabel({ area: "ops", section: "kanban" })).toBe("Kanban");
  });
});
