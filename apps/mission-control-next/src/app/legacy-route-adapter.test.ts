import { describe, expect, it } from "vitest";
import {
  RAIL_ITEMS,
  ROUTE_RELEASE_SCOPE,
  buildAppHref,
  buildNavigationTarget,
  describeReleaseScopeForOperator,
  describeReleaseSurfaceStatus,
  getRouteDescription,
  getRouteLabel,
  getRouteReleaseKey,
  getRouteReleaseScope,
  isRailItemActive,
  normalizeAppRoute,
  parseAppRoute,
  type ReleaseSurfaceStatus,
} from "./route-model";
import { adaptLegacyUrl, coerceLegacyHrefToNext, resolveRouteFromLocation } from "./legacy-route-adapter";

describe("legacy route adapter", () => {
  it("maps legacy work surface tabs into the new areas", () => {
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?tab=dashboard&surface=chat")).toBe("/chat");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?tab=dashboard&surface=cowork")).toBe("/cowork");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?tab=dashboard&surface=code")).toBe("/code");
  });

  it("maps bare legacy surface parameters into the new areas", () => {
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?surface=chat")).toBe("/chat");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?surface=cowork")).toBe("/cowork");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?surface=code")).toBe("/code");
  });

  it("maps legacy herd tabs into the cowork board", () => {
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?tab=herd-live")).toBe("/cowork/board");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?tab=herd-lab")).toBe("/cowork/board");
  });

  it("maps legacy observe routes into library and ops destinations", () => {
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=observe&page=artifacts&tab=files")).toBe(
      "/library/files",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=observe&page=quality")).toBe("/ops/quality");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=observe&page=activity&tab=scheduler")).toBe(
      "/ops/schedules",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=observe&page=activity&tab=improvement")).toBe(
      "/ops/improvement",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=observe&page=activity")).toBe("/ops/activity");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=observe&page=sessions")).toBe("/ops/sessions");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=observe&page=artifacts&tab=generated")).toBe(
      "/library/artifacts",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=observe&page=artifacts")).toBe("/library/memory");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=observe&page=costs")).toBe("/ops/costs");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=observe&page=system")).toBe("/ops/runtime");
  });

  it("maps legacy operate routes into task and approval destinations", () => {
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=operate&page=surface&surface=cowork")).toBe(
      "/cowork",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=operate&page=surface&surface=code")).toBe("/code");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=operate&page=tasks")).toBe("/cowork/tasks");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=operate&page=approvals")).toBe("/ops/approvals");
  });

  it("maps promptlab tabs into library prompt packs", () => {
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?tab=promptlab")).toBe("/library/prompt-packs");
  });

  it("maps legacy configure routes into settings and library homes", () => {
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=settings&tab=providers")).toBe(
      "/settings/providers",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=settings&tab=personalities")).toBe(
      "/settings/personalities",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=settings&tab=permissions")).toBe(
      "/settings/permissions",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=settings&tab=workspaces")).toBe(
      "/settings/workspaces",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=settings&tab=access")).toBe(
      "/settings/access",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=settings&tab=budget")).toBe(
      "/settings/budget",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=settings&tab=runtime")).toBe(
      "/settings/runtime",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=settings&tab=unknown")).toBe(
      "/settings/general",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=integrations&tab=channels")).toBe(
      "/settings/channels",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=integrations&tab=mcp")).toBe(
      "/settings/mcp",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=integrations")).toBe(
      "/settings/integrations",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=agents&tab=skills")).toBe(
      "/library/skills",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=agents&tab=catalog")).toBe(
      "/library/agents?view=catalog",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=agents&tab=board")).toBe(
      "/cowork/board",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=agents")).toBe("/library/agents");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=tools")).toBe("/settings/tools");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=unknown")).toBe("/chat");
  });

  it("preserves route ids while converting legacy search urls", () => {
    expect(
      coerceLegacyHrefToNext(
        "http://goatcitadel.local/?space=operate&page=surface&surface=chat&sessionId=s-1&turnId=t-2&artifactId=a-3&approvalId=ap-4&theme=light",
      ),
    ).toBe("/chat?sessionId=s-1&turnId=t-2&artifactId=a-3&approvalId=ap-4&theme=light");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/")).toBeNull();
    expect(adaptLegacyUrl(new URL("http://goatcitadel.local/?surface=unknown"))).toMatchObject({ area: "chat" });
  });
});

