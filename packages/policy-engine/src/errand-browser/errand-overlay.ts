import type { CDPSession, Page } from "playwright";
import {
  ERRAND_OVERLAY_API,
  ERRAND_OVERLAY_BINDING,
  ERRAND_OVERLAY_SOURCE,
  ERRAND_OVERLAY_WORLD,
} from "./errand-overlay-script.js";

export interface ErrandOverlayPoint {
  x: number;
  y: number;
}

export interface ErrandOverlayRect extends ErrandOverlayPoint {
  width: number;
  height: number;
}

export type ErrandOverlayState =
  | { mode: "hidden" }
  | { mode: "driving"; bannerText: string; cursor: ErrandOverlayPoint }
  | {
      mode: "approval";
      bannerText: string;
      cursor: ErrandOverlayPoint;
      requestId: string;
      title: string;
      body: string;
      targetRect: ErrandOverlayRect;
    }
  | { mode: "taken_over"; bannerText: string }
  | { mode: "sign_in"; bannerText: string };

export type ErrandOverlayEvent =
  | { type: "approve" | "deny"; requestId: string }
  | { type: "take_over" | "hand_back" | "stop" };

export interface ErrandOverlayControlSnapshot extends ErrandOverlayRect {
  /** The IntersectionObserver v2 verdict for the control, or null before the first sample. */
  visible: boolean | null;
}

/** What the overlay currently draws, read from GoatCitadel's own world (never from the page). */
export interface ErrandOverlaySnapshot {
  connected: boolean;
  displayed: boolean;
  mode: ErrandOverlayState["mode"];
  bannerText: string | null;
  notice: string | null;
  cursor: ErrandOverlayPoint | null;
  controls: Partial<
    Record<"take_over" | "hand_back" | "stop" | "approve" | "deny", ErrandOverlayControlSnapshot | undefined>
  >;
}

export interface ErrandOverlay {
  /** Draws the state on the active page. Cheap to call repeatedly; the last state is re-applied after navigation. */
  render(state: ErrandOverlayState): Promise<void>;
  /** Registers a listener for operator input on the overlay; returns an unsubscribe function. */
  onEvent(listener: (event: ErrandOverlayEvent) => void): () => void;
  /** Reads what the overlay draws on the active page. */
  snapshot(): Promise<ErrandOverlaySnapshot>;
}

/** The launcher-side controls: attaching pages and hiding the overlay around a model capture. */
export interface ErrandOverlayController extends ErrandOverlay {
  attach(page: Page): Promise<void>;
  /** Runs `capture` with the overlay hidden on the active page, then restores it. */
  withOverlayHidden<T>(capture: () => Promise<T>): Promise<T>;
}

const HIDDEN: ErrandOverlayState = { mode: "hidden" };
const EVENT_TYPES = new Set(["approve", "deny", "take_over", "hand_back", "stop"]);
const MAX_PAYLOAD_LENGTH = 512;

interface PageOverlay {
  ready: Promise<void>;
  applied(): ErrandOverlayState;
  apply(state: ErrandOverlayState): Promise<void>;
  setSuspended(suspended: boolean): Promise<void>;
  snapshot(): Promise<ErrandOverlaySnapshot>;
  dispose(): void;
}

export function createErrandOverlay(activePage: () => Page): ErrandOverlayController {
  const pages = new Map<Page, PageOverlay>();
  const listeners = new Set<(event: ErrandOverlayEvent) => void>();
  let lastState: ErrandOverlayState = HIDDEN;

  const emit = (page: Page, event: ErrandOverlayEvent): void => {
    // Only the page the operator is looking at may answer, and an answer must name the request it shows.
    if (page !== activePage()) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A faulty listener must not stop the others.
      }
    }
  };

  const current = async (): Promise<PageOverlay | undefined> => {
    const overlay = pages.get(activePage());
    await overlay?.ready.catch(() => undefined);
    return overlay;
  };

  return {
    async attach(page) {
      if (pages.has(page) || page.isClosed()) {
        return;
      }
      const overlay = attachPageOverlay(page, (event) => emit(page, event));
      pages.set(page, overlay);
      page.once("close", () => {
        overlay.dispose();
        pages.delete(page);
      });
      await overlay.ready;
    },
    async render(state) {
      lastState = state;
      const target = activePage();
      const overlay = await current();
      const work: Promise<void>[] = [];
      if (overlay) {
        work.push(overlay.apply(state));
      }
      for (const [page, other] of pages) {
        if (page !== target && other.applied().mode !== "hidden") {
          work.push(other.apply(HIDDEN));
        }
      }
      await Promise.all(work);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async snapshot() {
      const overlay = await current();
      if (!overlay) {
        return emptySnapshot(lastState.mode);
      }
      return overlay.snapshot();
    },
    async withOverlayHidden(capture) {
      const overlay = await current();
      await overlay?.setSuspended(true);
      try {
        return await capture();
      } finally {
        await overlay?.setSuspended(false);
      }
    },
  };
}

