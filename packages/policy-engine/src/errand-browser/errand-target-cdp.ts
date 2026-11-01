import type { BrowserContext, CDPSession, Page } from "playwright";
import type { ErrandTargetInfo } from "./computer-actions.js";
import {
  buildDescribeFocusedExpression,
  buildDescribeNodeFunction,
  buildDescribePointExpression,
  ERRAND_TARGET_WORLD,
} from "./errand-target-script.js";

const ONE_TIME_CODE = /otp|one.?time|verification code|2fa|mfa/iu;
const FORM_CONTROL_TAGS = new Set(["input", "textarea", "select", "button", "a", "summary", "option"]);

interface InspectorWorld {
  session: CDPSession;
  contextId: number;
}

/**
 * Runs `work` in a GoatCitadel-only isolated world of the page's main frame, so page script can neither intercept nor
 * spoof the inspection. CDP can also see into closed shadow roots, which the page's own JS cannot.
 */
async function withInspectorWorld<T>(
  context: BrowserContext,
  page: Page,
  work: (world: InspectorWorld) => Promise<T>,
): Promise<T | null> {
  let session: CDPSession | undefined;
  try {
    session = await context.newCDPSession(page);
    const frameId = (await session.send("Page.getFrameTree")).frameTree.frame.id;
    const { executionContextId } = await session.send("Page.createIsolatedWorld", {
      frameId,
      worldName: ERRAND_TARGET_WORLD,
      grantUniveralAccess: false,
    });
    return await work({ session, contextId: executionContextId });
  } catch {
    return null;
  } finally {
    await session?.detach().catch(() => undefined);
  }
}

async function evaluateByValue(world: InspectorWorld, expression: string): Promise<unknown> {
  const response = await world.session.send("Runtime.evaluate", {
    contextId: world.contextId,
    expression,
    returnByValue: true,
  });
  return response.exceptionDetails ? undefined : response.result.value;
}

/** Describes the interactive element at a point. CDP's hit test reaches into closed shadow roots; the world script is the fallback. */
export async function describePointOverCdp(
  context: BrowserContext,
  page: Page,
  x: number,
  y: number,
): Promise<ErrandTargetInfo | null> {
  const result = await withInspectorWorld(context, page, async (world) => {
    try {
      await world.session.send("DOM.enable");
      const { backendNodeId } = await world.session.send("DOM.getNodeForLocation", {
        x,
        y,
        includeUserAgentShadowDOM: false,
        ignorePointerEventsNone: true,
      });
      const { object } = await world.session.send("DOM.resolveNode", {
        backendNodeId,
        executionContextId: world.contextId,
      });
      if (object.objectId) {
        const described = await world.session.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: buildDescribeNodeFunction(x, y),
          returnByValue: true,
        });
        if (!described.exceptionDetails && described.result.value) {
          return described.result.value as ErrandTargetInfo;
        }
      }
    } catch {
      // Fall back to the world-side hit test below (nodes of child frames, or a CDP hiccup).
    }
    return (await evaluateByValue(world, buildDescribePointExpression(x, y))) as ErrandTargetInfo | null | undefined;
  });
  return result ?? null;
}

/** Describes the focused element; a focused host with a (possibly closed) shadow root is also checked for password and code fields. */
export async function describeFocusedOverCdp(context: BrowserContext, page: Page): Promise<ErrandTargetInfo | null> {
  const result = await withInspectorWorld(context, page, async (world) => {
    const holder = await world.session.send("Runtime.evaluate", {
      contextId: world.contextId,
      expression: buildDescribeFocusedExpression(),
      returnByValue: false,
    });
    const holderId = holder.result.objectId;
    if (holder.exceptionDetails || !holderId) {
      return null;
    }
    const infoResponse = await world.session.send("Runtime.callFunctionOn", {
      objectId: holderId,
      functionDeclaration: "function () { return this.info; }",
      returnByValue: true,
    });
    const info = infoResponse.result.value as ErrandTargetInfo | undefined;
    if (!info) {
      return null;
    }
    if (FORM_CONTROL_TAGS.has(info.tagName)) {
      return info;
    }
    try {
      const element = await world.session.send("Runtime.callFunctionOn", {
        objectId: holderId,
        functionDeclaration: "function () { return this.element; }",
        returnByValue: false,
      });
      if (!element.result.objectId) {
        return info;
      }
      const { node } = await world.session.send("DOM.describeNode", {
        objectId: element.result.objectId,
        depth: -1,
        pierce: true,
      });
      const hidden = scanShadowContent(node);
      return {
        ...info,
        isPasswordLike: info.isPasswordLike || hidden.password,
        isOneTimeCode: info.isOneTimeCode || hidden.oneTimeCode,
      };
    } catch {
      return info;
    }
  });
  return result ?? null;
}

interface CdpNode {
  nodeType?: number;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
  contentDocument?: CdpNode;
}

/** Looks for password and one-time-code fields under the node's shadow roots. Over-flagging is acceptable here. */
function scanShadowContent(node: CdpNode): { password: boolean; oneTimeCode: boolean } {
  const found = { password: false, oneTimeCode: false };
  const visit = (current: CdpNode, insideShadow: boolean): void => {
    if (insideShadow && current.nodeType === 1 && current.attributes) {
      const attributes = new Map<string, string>();
      for (let index = 0; index + 1 < current.attributes.length; index += 2) {
        attributes.set(current.attributes[index]!.toLowerCase(), current.attributes[index + 1]!);
      }
      const type = (attributes.get("type") ?? "").toLowerCase();
      const autocomplete = (attributes.get("autocomplete") ?? "").toLowerCase();
      if (type === "password" || autocomplete.includes("password")) {
        found.password = true;
      }
      const identity = [
        attributes.get("name"),
        attributes.get("id"),
        attributes.get("aria-label"),
        attributes.get("placeholder"),
      ]
        .filter(Boolean)
        .join(" ");
      if (autocomplete.split(/\s+/u).includes("one-time-code") || ONE_TIME_CODE.test(identity)) {
        found.oneTimeCode = true;
      }
    }
    for (const root of current.shadowRoots ?? []) {
      visit(root, true);
    }
    for (const child of current.children ?? []) {
      visit(child, insideShadow);
    }
    if (current.contentDocument) {
      visit(current.contentDocument, insideShadow);
    }
  };
  visit(node, false);
  return found;
}
