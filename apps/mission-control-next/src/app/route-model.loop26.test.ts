import { describe, expect, it } from "vitest";

import {
  buildAppHref,
  buildNavigationTarget,
  getRouteLabel,
  getRouteReleaseScope,
  parseAppRoute,
  RAIL_ITEMS,
} from "./route-model";

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

  it("keeps universal run detail ids in the route query", () => {
    const href = buildAppHref({
      area: "ops",
      section: "sessions",
      view: "run-detail",
      runId: "run-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });
    expect(href).toBe("/ops/sessions?sessionId=session-1&turnId=turn-1&runId=run-1&view=run-detail");
    expect(parseAppRoute(href)).toMatchObject({
      area: "ops",
      section: "sessions",
      view: "run-detail",
      runId: "run-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });
  });

  it("keeps /settings/safety as an alias for the permissions section", () => {
    expect(parseAppRoute("/settings/safety")).toMatchObject({
      area: "settings",
      section: "permissions",
    });
  });

  it("keeps focused Code approval context when using the Code rail approvals shortcut", () => {
    const approvalsEntry = RAIL_ITEMS.code.find((item) => item.id === "code-approvals");
    expect(approvalsEntry).toBeDefined();

    expect(
      buildNavigationTarget(
        {
          area: "code",
          sessionId: "session-1",
          turnId: "turn-1",
          approvalId: "approval-focused-1",
        },
        approvalsEntry!,
      ),
    ).toMatchObject({
      area: "ops",
      section: "approvals",
      sessionId: "session-1",
      turnId: "turn-1",
      approvalId: "approval-focused-1",
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

describe("library/curator route", () => {
  it("parses /library/curator and exposes it in the Library rail", () => {
    const route = parseAppRoute("/library/curator");
    expect(route.area).toBe("library");
    expect(route.section).toBe("curator");
    const entry = RAIL_ITEMS.library.find((item) => item.id === "library-curator");
    expect(entry?.section).toBe("curator");
    expect(getRouteLabel({ area: "library", section: "curator" })).toBe("Skill Curator");
  });
});

describe("settings/trust-policy route", () => {
  it("parses, labels, and marks the Trust & Policy dashboard as release-bearing", () => {
    const route = parseAppRoute("/settings/trust-policy");
    expect(route.area).toBe("settings");
    expect(route.section).toBe("trust-policy");
    expect(buildAppHref(route)).toBe("/settings/trust-policy");
    expect(getRouteLabel(route)).toBe("Trust & Policy");
    expect(RAIL_ITEMS.settings.find((item) => item.id === "settings-trust-policy")?.section).toBe("trust-policy");
    expect(getRouteReleaseScope(route).status).toBe("ship");
  });
});
