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

describe("errand target inspection across frames", () => {
  const tree = {
    frame: { id: "main", securityOrigin: "http://a" },
    childFrames: [
      {
        frame: { id: "ad", securityOrigin: "http://ads" },
        childFrames: [{ frame: { id: "ad-inner", securityOrigin: "http://a" } }],
      },
      {
        frame: { id: "shop", securityOrigin: "http://a" },
        childFrames: [{ frame: { id: "cart", securityOrigin: "http://a" } }],
      },
    ],
  };
  const pointIn = async (frameId: string) => {
    const { context, page } = fakeContext([], {
      "Page.getFrameTree": { frameTree: tree },
      "Page.createIsolatedWorld": { executionContextId: 7 },
      "DOM.getNodeForLocation": { backendNodeId: 3, frameId },
      "DOM.resolveNode": { object: { objectId: "node" } },
      "Runtime.callFunctionOn": { result: { value: BASE_INFO } },
      "Runtime.evaluate": { result: { value: BASE_INFO } },
    });
    return describePointOverCdp(context, page, 5, 5);
  };

  it("reads a same-origin frame listed after a cross-origin sibling", async () => {
    expect(await pointIn("cart")).toMatchObject({ tagName: "div", isOpaque: false });
  });

  it("still treats a frame inside a cross-origin branch as opaque", async () => {
    expect(await pointIn("ad-inner")).toMatchObject({ isOpaque: true });
  });
});

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

  it("gives the focused element its backend node id, form controls included", async () => {
    const input = { ...BASE_INFO, tagName: "input", role: "textbox" };
    const { context, page } = fakeContext([], {
      ...COMMON,
      "Runtime.evaluate": { result: { objectId: "holder" } },
      "Runtime.callFunctionOn": { result: { value: input, objectId: "obj" } },
      "DOM.describeNode": { node: { backendNodeId: 41, nodeType: 1 } },
    });
    expect(await describeFocusedOverCdp(context, page)).toMatchObject({ tagName: "input", backendNodeId: 41 });
  });

  it("leaves a focused form control without identity when its node cannot be described", async () => {
    const input = { ...BASE_INFO, tagName: "input", role: "textbox" };
    const { context, page } = fakeContext(["DOM.describeNode"], {
      ...COMMON,
      "Runtime.evaluate": { result: { objectId: "holder" } },
      "Runtime.callFunctionOn": { result: { value: input, objectId: "obj" } },
    });
    const info = await describeFocusedOverCdp(context, page);
    expect(info).toMatchObject({ tagName: "input", isOpaque: false });
    expect(info?.backendNodeId).toBeUndefined();
  });
});
