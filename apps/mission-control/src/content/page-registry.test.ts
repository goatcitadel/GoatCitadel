import { afterEach, describe, expect, it, vi } from "vitest";

import { buildRouteSearch, readRouteFromLocation } from "./page-registry";

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
    expect(buildRouteSearch({
      space: "operate",
      page: "surface",
      surface: "code",
      sessionId: "sess-code",
      turnId: "turn-code",
      approvalId: "approval-code",
    })).toBe("?space=operate&page=surface&surface=code&sessionId=sess-code&turnId=turn-code&approvalId=approval-code");
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
});
