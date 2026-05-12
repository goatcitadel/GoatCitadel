import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_ROUTE,
  PAGE_META,
  SPACE_META,
  SPACE_PAGES,
  VISIBLE_SPACE_PAGES,
  buildRouteForVisiblePage,
  buildRouteSearch,
  getPageLabel,
  getVisiblePage,
  getVisiblePageLabel,
  isWorkSurface,
  normalizeResolvedRoute,
  readRouteFromLocation,
} from "./page-registry";

const originalWindow = globalThis.window;

function setLocation(href: string) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: { href },
    },
  });
}

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: originalWindow,
    });
    return;
  }
  Reflect.deleteProperty(globalThis, "window");
});

describe("page-registry route model", () => {
  it("keeps route metadata and visible navigation groups aligned", () => {
    expect(SPACE_META.operate.label).toBe("Work");
    expect(PAGE_META.surface.space).toBe("operate");
    expect(SPACE_PAGES.observe.map((item) => item.page)).toContain("quality");
    expect(VISIBLE_SPACE_PAGES.configure.map((item) => item.page)).toEqual([
      "general",
      "runtime",
      "workspaces",
      "integrations",
      "tools",
      "agents",
    ]);
  });

  it("normalizes surface and nested host tabs", () => {
    expect(normalizeResolvedRoute({ space: "operate", page: "surface" })).toEqual({
      space: "operate",
      page: "surface",
      surface: "chat",
    });
    expect(normalizeResolvedRoute({ space: "observe", page: "activity", tab: "scheduler" })).toMatchObject({
      tab: "scheduler",
    });
    expect(normalizeResolvedRoute({ space: "observe", page: "activity", tab: "missing" as never })).toMatchObject({
      tab: "activity",
    });
    expect(normalizeResolvedRoute({ space: "observe", page: "artifacts", tab: "generated" })).toMatchObject({
      tab: "generated",
    });
    expect(normalizeResolvedRoute({ space: "configure", page: "settings", tab: "providers" })).toMatchObject({
      tab: "providers",
    });
    expect(normalizeResolvedRoute({ space: "configure", page: "integrations", tab: "mcp" })).toMatchObject({
      tab: "mcp",
    });
    expect(normalizeResolvedRoute({ space: "configure", page: "agents", tab: "herd-lab" as never })).toMatchObject({
      tab: "board",
    });
    expect(normalizeResolvedRoute({ space: "operate", page: "tasks" })).toEqual({ space: "operate", page: "tasks" });

    for (const tab of ["activity", "scheduler", "improvement"] as const) {
      expect(normalizeResolvedRoute({ space: "observe", page: "activity", tab })).toMatchObject({ tab });
    }
    for (const tab of ["memory", "files", "generated"] as const) {
      expect(normalizeResolvedRoute({ space: "observe", page: "artifacts", tab })).toMatchObject({ tab });
    }
    for (const tab of [
      "general",
      "providers",
      "access",
      "budget",
      "runtime",
      "workspaces",
      "addons",
      "onboarding",
    ] as const) {
      expect(normalizeResolvedRoute({ space: "configure", page: "settings", tab })).toMatchObject({ tab });
    }
    for (const tab of ["overview", "channels", "mcp"] as const) {
      expect(normalizeResolvedRoute({ space: "configure", page: "integrations", tab })).toMatchObject({ tab });
    }
    for (const tab of ["overview", "board", "skills", "catalog"] as const) {
      expect(normalizeResolvedRoute({ space: "configure", page: "agents", tab })).toMatchObject({ tab });
    }
  });

  it("preserves live-lane query params when building route search", () => {
    expect(
      buildRouteSearch({
        space: "operate",
        page: "surface",
        surface: "code",
        sessionId: "sess-code",
        turnId: "turn-code",
        approvalId: "approval-code",
        artifactId: "artifact-code",
      }),
    ).toBe(
      "?space=operate&page=surface&surface=code&sessionId=sess-code&turnId=turn-code&artifactId=artifact-code&approvalId=approval-code",
    );
    expect(
      buildRouteSearch({
        space: "observe",
        page: "activity",
        tab: "scheduler",
      }),
    ).toBe("?space=observe&page=activity&tab=scheduler");
  });

  it("reads modern, legacy, invalid, and server-side route locations", () => {
    Reflect.deleteProperty(globalThis, "window");
    expect(readRouteFromLocation()).toEqual(DEFAULT_ROUTE);

    setLocation(
      "http://localhost:5173/?space=operate&page=surface&surface=code&sessionId=sess-code&turnId=turn-code&approvalId=approval-code",
    );
    expect(readRouteFromLocation()).toMatchObject({
      space: "operate",
      page: "surface",
      surface: "code",
      sessionId: "sess-code",
      turnId: "turn-code",
      approvalId: "approval-code",
    });

    setLocation("http://localhost:5173/?space=observe&page=artifacts&tab=files&artifactId=artifact-1");
    expect(readRouteFromLocation()).toMatchObject({ space: "observe", page: "artifacts", tab: "files" });

    for (const page of ["activity", "sessions", "costs", "system", "quality"] as const) {
      setLocation(`http://localhost:5173/?space=observe&page=${page}&tab=ignored&sessionId=sess-${page}`);
      expect(readRouteFromLocation()).toMatchObject({ space: "observe", page });
    }

    setLocation("http://localhost:5173/?space=configure&page=agents&tab=herd-live&sessionId=sess-1");
    expect(readRouteFromLocation()).toMatchObject({
      space: "configure",
      page: "agents",
      tab: "board",
      sessionId: "sess-1",
    });

    for (const [page, tab] of [
      ["settings", "runtime"],
      ["integrations", "channels"],
      ["tools", "ignored"],
    ] as const) {
      setLocation(`http://localhost:5173/?space=configure&page=${page}&tab=${tab}&artifactId=artifact-config`);
      expect(readRouteFromLocation()).toMatchObject({ space: "configure", page, artifactId: "artifact-config" });
    }

    setLocation("http://localhost:5173/?tab=promptLab&artifactId=artifact-2");
    expect(readRouteFromLocation()).toMatchObject({ space: "observe", page: "quality", artifactId: "artifact-2" });

    setLocation("http://localhost:5173/?tab=chat&surface=cowork");
    expect(readRouteFromLocation()).toMatchObject({ space: "operate", page: "surface", surface: "cowork" });

    setLocation("http://localhost:5173/?tab=chat&surface=unknown");
    expect(readRouteFromLocation()).toMatchObject({ space: "operate", page: "surface", surface: "chat" });

    for (const [tab, expected] of [
      ["cron", { space: "observe", page: "activity", tab: "scheduler" }],
      ["memory", { space: "observe", page: "artifacts", tab: "memory" }],
      ["settings", { space: "configure", page: "settings", tab: "general" }],
      ["officeLab", { space: "configure", page: "agents", tab: "board" }],
    ] as const) {
      setLocation(`http://localhost:5173/?tab=${tab}&sessionId=sess-legacy&turnId=turn-legacy`);
      expect(readRouteFromLocation()).toMatchObject(expected);
    }

    setLocation("http://localhost:5173/?space=bad&page=bad");
    expect(readRouteFromLocation()).toEqual(DEFAULT_ROUTE);
  });

  it("labels visible pages and route destinations", () => {
    expect(isWorkSurface("chat")).toBe(true);
    expect(isWorkSurface("cowork")).toBe(true);
    expect(isWorkSurface("code")).toBe(true);
    expect(isWorkSurface("scheduler")).toBe(false);
    expect(isWorkSurface(null)).toBe(false);
    expect(getPageLabel({ space: "operate", page: "surface", surface: "cowork" })).toBe("Cowork");
    expect(getPageLabel({ space: "operate", page: "surface", surface: "chat" })).toBe("Chat");
    expect(getPageLabel({ space: "operate", page: "surface", surface: "code" })).toBe("Code");
    expect(getPageLabel({ space: "configure", page: "tools" })).toBe("Tools");
    expect(getVisiblePage({ space: "operate", page: "surface" })).toBe("chat");
    expect(getVisiblePage({ space: "operate", page: "tasks" })).toBe("tasks");
    expect(getVisiblePage({ space: "operate", page: "approvals" })).toBe("approvals");
    expect(getVisiblePage({ space: "observe", page: "activity" })).toBe("timeline");
    expect(getVisiblePage({ space: "observe", page: "sessions" })).toBe("timeline");
    expect(getVisiblePage({ space: "observe", page: "costs" })).toBe("health");
    expect(getVisiblePage({ space: "observe", page: "system" })).toBe("health");
    expect(getVisiblePage({ space: "observe", page: "artifacts" })).toBe("artifacts");
    expect(getVisiblePage({ space: "observe", page: "quality" })).toBe("quality");
    expect(getVisiblePage({ space: "configure", page: "integrations" })).toBe("integrations");
    expect(getVisiblePage({ space: "configure", page: "tools" })).toBe("tools");
    expect(getVisiblePage({ space: "configure", page: "agents" })).toBe("agents");
    expect(getVisiblePage({ space: "configure", page: "settings", tab: "runtime" })).toBe("runtime");
    expect(getVisiblePage({ space: "configure", page: "settings", tab: "addons" })).toBe("workspaces");
    expect(getVisiblePage({ space: "configure", page: "settings", tab: "workspaces" })).toBe("workspaces");
    expect(getVisiblePage({ space: "configure", page: "settings", tab: "access" })).toBe("general");
    expect(getVisiblePage({ space: "configure", page: "unknown" as never })).toBe("general");
    expect(getVisiblePageLabel({ space: "configure", page: "settings", tab: "onboarding" })).toBe("General");
  });

  it("builds routes for every visible page family", () => {
    const current = {
      space: "operate",
      page: "surface",
      surface: "chat",
      sessionId: "sess-1",
      turnId: "turn-1",
      artifactId: "artifact-1",
      approvalId: "approval-1",
    } as const;
    expect(buildRouteForVisiblePage(current, "code")).toMatchObject({
      space: "operate",
      page: "surface",
      surface: "code",
      sessionId: "sess-1",
      turnId: "turn-1",
      artifactId: "artifact-1",
      approvalId: "approval-1",
    });
    expect(buildRouteForVisiblePage(current, "tasks")).toEqual({ space: "operate", page: "tasks" });
    expect(buildRouteForVisiblePage(current, "approvals")).toEqual({ space: "operate", page: "approvals" });
    expect(buildRouteForVisiblePage(current, "timeline")).toEqual({
      space: "observe",
      page: "activity",
      tab: "activity",
    });
    expect(buildRouteForVisiblePage({ space: "observe", page: "sessions" }, "timeline")).toEqual({
      space: "observe",
      page: "sessions",
    });
    expect(buildRouteForVisiblePage(current, "health")).toEqual({ space: "observe", page: "costs" });
    expect(buildRouteForVisiblePage({ space: "observe", page: "system" }, "health")).toEqual({
      space: "observe",
      page: "system",
    });
    expect(buildRouteForVisiblePage(current, "artifacts")).toEqual({
      space: "observe",
      page: "artifacts",
      tab: "memory",
      artifactId: "artifact-1",
    });
    expect(buildRouteForVisiblePage(current, "quality")).toEqual({ space: "observe", page: "quality" });
    expect(buildRouteForVisiblePage(current, "integrations")).toEqual({
      space: "configure",
      page: "integrations",
      tab: "overview",
    });
    expect(buildRouteForVisiblePage(current, "agents")).toEqual({
      space: "configure",
      page: "agents",
      tab: "overview",
    });
    expect(buildRouteForVisiblePage(current, "tools")).toEqual({ space: "configure", page: "tools" });
    expect(buildRouteForVisiblePage(current, "runtime")).toEqual({
      space: "configure",
      page: "settings",
      tab: "runtime",
    });
    expect(buildRouteForVisiblePage({ space: "configure", page: "settings", tab: "addons" }, "workspaces")).toEqual({
      space: "configure",
      page: "settings",
      tab: "addons",
    });
    expect(buildRouteForVisiblePage({ space: "configure", page: "tools" }, "workspaces")).toEqual({
      space: "configure",
      page: "settings",
      tab: "workspaces",
    });
    expect(buildRouteForVisiblePage({ space: "configure", page: "settings", tab: "budget" }, "general")).toEqual({
      space: "configure",
      page: "settings",
      tab: "budget",
    });
    expect(buildRouteForVisiblePage({ space: "configure", page: "settings", tab: "onboarding" }, "general")).toEqual({
      space: "configure",
      page: "settings",
      tab: "onboarding",
    });
    expect(buildRouteForVisiblePage({ space: "configure", page: "tools" }, "general")).toEqual({
      space: "configure",
      page: "settings",
      tab: "general",
    });
  });
});
