/**
 * The errand overlay as it runs inside the page, in GoatCitadel's own isolated world ("goatcitadel-errand").
 *
 * The page's scripts share the DOM with this world but not its JavaScript globals, so they cannot see this code, the
 * overlay API it installs, or the CDP binding it reports through. The overlay draws into a closed shadow root on a
 * fixed, top-most host, so page script cannot read or restyle what is inside it, and a MutationObserver re-attaches
 * the host if the page removes it.
 *
 * `errandOverlayMain` is serialized with `Function.prototype.toString`, so it must stay self-contained: it may use only
 * its parameter and browser globals, never anything else from this module.
 */

export const ERRAND_OVERLAY_WORLD = "goatcitadel-errand";
export const ERRAND_OVERLAY_BINDING = "__gcErrandOverlayEvent";
export const ERRAND_OVERLAY_API = "__gcErrandOverlay";

/** Every literal the overlay draws with lives here: copy, colors and motion timings. */
export const ERRAND_OVERLAY_COPY = {
  banner: "GoatCitadel is using this browser",
  takeOver: "Take over",
  handBack: "Hand back",
  stop: "Stop",
  approve: "Approve",
  deny: "Not now",
  useChat: "Use Approve in Chat for this one.",
} as const;

const ERRAND_OVERLAY_CONSTANTS = {
  binding: ERRAND_OVERLAY_BINDING,
  api: ERRAND_OVERLAY_API,
  copy: ERRAND_OVERLAY_COPY,
  colors: {
    accent: "#5ce9ff",
    navy: "#0e1a27",
    text: "#e6f7fb",
    dim: "rgba(4, 10, 16, 0.58)",
  },
  zIndex: 2147483647,
  /** IntersectionObserver v2 visibility sampling; the spec's minimum delay. */
  visibilityDelayMs: 100,
  motion: {
    minMs: 220,
    maxMs: 400,
    msPerPx: 0.36,
    arcRatio: 0.12,
    arcMaxPx: 48,
    settleMs: 80,
    overshootMaxPx: 6,
    trailMs: 180,
    trailMaxDots: 24,
  },
} as const;

export type ErrandOverlayConstants = typeof ERRAND_OVERLAY_CONSTANTS;

interface Point {
  x: number;
  y: number;
}

interface Rect extends Point {
  width: number;
  height: number;
}

type OverlayEventPayload =
  | { type: "approve" | "deny"; requestId: string }
  | { type: "take_over" | "hand_back" | "stop" };

interface OverlayState {
  mode: "hidden" | "driving" | "approval" | "taken_over" | "sign_in";
  bannerText?: string;
  cursor?: Point;
  requestId?: string;
  title?: string;
  body?: string;
  targetRect?: Rect;
}

