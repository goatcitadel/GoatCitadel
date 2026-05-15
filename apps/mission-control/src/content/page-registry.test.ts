import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_ROUTE,
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

describe("page-registry route links", () => {
  it("preserves live-lane query params when building route search", () => {
    expect(
      buildRouteSearch({
        space: "operate",
        page: "surface",
        surface: "code",
        sessionId: "sess-code",
        turnId: "turn-code",
        approvalId: "approval-code",
      }),
    ).toBe("?space=operate&page=surface&surface=code&sessionId=sess-code&turnId=turn-code&approvalId=approval-code");
  });

  it("reads live-lane query params back from the current location", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        location: {
          href: "http://localhost:5173/?space=operate&page=surface&surface=code&sessionId=sess-code&turnId=turn-code&approvalId=approval-code",
        },
      },
    });

    expect(readRouteFromLocation()).toMatchObject({
      space: "operate",
      page: "surface",
      surface: "code",
      sessionId: "sess-code",
      turnId: "turn-code",
      approvalId: "approval-code",
    });
  });

  it("normalizes legacy herd routes into the agent board tab", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        location: {
          href: "http://localhost:5173/?space=configure&page=agents&tab=herd-live",
        },
      },
    });

    expect(readRouteFromLocation()).toMatchObject({
      space: "configure",
      page: "agents",
      tab: "board",
    });
  });

  it("supports the agents catalog tab in route parsing", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        location: {
          href: "http://localhost:5173/?space=configure&page=agents&tab=catalog&sessionId=sess-1",
        },
      },
    });

    expect(readRouteFromLocation()).toMatchObject({
      space: "configure",
      page: "agents",
      tab: "catalog",
      sessionId: "sess-1",
    });
  });

  it("normalizes legacy observe and tune routes into visible page labels", () => {
    expect(getVisiblePage({ space: "observe", page: "sessions" })).toBe("timeline");
    expect(getVisiblePageLabel({ space: "observe", page: "system" })).toBe("Health");
    expect(getVisiblePage({ space: "configure", page: "settings", tab: "addons" })).toBe("workspaces");
    expect(getVisiblePageLabel({ space: "configure", page: "settings", tab: "onboarding" })).toBe("General");
  });

  it("builds legacy-compatible routes for visible destinations", () => {
    expect(buildRouteForVisiblePage({ space: "observe", page: "sessions" }, "timeline")).toEqual({
      space: "observe",
      page: "sessions",
    });
    expect(
      buildRouteForVisiblePage(
        {
          space: "operate",
          page: "surface",
          surface: "chat",
          sessionId: "sess-1",
          turnId: "turn-1",
          approvalId: "approval-1",
        },
        "code",
      ),
    ).toEqual({
      space: "operate",
      page: "surface",
      surface: "code",
      sessionId: "sess-1",
      turnId: "turn-1",
      approvalId: "approval-1",
    });
    expect(buildRouteForVisiblePage({ space: "configure", page: "tools" }, "runtime")).toEqual({
      space: "configure",
      page: "settings",
      tab: "runtime",
    });
  });

  it("normalizes nested tabs and page labels for every shell host", () => {
    expect(isWorkSurface("cowork")).toBe(true);
    expect(isWorkSurface("timeline")).toBe(false);

    expect(normalizeResolvedRoute({ space: "operate", page: "surface" })).toEqual({
      space: "operate",
      page: "surface",
      surface: "chat",
    });
    expect(normalizeResolvedRoute({ space: "observe", page: "activity", tab: "scheduler" })).toMatchObject({
      tab: "scheduler",
    });
    expect(normalizeResolvedRoute({ space: "observe", page: "artifacts", tab: "files" })).toMatchObject({
      tab: "files",
    });
    expect(normalizeResolvedRoute({ space: "configure", page: "settings", tab: "providers" })).toMatchObject({
      tab: "providers",
    });
    expect(normalizeResolvedRoute({ space: "configure", page: "integrations", tab: "channels" })).toMatchObject({
      tab: "channels",
    });
    expect(normalizeResolvedRoute({ space: "configure", page: "agents", tab: "herd-lab" } as never)).toMatchObject({
      tab: "board",
    });
    expect(normalizeResolvedRoute({ space: "configure", page: "agents", tab: "unknown" as never })).toMatchObject({
      tab: "overview",
    });

    expect(getPageLabel({ space: "operate", page: "surface", surface: "chat" })).toBe("Chat");
    expect(getPageLabel({ space: "operate", page: "surface", surface: "cowork" })).toBe("Cowork");
    expect(getPageLabel({ space: "operate", page: "surface", surface: "code" })).toBe("Code");
    expect(getPageLabel({ space: "observe", page: "quality" })).toBe("Quality");
  });

  it("parses observe/configure routes, invalid routes, and legacy surface redirects", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        location: {
          href: "http://localhost:5173/?space=observe&page=artifacts&tab=generated&sessionId=sess-1&artifactId=artifact-1",
        },
      },
    });
    expect(readRouteFromLocation()).toEqual({
      space: "observe",
      page: "artifacts",
      tab: "generated",
      sessionId: "sess-1",
      artifactId: "artifact-1",
    });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        location: {
          href: "http://localhost:5173/?space=configure&page=integrations&tab=mcp&artifactId=artifact-2",
        },
      },
    });
    expect(readRouteFromLocation()).toEqual({
      space: "configure",
      page: "integrations",
      tab: "mcp",
      artifactId: "artifact-2",
    });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        location: {
          href: "http://localhost:5173/?tab=chat&surface=cowork&turnId=turn-1",
        },
      },
    });
    expect(readRouteFromLocation()).toMatchObject({
      space: "operate",
      page: "surface",
      surface: "cowork",
      turnId: "turn-1",
    });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        location: {
          href: "http://localhost:5173/?space=missing&page=nope",
        },
      },
    });
    expect(readRouteFromLocation()).toBe(DEFAULT_ROUTE);
  });

  it("builds visible page routes for all navigation buckets", () => {
    expect(buildRouteForVisiblePage({ space: "operate", page: "surface", surface: "chat" }, "tasks")).toEqual({
      space: "operate",
      page: "tasks",
    });
    expect(buildRouteForVisiblePage({ space: "observe", page: "quality" }, "timeline")).toEqual({
      space: "observe",
      page: "activity",
      tab: "activity",
    });
    expect(buildRouteForVisiblePage({ space: "observe", page: "quality" }, "health")).toEqual({
      space: "observe",
      page: "costs",
    });
    expect(buildRouteForVisiblePage({ space: "observe", page: "system" }, "health")).toEqual({
      space: "observe",
      page: "system",
    });
    expect(
      buildRouteForVisiblePage({ space: "observe", page: "quality", artifactId: "artifact-1" }, "artifacts"),
    ).toEqual({
      space: "observe",
      page: "artifacts",
      tab: "memory",
      artifactId: "artifact-1",
    });
    expect(buildRouteForVisiblePage({ space: "observe", page: "artifacts" }, "quality")).toEqual({
      space: "observe",
      page: "quality",
    });
    expect(buildRouteForVisiblePage({ space: "configure", page: "settings" }, "integrations")).toEqual({
      space: "configure",
      page: "integrations",
      tab: "overview",
    });
    expect(buildRouteForVisiblePage({ space: "configure", page: "settings" }, "agents")).toEqual({
      space: "configure",
      page: "agents",
      tab: "overview",
    });
    expect(buildRouteForVisiblePage({ space: "configure", page: "settings", tab: "addons" }, "workspaces")).toEqual({
      space: "configure",
      page: "settings",
      tab: "addons",
    });
    expect(buildRouteForVisiblePage({ space: "configure", page: "settings", tab: "access" }, "general")).toEqual({
      space: "configure",
      page: "settings",
      tab: "access",
    });
    expect(buildRouteForVisiblePage({ space: "configure", page: "agents", tab: "overview" }, "general")).toEqual({
      space: "configure",
      page: "settings",
      tab: "general",
    });
  });
});
