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
  /**
   * Runs `dispatch` (GoatCitadel's own mouse or keyboard input) with the overlay's controls and Esc switched off, so
   * automation input is never mistaken for the operator's. Every action the errand loop sends must go through this.
   */
  withAutomationInput<T>(dispatch: () => Promise<T>): Promise<T>;
}

/** The launcher-side controls: attaching pages and hiding the overlay around a model capture. */
export interface ErrandOverlayController extends ErrandOverlay {
  attach(page: Page): Promise<void>;
  /** Runs `capture` with the overlay verified hidden on the active page, then restores it; refuses otherwise. */
  withOverlayHidden<T>(capture: () => Promise<T>): Promise<T>;
}

export class ErrandOverlayError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ErrandOverlayError";
  }
}

/** A CDP call to the overlay world did not answer within ERRAND_OVERLAY_CDP_TIMEOUT_MS. */
export class ErrandOverlayTimeoutError extends ErrandOverlayError {
  constructor(what: string) {
    super(`The errand overlay did not answer ${what} in time.`);
    this.name = "ErrandOverlayTimeoutError";
  }
}

const HIDDEN: ErrandOverlayState = { mode: "hidden" };
const EVENT_TYPES = new Set(["approve", "deny", "take_over", "hand_back", "stop"]);
const MAX_PAYLOAD_LENGTH = 512;
/** Every CDP call the overlay makes on the hot path gives up after this long instead of wedging the caller. */
export const ERRAND_OVERLAY_CDP_TIMEOUT_MS = 3_000;
/** Input reported this soon after automation input ends is still treated as automation's. */
const AUTOMATION_GRACE_MS = 150;
const HIDE_RETRY_DELAY_MS = 100;

interface WorldResult {
  installed: boolean;
  displayed?: boolean;
}

interface PageOverlay {
  ready: Promise<void>;
  applied(): ErrandOverlayState;
  apply(state: ErrandOverlayState): Promise<void>;
  /** Resolves with the host's actual state after the change; rejects when the world could not be reached. */
  setSuspended(suspended: boolean): Promise<WorldResult>;
  setAutomationInput(active: boolean): Promise<void>;
  snapshot(): Promise<ErrandOverlaySnapshot>;
  dispose(): void;
}

export function createErrandOverlay(activePage: () => Page): ErrandOverlayController {
  const pages = new Map<Page, PageOverlay>();
  const listeners = new Set<(event: ErrandOverlayEvent) => void>();
  let lastState: ErrandOverlayState = HIDDEN;
  let automationDepth = 0;
  let automationEndedAt = Number.NEGATIVE_INFINITY;

  const emit = (page: Page, event: ErrandOverlayEvent): void => {
    // Only the page the operator is looking at may answer, and never while GoatCitadel's own input is in flight.
    if (page !== activePage() || automationDepth > 0 || Date.now() - automationEndedAt < AUTOMATION_GRACE_MS) {
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

  const hideVerified = async (overlay: PageOverlay): Promise<void> => {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await overlay.setSuspended(true);
        if (!result.installed || result.displayed === false) {
          return;
        }
      } catch (error) {
        failure = error;
      }
      await new Promise((resolve) => setTimeout(resolve, HIDE_RETRY_DELAY_MS));
    }
    throw new ErrandOverlayError("The errand overlay could not be hidden, so the model capture was refused.", {
      cause: failure,
    });
  };

  return {
    async attach(page) {
      if (pages.has(page) || page.isClosed()) {
        return;
      }
      const overlay = attachPageOverlay(
        page,
        (event) => emit(page, event),
        () => automationDepth > 0,
      );
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
    async withAutomationInput(dispatch) {
      automationDepth += 1;
      const overlay = await current();
      try {
        // Best effort: the Gateway-side guard in `emit` already drops anything reported while this runs.
        await overlay?.setAutomationInput(true).catch(() => undefined);
        return await dispatch();
      } finally {
        automationDepth -= 1;
        if (automationDepth === 0) {
          automationEndedAt = Date.now();
          await overlay?.setAutomationInput(false).catch(() => undefined);
        }
      }
    },
    async withOverlayHidden(capture) {
      const overlay = await current();
      if (!overlay) {
        return capture();
      }
      try {
        await hideVerified(overlay);
        return await capture();
      } finally {
        await overlay.setSuspended(false).catch(() => undefined);
      }
    },
  };
}

function emptySnapshot(mode: ErrandOverlayState["mode"]): ErrandOverlaySnapshot {
  return { connected: false, displayed: false, mode, bannerText: null, notice: null, cursor: null, controls: {} };
}

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ErrandOverlayTimeoutError(what)), ERRAND_OVERLAY_CDP_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * One CDP session per page. The overlay runs in the "goatcitadel-errand" isolated world, and the binding it reports
 * through exists only in worlds of that name, so page script never sees either. A binding call is accepted only from
 * the errand world of the page's main frame, whose execution context ids are tracked from CDP itself.
 */
function attachPageOverlay(
  page: Page,
  onEvent: (event: ErrandOverlayEvent) => void,
  automationActive: () => boolean,
): PageOverlay {
  let session: CDPSession | undefined;
  let disposed = false;
  let mainFrameId: string | undefined;
  let worldContextId: number | undefined;
  let applied: ErrandOverlayState = HIDDEN;
  let suspended = false;

  /** Evaluates in the errand world; rejects when the world is missing, the call fails, or it times out. */
  const evaluateStrict = async (expression: string, awaitPromise = false): Promise<unknown> => {
    const contextId = worldContextId;
    if (!session || disposed || contextId === undefined) {
      throw new ErrandOverlayError("The errand overlay world is not available in this document.");
    }
    const response = await withTimeout(
      session.send("Runtime.evaluate", { contextId, expression, awaitPromise, returnByValue: true }),
      "a call",
    );
    if (response.exceptionDetails) {
      throw new ErrandOverlayError(`The errand overlay call failed: ${response.exceptionDetails.text}`);
    }
    return response.result.value;
  };

  /** Like `evaluateStrict`, but a missing or replaced document is not an error (its successor re-applies state). */
  const evaluate = async (expression: string, awaitPromise = false): Promise<unknown> => {
    try {
      return await evaluateStrict(expression, awaitPromise);
    } catch (error) {
      if (error instanceof ErrandOverlayTimeoutError) {
        throw error;
      }
      return undefined;
    }
  };

  const apiCall = (method: string, argument: unknown): string => {
    const api = `globalThis[${JSON.stringify(ERRAND_OVERLAY_API)}]`;
    return `(${api} ? ${api}.${method}(${JSON.stringify(argument) ?? "undefined"}) : { installed: false })`;
  };

  const restore = async (): Promise<void> => {
    if (automationActive()) {
      await evaluate(apiCall("setAutomationInput", true));
    }
    if (suspended) {
      await evaluate(apiCall("setSuspended", true), true);
    }
    await evaluate(apiCall("render", applied));
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
      void restore().catch(() => undefined);
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
      await evaluate(apiCall("render", state));
    },
    async setSuspended(value) {
      suspended = value;
      const result = (await evaluateStrict(apiCall("setSuspended", value), true)) as WorldResult | undefined;
      if (!result || typeof result.installed !== "boolean") {
        throw new ErrandOverlayError("The errand overlay did not report its state.");
      }
      return result;
    },
    async setAutomationInput(active) {
      await evaluateStrict(apiCall("setAutomationInput", active));
    },
    async snapshot() {
      const value = (await evaluate(apiCall("snapshot", undefined))) as ErrandOverlaySnapshot | undefined;
      return value && "mode" in value ? value : emptySnapshot(applied.mode);
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