function errandOverlayMain(c: ErrandOverlayConstants): void {
  if (window.top !== window) {
    return;
  }
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope[c.api]) {
    return;
  }
  const binding = scope[c.binding];
  const report = (payload: OverlayEventPayload): void => {
    if (typeof binding === "function") {
      (binding as (message: string) => void)(JSON.stringify(payload));
    }
  };

  // ---- DOM -------------------------------------------------------------------------------------------------------
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer { position: fixed; inset: 0; pointer-events: none; font: 500 13px/1.4 system-ui, "Segoe UI", sans-serif;
      color: ${c.colors.text}; }
    .spot { position: fixed; border-radius: 6px; outline: 2px solid ${c.colors.accent}; outline-offset: 2px;
      box-shadow: 0 0 0 200vmax ${c.colors.dim}; pointer-events: none; }
    .blocker { position: fixed; inset: 0; pointer-events: auto; background: transparent; }
    .cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none;
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5)); will-change: transform; }
    .dot { position: fixed; left: 0; top: 0; width: 6px; height: 6px; margin: -3px 0 0 -3px; border-radius: 50%;
      background: ${c.colors.accent}; pointer-events: none; animation: fade ${c.motion.trailMs}ms linear forwards; }
    @keyframes fade { from { opacity: 0.55; } to { opacity: 0; } }
    .banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center;
      gap: 12px; padding: 8px 10px 8px 16px; border: 1px solid ${c.colors.accent}; border-radius: 10px;
      background: ${c.colors.navy}; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35); pointer-events: none;
      white-space: nowrap; }
    .banner .text { color: ${c.colors.accent}; }
    .card { position: fixed; width: 320px; padding: 14px 16px; border: 1px solid ${c.colors.accent};
      border-radius: 12px; background: ${c.colors.navy}; box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
      pointer-events: auto; }
    .card .title { color: ${c.colors.accent}; font-size: 15px; font-weight: 600; margin: 0 0 6px; }
    .card .body { margin: 0 0 12px; white-space: pre-wrap; }
    .card .notice { margin: 0 0 12px; color: ${c.colors.accent}; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    button { pointer-events: auto; font: inherit; border-radius: 8px; padding: 6px 12px; cursor: pointer;
      border: 1px solid ${c.colors.accent}; background: transparent; color: ${c.colors.accent}; }
    button.primary { background: ${c.colors.accent}; color: ${c.colors.navy}; font-weight: 600; }
    button:focus-visible { outline: 2px solid ${c.colors.text}; outline-offset: 2px; }
    [hidden] { display: none !important; }
  `;
  const layer = document.createElement("div");
  layer.className = "layer";
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  };
  const spot = make("div", "spot");
  const blocker = make("div", "blocker");
  const trail = make("div", "trail");
  const cursor = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  cursor.setAttribute("class", "cursor");
  cursor.setAttribute("viewBox", "0 0 22 22");
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrow.setAttribute("d", "M2 1.5 L2 18 L6.6 13.6 L9.6 20.5 L12.6 19.2 L9.7 12.4 L16 12.4 Z");
  arrow.setAttribute("fill", c.colors.accent);
  arrow.setAttribute("stroke", c.colors.navy);
  arrow.setAttribute("stroke-width", "1.4");
  arrow.setAttribute("stroke-linejoin", "round");
  cursor.append(arrow);

  const banner = make("div", "banner");
  banner.setAttribute("role", "status");
  const bannerText = make("span", "text");
  const takeOver = make("button", "", c.copy.takeOver);
  const handBack = make("button", "", c.copy.handBack);
  const stop = make("button", "", c.copy.stop);
  banner.append(bannerText, takeOver, handBack, stop);

  const card = make("div", "card");
  card.setAttribute("role", "dialog");
  const cardTitle = make("p", "title");
  const cardBody = make("p", "body");
  const cardNotice = make("p", "notice");
  const approve = make("button", "primary", c.copy.approve);
  const deny = make("button", "", c.copy.deny);
  const actions = make("div", "actions");
  actions.append(deny, approve);
  card.append(cardTitle, cardBody, cardNotice, actions);

  // Paint order matters: nothing GoatCitadel draws may sit above the card's buttons, or the visibility check fails.
  layer.append(spot, blocker, trail, cursor, banner, card);
  root.append(style, layer);
  for (const button of [takeOver, handBack, stop, approve, deny]) {
    button.type = "button";
  }

  // ---- State -----------------------------------------------------------------------------------------------------
  let state: OverlayState = { mode: "hidden" };
  let suspended = false;
  let cursorAt: Point | undefined;
  let cursorTarget: Point | undefined;

  const hostStyle = (): string =>
    [
      "all: initial !important",
      "position: fixed !important",
      "left: 0 !important",
      "top: 0 !important",
      "width: 100vw !important",
      "height: 100vh !important",
      "margin: 0 !important",
      "padding: 0 !important",
      "border: 0 !important",
      "pointer-events: none !important",
      `z-index: ${c.zIndex} !important`,
      `display: ${suspended || state.mode === "hidden" ? "none" : "block"} !important`,
    ].join("; ");

  const applyHostStyle = (): void => {
    const wanted = hostStyle();
    if (host.getAttribute("style") !== wanted) {
      host.setAttribute("style", wanted);
    }
    for (const attribute of Array.from(host.attributes)) {
      if (attribute.name !== "style") {
        host.removeAttribute(attribute.name);
      }
    }
  };

  // ---- Re-attach when the page removes or restyles the host ------------------------------------------------------
  let observedRoot: Element | null = null;
  const ensureAttached = (): void => {
    let documentRoot = document.documentElement;
    if (!documentRoot && document.readyState !== "loading") {
      documentRoot = document.appendChild(document.createElement("html"));
    }
    if (!documentRoot) {
      return;
    }
    if (host.parentNode !== documentRoot) {
      documentRoot.appendChild(host);
    }
    if (observedRoot !== documentRoot) {
      observedRoot = documentRoot;
      rootObserver.observe(documentRoot, { childList: true });
    }
    applyHostStyle();
  };
  const rootObserver = new MutationObserver(ensureAttached);
  new MutationObserver(ensureAttached).observe(document, { childList: true });
  new MutationObserver(applyHostStyle).observe(host, { attributes: true });
  ensureAttached();
  document.addEventListener("DOMContentLoaded", ensureAttached);

  // ---- Visibility: IntersectionObserver v2 -----------------------------------------------------------------------
  // `isVisible` is true only when the browser itself confirms nothing is painted over the button and no ancestor
  // fades, filters or transforms it, so a page cannot cover the card (even with pointer-events: none) to steer a click.
  const visible = new Map<Element, boolean>();
  const visibility = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        visible.set(entry.target, (entry as IntersectionObserverEntry & { isVisible?: boolean }).isVisible === true);
      }
    },
    { trackVisibility: true, delay: c.visibilityDelayMs } as IntersectionObserverInit,
  );
  visibility.observe(approve);
  visibility.observe(deny);

  const onControl = (element: HTMLElement, handler: (event: MouseEvent) => void): void => {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!event.isTrusted || suspended) {
        return;
      }
      handler(event);
    });
  };
  const decide = (type: "approve" | "deny") => () => {
    const button = type === "approve" ? approve : deny;
    if (state.mode !== "approval" || !state.requestId) {
      return;
    }
    if (visible.get(button) !== true) {
      cardNotice.textContent = c.copy.useChat;
      cardNotice.hidden = false;
      return;
    }
    report({ type, requestId: state.requestId });
  };
  onControl(approve, decide("approve"));
  onControl(deny, decide("deny"));
  onControl(takeOver, () => report({ type: "take_over" }));
  onControl(handBack, () => report({ type: "hand_back" }));
  onControl(stop, () => report({ type: "stop" }));
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.isTrusted && event.key === "Escape" && state.mode !== "hidden" && !suspended) {
        report({ type: "stop" });
      }
    },
    true,
  );

  // ---- Cursor motion ---------------------------------------------------------------------------------------------
  // A quadratic Bezier from the current point to the target, bowed by a small perpendicular arc, eased in and out,
  // then a brief damped spring along the travel direction so the arrow settles instead of stopping dead.
  let frame = 0;
  let fallback = 0;
  let lastDot = 0;
  const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const placeCursor = (point: Point): void => {
    cursorAt = point;
    cursor.style.transform = `translate(${point.x - 2}px, ${point.y - 1.5}px)`;
  };
  const dropDot = (point: Point, now: number): void => {
    if (now - lastDot < 16) {
      return;
    }
    lastDot = now;
    const dot = make("div", "dot");
    dot.style.transform = `translate(${point.x}px, ${point.y}px)`;
    trail.append(dot);
    while (trail.childElementCount > c.motion.trailMaxDots) {
      trail.firstElementChild?.remove();
    }
    setTimeout(() => dot.remove(), c.motion.trailMs + 20);
  };
  const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const moveCursor = (target: Point): void => {
    if (cursorTarget && cursorTarget.x === target.x && cursorTarget.y === target.y) {
      return;
    }
    cursorTarget = target;
    cancelAnimationFrame(frame);
    clearTimeout(fallback);
    const from = cursorAt;
    const dx = from ? target.x - from.x : 0;
    const dy = from ? target.y - from.y : 0;
    const distance = Math.hypot(dx, dy);
    if (!from || distance < 1 || reducedMotion()) {
      trail.replaceChildren();
      placeCursor(target);
      return;
    }
    const total = Math.min(c.motion.maxMs, Math.max(c.motion.minMs, c.motion.minMs + distance * c.motion.msPerPx));
    const settle = Math.min(c.motion.settleMs, total * 0.25);
    const glide = total - settle;
    const ux = dx / distance;
    const uy = dy / distance;
    const bow = Math.min(distance * c.motion.arcRatio, c.motion.arcMaxPx) * (dx >= 0 ? -1 : 1);
    const control = { x: from.x + dx / 2 - uy * bow, y: from.y + dy / 2 + ux * bow };
    const overshoot = Math.min(c.motion.overshootMaxPx, distance * 0.02);
    const started = performance.now();
    const step = (now: number): void => {
      const elapsed = now - started;
      if (elapsed < glide) {
        const t = easeInOut(elapsed / glide);
        const inverse = 1 - t;
        const point = {
          x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * target.x,
          y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * target.y,
        };
        placeCursor(point);
        dropDot(point, now);
        frame = requestAnimationFrame(step);
        return;
      }
      const u = Math.min(1, (elapsed - glide) / settle);
      const spring = overshoot * Math.exp(-5 * u) * Math.sin(3 * Math.PI * u);
      placeCursor({ x: target.x + ux * spring, y: target.y + uy * spring });
      if (u < 1) {
        frame = requestAnimationFrame(step);
      } else {
        placeCursor(target);
      }
    };
    frame = requestAnimationFrame(step);
    // Background windows throttle animation frames; never leave the arrow short of its target.
    fallback = window.setTimeout(() => {
      cancelAnimationFrame(frame);
      placeCursor(target);
    }, total + 120);
  };

  // ---- Layout ----------------------------------------------------------------------------------------------------
  const placeCard = (target: Rect, point: Point): void => {
    const gap = 16;
    const width = card.offsetWidth || 320;
    const height = card.offsetHeight || 140;
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;
    const top = banner.hidden ? 8 : banner.getBoundingClientRect().bottom + 8;
    const clampY = (y: number) => Math.max(top, Math.min(y, viewHeight - height - 8));
    const clampX = (x: number) => Math.max(8, Math.min(x, viewWidth - width - 8));
    const candidates: Point[] = [
      { x: target.x + target.width + gap, y: clampY(point.y - 24) },
      { x: target.x - gap - width, y: clampY(point.y - 24) },
      { x: clampX(point.x - width / 2), y: target.y + target.height + gap },
      { x: clampX(point.x - width / 2), y: target.y - gap - height },
    ];
    const fits = (p: Point) => p.x >= 8 && p.y >= top && p.x + width <= viewWidth - 8 && p.y + height <= viewHeight - 8;
    const chosen = candidates.find(fits) ?? { x: clampX(point.x + gap), y: clampY(point.y + gap) };
    card.style.left = `${Math.round(chosen.x)}px`;
    card.style.top = `${Math.round(chosen.y)}px`;
  };

  const render = (next: OverlayState): void => {
    const previous = state;
    state = next;
    applyHostStyle();
    if (next.mode === "hidden") {
      return;
    }
    bannerText.textContent = next.bannerText ?? c.copy.banner;
    takeOver.hidden = next.mode !== "driving";
    handBack.hidden = next.mode !== "taken_over" && next.mode !== "sign_in";
    const approval = next.mode === "approval";
    spot.hidden = !approval;
    blocker.hidden = !approval;
    card.hidden = !approval;
    const showCursor = next.mode === "driving" || approval;
    cursor.style.display = showCursor ? "block" : "none";
    trail.hidden = !showCursor;
    if (showCursor && next.cursor) {
      moveCursor(next.cursor);
    }
    if (approval && next.targetRect && next.cursor) {
      const rect = next.targetRect;
      spot.style.left = `${rect.x}px`;
      spot.style.top = `${rect.y}px`;
      spot.style.width = `${rect.width}px`;
      spot.style.height = `${rect.height}px`;
      cardTitle.textContent = next.title ?? "";
      cardBody.textContent = next.body ?? "";
      if (previous.mode !== "approval" || previous.requestId !== next.requestId) {
        cardNotice.textContent = "";
        cardNotice.hidden = true;
      }
      placeCard(rect, next.cursor);
    }
  };

  const controlRect = (element: HTMLElement) => {
    if (host.style.display === "none" || element.hidden || element.closest("[hidden]")) {
      return undefined;
    }
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, visible: visible.get(element) ?? null };
  };

  const api = {
    render,
    setSuspended(value: boolean): Promise<void> {
      suspended = value;
      applyHostStyle();
      // Resolve once the change has been painted, with a timer in case the window is not producing frames.
      return new Promise<void>((resolve) => {
        const done = setTimeout(resolve, 60);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(done);
            resolve();
          }),
        );
      });
    },
    snapshot() {
      const displayed = host.isConnected && host.style.display !== "none";
      return {
        connected: host.isConnected,
        displayed,
        mode: state.mode,
        bannerText: displayed ? bannerText.textContent : null,
        notice: !card.hidden && !cardNotice.hidden ? cardNotice.textContent : null,
        cursor: cursorAt ?? null,
        controls: displayed
          ? {
              take_over: controlRect(takeOver),
              hand_back: controlRect(handBack),
              stop: controlRect(stop),
              approve: controlRect(approve),
              deny: controlRect(deny),
            }
          : {},
      };
    },
  };
  Object.defineProperty(scope, c.api, { value: Object.freeze(api), configurable: false, writable: false });
}

/** The overlay program evaluated in the isolated world of every new document (and of the current one at attach). */
export const ERRAND_OVERLAY_SOURCE = `(${errandOverlayMain.toString()})(${JSON.stringify(ERRAND_OVERLAY_CONSTANTS)});`;