describe("mission-control-next route model", () => {
  it("parses path-based routes", () => {
    expect(parseAppRoute("http://goatcitadel.local/library/prompt-packs?view=benchmark")).toEqual({
      area: "library",
      section: "prompt-packs",
      view: "benchmark",
      sessionId: undefined,
      turnId: undefined,
      artifactId: undefined,
      approvalId: undefined,
      projectId: undefined,
      theme: undefined,
    });
  });

  it("builds stable hrefs", () => {
    expect(
      buildAppHref({
        area: "chat",
        sessionId: "session-9",
        turnId: "turn-4",
      }),
    ).toBe("/chat?sessionId=session-9&turnId=turn-4");
  });

  it("parses and builds project detail routes", () => {
    expect(parseAppRoute("http://goatcitadel.local/projects/Project-ABC")).toEqual({
      area: "projects",
      section: undefined,
      sessionId: undefined,
      turnId: undefined,
      artifactId: undefined,
      approvalId: undefined,
      projectId: "Project-ABC",
      theme: undefined,
      view: undefined,
    });
    expect(buildAppHref({ area: "projects", projectId: "Project-ABC" })).toBe("/projects/Project-ABC");
  });

  it("keeps malformed project path segments from crashing route parsing", () => {
    expect(parseAppRoute("http://goatcitadel.local/projects/Project-%").projectId).toBe("Project-%");
  });

  it("prefers legacy query parsing when old shell links are opened", () => {
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=memory")).toEqual({
      area: "library",
      section: "memory",
      sessionId: undefined,
      turnId: undefined,
      artifactId: undefined,
      approvalId: undefined,
      projectId: undefined,
      theme: undefined,
      view: undefined,
    });
  });

  it("covers route labels, descriptions, navigation preservation, and legacy tab aliases", () => {
    expect(getRouteLabel({ area: "cowork", section: "tasks" })).toBe("Task Board");
    expect(getRouteLabel({ area: "cowork", section: "board" })).toBe("Agent Board");
    expect(getRouteLabel({ area: "cowork" })).toBe("Cowork");
    expect(getRouteDescription({ area: "cowork", section: "board" })).toContain("board exposes");
    expect(getRouteDescription({ area: "cowork" })).toContain("Delegation");
    expect(getRouteDescription({ area: "settings", section: "budget" })).toContain("Set budget mode");

    expect(
      buildNavigationTarget(
        {
          area: "library",
          section: "agents",
          view: "catalog",
          sessionId: "session-1",
          turnId: "turn-1",
          artifactId: "artifact-1",
          projectId: "project-1",
          theme: "light",
        },
        RAIL_ITEMS.library.find((item) => item.id === "library-agents")!,
      ),
    ).toMatchObject({ area: "library", section: "agents", view: "catalog", theme: "light" });
    expect(
      buildNavigationTarget(
        { area: "chat", sessionId: "session-1", turnId: "turn-1", artifactId: "artifact-1", theme: "dark" },
        RAIL_ITEMS.chat.find((item) => item.id === "chat-artifacts")!,
      ),
    ).toMatchObject({ area: "library", section: "artifacts", sessionId: "session-1", turnId: "turn-1" });
    expect(isRailItemActive({ area: "chat" }, RAIL_ITEMS.chat[0]!)).toBe(true);
    expect(isRailItemActive({ area: "chat" }, RAIL_ITEMS.library[0]!)).toBe(false);

    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=assembly")).toMatchObject({ area: "cowork" });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=tasks")).toMatchObject({
      area: "cowork",
      section: "tasks",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=approvals")).toMatchObject({
      area: "ops",
      section: "approvals",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=activity")).toMatchObject({
      area: "ops",
      section: "activity",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=cron")).toMatchObject({
      area: "ops",
      section: "schedules",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=improvement")).toMatchObject({
      area: "ops",
      section: "improvement",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=sessions")).toMatchObject({
      area: "ops",
      section: "sessions",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=files")).toMatchObject({
      area: "library",
      section: "files",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=generated")).toMatchObject({
      area: "library",
      section: "artifacts",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=costs")).toMatchObject({
      area: "ops",
      section: "costs",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=system")).toMatchObject({
      area: "ops",
      section: "runtime",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=settings")).toMatchObject({
      area: "settings",
      section: "general",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=workspaces")).toMatchObject({
      area: "settings",
      section: "workspaces",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=addons")).toMatchObject({
      area: "settings",
      section: "addons",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=onboarding")).toMatchObject({
      area: "settings",
      section: "onboarding",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=mesh")).toMatchObject({
      area: "settings",
      section: "runtime",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=npu")).toMatchObject({
      area: "settings",
      section: "runtime",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=integrations")).toMatchObject({
      area: "settings",
      section: "integrations",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=channels")).toMatchObject({
      area: "settings",
      section: "channels",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=mcp")).toMatchObject({
      area: "settings",
      section: "mcp",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=tools")).toMatchObject({
      area: "settings",
      section: "tools",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=agents")).toMatchObject({
      area: "library",
      section: "agents",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=catalog")).toMatchObject({
      area: "library",
      section: "agents",
      view: "catalog",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=office")).toMatchObject({
      area: "cowork",
      section: "board",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=officelab")).toMatchObject({
      area: "cowork",
      section: "board",
    });
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=unknown")).toMatchObject({ area: "chat" });
    expect(resolveRouteFromLocation(new URL("http://goatcitadel.local/settings"))).toMatchObject({ area: "settings" });
    expect(parseAppRoute("http://goatcitadel.local/projects").projectId).toBeUndefined();
  });

  it("covers native route defaults and fallback branches without changing contracts", () => {
    expect(normalizeAppRoute({ area: "library" })).toMatchObject({ area: "library", section: "agents" });
    expect(normalizeAppRoute({ area: "ops" })).toMatchObject({ area: "ops", section: "activity" });
    expect(normalizeAppRoute({ area: "settings" })).toMatchObject({ area: "settings", section: "general" });
    expect(parseAppRoute("http://goatcitadel.local/not-a-real-area?projectId=project-1")).toMatchObject({
      area: "chat",
      projectId: "project-1",
    });
    expect(parseAppRoute("http://goatcitadel.local/projects?projectId=Project From Query").projectId).toBe(
      "Project From Query",
    );
    expect(buildAppHref({ area: "projects" })).toBe("/projects");
    expect(buildAppHref({ area: "library", projectId: "project-1", view: "catalog", theme: "light" })).toBe(
      "/library/agents?projectId=project-1&view=catalog&theme=light",
    );
    expect(buildAppHref({ area: "library", section: undefined as any })).toBe("/library/agents");
    expect(getRouteLabel({ area: "library", section: "missing" as any })).toBe("Library");
  });

  it("classifies every current route in the release scope table", () => {
    const routeKeys = new Set(ROUTE_RELEASE_SCOPE.map((scope) => getRouteReleaseKey(scope)));
    expect(routeKeys.size).toBe(ROUTE_RELEASE_SCOPE.length);
    expect(routeKeys).toEqual(
      new Set([
        "chat/root",
        "cowork/workspace",
        "cowork/tasks",
        "cowork/board",
        "code/root",
        "projects/root",
        ...RAIL_ITEMS.library.map((item) => `library/${item.section}`),
        ...RAIL_ITEMS.ops.map((item) => `ops/${item.section}`),
        ...RAIL_ITEMS.settings.map((item) => `settings/${item.section}`),
      ]),
    );
    expect(getRouteReleaseScope({ area: "library", section: "curator" }).status).toBe("experimental");
    expect(getRouteReleaseScope({ area: "code" }).status).toBe("ship");
    expect(ROUTE_RELEASE_SCOPE.map((scope) => scope.status)).not.toContain(
      "needs_release_polish" satisfies ReleaseSurfaceStatus,
    );
    expect(ROUTE_RELEASE_SCOPE.filter((scope) => scope.status === "ship")).toHaveLength(36);
    expect(ROUTE_RELEASE_SCOPE.filter((scope) => scope.status === "experimental")).toHaveLength(5);
    expect(describeReleaseScopeForOperator(getRouteReleaseScope({ area: "settings", section: "providers" }))).toBe(
      "Release-ready. Action: Configure provider credentials and run provider/model smoke evidence. Verification: verify:surface:regression, provider exercise paths. Constraint: Provider setup is release-bearing with smoke evidence, model discovery state, and plain failure copy.",
    );
    expect(describeReleaseSurfaceStatus("ship")).toBe("Release-ready");
    expect(describeReleaseSurfaceStatus("hide")).toBe("Hidden");
  });
});
