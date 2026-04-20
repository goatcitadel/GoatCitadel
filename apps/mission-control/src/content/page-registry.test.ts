import { afterEach, describe, expect, it } from "vitest";

import {
  buildRouteForVisiblePage,
  buildRouteSearch,
  getVisiblePage,
  getVisiblePageLabel,
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
});