function emptySnapshot(mode: ErrandOverlayState["mode"]): ErrandOverlaySnapshot {
  return { connected: false, displayed: false, mode, bannerText: null, notice: null, cursor: null, controls: {} };
}

/**
 * One CDP session per page. The overlay runs in the "goatcitadel-errand" isolated world, and the binding it reports
 * through exists only in worlds of that name, so page script never sees either. A binding call is accepted only from
 * the errand world of the page's main frame, whose execution context ids are tracked from CDP itself.
 */
function attachPageOverlay(page: Page, onEvent: (event: ErrandOverlayEvent) => void): PageOverlay {
  let session: CDPSession | undefined;
  let disposed = false;
  let mainFrameId: string | undefined;
  let worldContextId: number | undefined;
  let applied: ErrandOverlayState = HIDDEN;
  let suspended = false;

  const evaluate = async (expression: string, awaitPromise = false): Promise<unknown> => {
    const contextId = worldContextId;
    if (!session || disposed || contextId === undefined) {
      return undefined;
    }
    try {
      const response = await session.send("Runtime.evaluate", {
        contextId,
        expression,
        awaitPromise,
        returnByValue: true,
      });
      return response.exceptionDetails ? undefined : response.result.value;
    } catch {
      // The document went away mid-call; the next document re-applies the state when its world appears.
      return undefined;
    }
  };

  const callApi = (method: string, argument: unknown, awaitPromise = false) =>
    evaluate(`globalThis[${JSON.stringify(ERRAND_OVERLAY_API)}]?.${method}(${JSON.stringify(argument)})`, awaitPromise);

  const restore = async (): Promise<void> => {
    if (suspended) {
      await callApi("setSuspended", true, true);
    }
    await callApi("render", applied);
  };

  const handleBinding = (payload: string): void => {
    const event = parseOverlayEvent(payload);
    if (!event) {
      return;
    }
    if (event.type === "approve" || event.type === "deny") {
      if (applied.mode !== "approval" || applied.requestId !== event.requestId) {
        return;
      }
    } else if (applied.mode === "hidden") {
      return;
    }
    onEvent(event);
  };

  const ready = (async () => {
    session = await page.context().newCDPSession(page);
    session.on("Runtime.executionContextCreated", ({ context }) => {
      const aux = context.auxData as { type?: string; frameId?: string } | undefined;
      if (context.name !== ERRAND_OVERLAY_WORLD || aux?.type !== "isolated" || aux.frameId !== mainFrameId) {
        return;
      }
      worldContextId = context.id;
      void restore();
    });
    session.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
      if (executionContextId === worldContextId) {
        worldContextId = undefined;
      }
    });
    session.on("Runtime.executionContextsCleared", () => {
      worldContextId = undefined;
    });
    session.on("Page.frameNavigated", ({ frame }) => {
      if (!frame.parentId) {
        mainFrameId = frame.id;
      }
    });
    session.on("Runtime.bindingCalled", ({ name, payload, executionContextId }) => {
      if (
        name === ERRAND_OVERLAY_BINDING &&
        executionContextId !== undefined &&
        executionContextId === worldContextId
      ) {
        handleBinding(payload);
      }
    });
    await session.send("Page.enable");
    mainFrameId = (await session.send("Page.getFrameTree")).frameTree.frame.id;
    await session.send("Runtime.enable");
    await session.send("Runtime.addBinding", {
      name: ERRAND_OVERLAY_BINDING,
      executionContextName: ERRAND_OVERLAY_WORLD,
    });
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: ERRAND_OVERLAY_SOURCE,
      worldName: ERRAND_OVERLAY_WORLD,
    });
    const { executionContextId } = await session.send("Page.createIsolatedWorld", {
      frameId: mainFrameId,
      worldName: ERRAND_OVERLAY_WORLD,
      grantUniveralAccess: false,
    });
    worldContextId = executionContextId;
    await evaluate(ERRAND_OVERLAY_SOURCE);
    await restore();
  })();
  ready.catch(() => undefined);

  return {
    ready,
    applied: () => applied,
    async apply(state) {
      applied = state;
      await callApi("render", state);
    },
    async setSuspended(value) {
      suspended = value;
      await callApi("setSuspended", value, true);
    },
    async snapshot() {
      const value = (await callApi("snapshot", undefined)) as ErrandOverlaySnapshot | undefined;
      return value ?? emptySnapshot(applied.mode);
    },
    dispose() {
      disposed = true;
      void session?.detach().catch(() => undefined);
    },
  };
}

/** Accepts only the exact event shapes the overlay sends; anything else is dropped. */
export function parseOverlayEvent(payload: string): ErrandOverlayEvent | undefined {
  if (typeof payload !== "string" || payload.length > MAX_PAYLOAD_LENGTH) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const { type, requestId } = parsed as { type?: unknown; requestId?: unknown };
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) {
    return undefined;
  }
  if (type === "approve" || type === "deny") {
    return typeof requestId === "string" && requestId.length > 0 ? { type, requestId } : undefined;
  }
  return { type: type as "take_over" | "hand_back" | "stop" };
}
