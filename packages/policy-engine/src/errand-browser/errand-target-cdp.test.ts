import type { BrowserContext, Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { ErrandTargetInfo } from "./computer-actions.js";
import { describeFocusedOverCdp, describePointOverCdp } from "./errand-target-cdp.js";

const BASE_INFO: ErrandTargetInfo = {
  x: 5,
  y: 5,
  tagName: "div",
  role: "generic",
  text: "",
  isPasswordLike: false,
  isOneTimeCode: false,
  isOpaque: false,
  rect: { x: 0, y: 0, width: 10, height: 10 },
};

/** A scripted CDP session: methods listed in `failing` reject, the rest answer from `answers`. */
function fakeContext(failing: string[], answers: Record<string, unknown>): { context: BrowserContext; page: Page } {
  const session = {
    send: async (method: string) => {
      if (failing.includes(method)) {
        throw new Error(`${method} failed`);
      }
      return answers[method] ?? {};
    },
    detach: async () => undefined,
  };
  const context = { newCDPSession: async () => session } as unknown as BrowserContext;
  return { context, page: {} as Page };
}

const COMMON = {
  "Page.getFrameTree": { frameTree: { frame: { id: "main", securityOrigin: "http://a" } } },
  "Page.createIsolatedWorld": { executionContextId: 7 },
};

describe("errand target inspection fault handling", () => {
  it("flags the world-side answer as opaque when the CDP hit test fails", async () => {
    const { context, page } = fakeContext(["DOM.getNodeForLocation"], {
      ...COMMON,
      "Runtime.evaluate": { result: { value: BASE_INFO } },
    });
    const info = await describePointOverCdp(context, page, 5, 5);
    expect(info).toMatchObject({ tagName: "div", isOpaque: true });
  });

  it("returns null (unknown) when nothing can be inspected", async () => {
    const { context, page } = fakeContext(["Page.getFrameTree"], COMMON);
    expect(await describePointOverCdp(context, page, 5, 5)).toBeNull();
    expect(await describeFocusedOverCdp(context, page)).toBeNull();
  });

  it("flags a focused host as opaque when its shadow content cannot be read", async () => {
    const { context, page } = fakeContext(["DOM.describeNode"], {
      ...COMMON,
      "Runtime.evaluate": { result: { objectId: "holder" } },
      "Runtime.callFunctionOn": { result: { value: BASE_INFO, objectId: "obj" } },
    });
    const info = await describeFocusedOverCdp(context, page);
    expect(info).toMatchObject({ tagName: "div", isOpaque: true });
  });
});
