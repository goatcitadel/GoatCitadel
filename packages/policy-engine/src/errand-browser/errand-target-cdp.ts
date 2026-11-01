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
  frameId: string;
  frameTree: FrameTreeNode;
}

interface FrameTreeNode {
  frame: { id: string; securityOrigin?: string };
  childFrames?: FrameTreeNode[];
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
    const frameTree = (await session.send("Page.getFrameTree")).frameTree as FrameTreeNode;
    const frameId = frameTree.frame.id;
    const { executionContextId } = await session.send("Page.createIsolatedWorld", {
      frameId,
      worldName: ERRAND_TARGET_WORLD,
      grantUniveralAccess: false,
    });
    return await work({ session, contextId: executionContextId, frameId, frameTree });
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

/**
 * Describes the interactive element at a point. CDP's hit test reaches into closed shadow roots and same-origin frames.
 * When that path fails, the world-side hit test (which cannot see closed roots) answers, flagged opaque.
 */
export async function describePointOverCdp(
  context: BrowserContext,
  page: Page,
  x: number,
  y: number,
): Promise<ErrandTargetInfo | null> {
  const result = await withInspectorWorld(context, page, async (world) => {
    try {
      await world.session.send("DOM.enable");
      const { backendNodeId, frameId } = await world.session.send("DOM.getNodeForLocation", {
        x,
        y,
        includeUserAgentShadowDOM: false,
        // Hit-test like a real click: pointer-events:none layers (GoatCitadel's own overlay, or a page's decoy laid
        // over a button) are passed through, so the element described is the one the click would reach.
        ignorePointerEventsNone: false,
      });
      let contextId = world.contextId;
      if (frameId && frameId !== world.frameId) {
        if (!isSameOriginChain(world.frameTree, frameId)) {
          throw new Error("The node sits in a cross-origin frame.");
        }
        contextId = (
          await world.session.send("Page.createIsolatedWorld", {
            frameId,
            worldName: ERRAND_TARGET_WORLD,
            grantUniveralAccess: false,
          })
        ).executionContextId;
      }
      const { object } = await world.session.send("DOM.resolveNode", { backendNodeId, executionContextId: contextId });
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
      // Fall through to the flagged world-side answer.
    }
    const fallback = (await evaluateByValue(world, buildDescribePointExpression(x, y))) as
      | ErrandTargetInfo
      | null
      | undefined;
    return fallback ? { ...fallback, isOpaque: true } : null;
  });
  return result ?? null;
}

/** True when every frame from the main frame down to `frameId` shares the main frame's origin (so its content is readable). */
function isSameOriginChain(root: FrameTreeNode, frameId: string): boolean {
  const origin = root.frame.securityOrigin;
  const walk = (node: FrameTreeNode): boolean | undefined => {
    if (node.frame.securityOrigin !== origin) {
      return false;
    }
    if (node.frame.id === frameId) {
      return true;
    }
    for (const child of node.childFrames ?? []) {
      const found = walk(child);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return walk(root) === true;
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
    const formControl = FORM_CONTROL_TAGS.has(info.tagName);
    try {
      const element = await world.session.send("Runtime.callFunctionOn", {
        objectId: holderId,
        functionDeclaration: "function () { return this.element; }",
        returnByValue: false,
      });
      if (!element.result.objectId) {
        return formControl ? info : { ...info, isOpaque: true };
      }
      // A form control has no shadow content worth scanning; its node is described only for its identity.
      const { node } = await world.session.send("DOM.describeNode", {
        objectId: element.result.objectId,
        depth: formControl ? 0 : -1,
        pierce: !formControl,
      });
      const identity = typeof node.backendNodeId === "number" ? { backendNodeId: node.backendNodeId } : {};
      if (formControl) {
        return { ...info, ...identity };
      }
      const hidden = scanShadowContent(node);
      return {
        ...info,
        ...identity,
        isPasswordLike: info.isPasswordLike || hidden.password,
        isOneTimeCode: info.isOneTimeCode || hidden.oneTimeCode,
      };
    } catch {
      // Without identity a later check fails closed. A host that could not be inspected may hide a field in a closed root.
      return formControl ? info : { ...info, isOpaque: true };
    }
  });
  return result ?? null;
}

interface CdpNode {
  backendNodeId?: number;
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
