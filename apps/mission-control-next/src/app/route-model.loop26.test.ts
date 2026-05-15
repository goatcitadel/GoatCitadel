import { describe, expect, it } from "vitest";

import { buildAppHref, parseAppRoute } from "./route-model";

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
