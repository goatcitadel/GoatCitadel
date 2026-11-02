import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { installBrowserRequestGuards, buildPlaywrightContextOptions } from "../browser-tools.js";
import { startBrowserEgressProxy, type BrowserEgressProxy } from "../browser-egress-proxy.js";
import {
  BROWSER_CHROMIUM_SECURITY_ARGS,
  isMissingPlaywrightBrowserError,
  loadPlaywright,
} from "../playwright-runtime.js";
import type { ComputerAction, ErrandTargetInfo } from "./computer-actions.js";
import { dispatchComputerAction, pointOf } from "./computer-dispatch.js";
import { createErrandOverlay, type ErrandOverlay } from "./errand-overlay.js";
import { describeFocusedOverCdp, describePointOverCdp } from "./errand-target-cdp.js";

export type ErrandBrowserLaunchErrorCode = "profile_locked" | "chrome_missing" | "launch_failed";

export class ErrandBrowserLaunchError extends Error {
  readonly code: ErrandBrowserLaunchErrorCode;

  constructor(code: ErrandBrowserLaunchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ErrandBrowserLaunchError";
    this.code = code;
  }
}

export interface ErrandBrowserLaunchOptions {
  /** The persistent Chrome profile directory (cookies, logins and extensions live here). */
  profileDir: string;
  /** Use the operator's installed Chrome instead of the bundled Chromium. */
  channel?: "chrome";
  /** Defaults to false: errands run in a visible window. */
  headless?: boolean;
  /** Host allowlist for the egress proxy and request guards. Private/LAN targets stay blocked unless named. */
  networkAllowlist: string[];
  signal?: AbortSignal;
}

export interface ErrandBrowser {
  page(): Page;
  currentUrl(): string;
  /** A PNG of the page for the model. GoatCitadel's overlay is hidden for this capture, so the model sees the page. */
  captureForModel(): Promise<Buffer>;
  /** A PNG of the page as the operator sees it, overlay included. */
  captureForPeople(): Promise<Buffer>;
  isClosed(): boolean;
  /** Registers a listener for the browser going away; returns an unsubscribe function. */
  onClosed(listener: () => void): () => void;
  close(): Promise<void>;
  /** The banner, cursor and approval card GoatCitadel draws over the page, out of the page's reach. */
  overlay: ErrandOverlay;
  /**
   * Describes the interactive element at a viewport point, read in an isolated world. Null means GoatCitadel could not
   * inspect it; callers must treat it as unknown, never as safe.
   */
  describeTarget(x: number, y: number): Promise<ErrandTargetInfo | null>;
  /**
   * Like describeTarget, but with GoatCitadel's overlay verified hidden for the read, so an approval card covering the
   * page is not mistaken for the target. Null when the overlay could not be hidden or the point could not be inspected.
   */
  describeTargetBeneathOverlay(x: number, y: number): Promise<ErrandTargetInfo | null>;
  /**
   * Describes the focused element, read in an isolated world. Null means nothing is focused or GoatCitadel could not
   * inspect it; callers must treat it as unknown, never as safe.
   */
  describeFocused(): Promise<ErrandTargetInfo | null>;
  /**
   * Like describeFocused, but with GoatCitadel's overlay verified hidden for the read, the way an approval re-check reads
   * the page. Null when the overlay could not be hidden or nothing focused could be inspected.
   */
  describeFocusedBeneathOverlay(): Promise<ErrandTargetInfo | null>;
  /**
   * Runs the actions in order, moving the overlay cursor to each action's point first. `beforeAction` is asked before
   * every action and may halt the batch. Never call this while an approval is pending.
   */
  runActions(
    actions: ComputerAction[],
    beforeAction: (action: ComputerAction, index: number) => Promise<"proceed" | "halt">,
  ): Promise<{ ran: number; halted: boolean; error?: string }>;
}

const VIEWPORT = { width: 1280, height: 800 } as const;
/** The pause after an action batch so the page can react before the next screenshot. */
const ACTION_SETTLE_MS = 300;
const PROFILE_LOCKED_PATTERN =
  /user data directory is already in use|processsingleton|existing browser session|profile.{0,40}(in use|locked)/iu;
const CHROME_MISSING_PATTERN = /executable doesn't exist|distribution '?chrome'? is not found|chromium distribution/iu;

/**
 * Only web pages (and a blank page that is about to load one) become the page an errand looks at and acts on;
 * extension pages (a password manager's popup, say) and browser-internal pages never do.
 */
export function isErrandFollowablePageUrl(url: string): boolean {
  return url === "" || url === "about:blank" || /^https?:\/\//iu.test(url);
}

export async function launchErrandBrowser(options: ErrandBrowserLaunchOptions): Promise<ErrandBrowser> {
  if (options.signal?.aborted) {
    throw new ErrandBrowserLaunchError("launch_failed", "The errand browser launch was aborted.");
  }
  const playwright = await loadPlaywright<typeof import("playwright")>();

  const releaseLock = acquireProfileLock(options.profileDir);
  // The proxy lives as long as the browser, which outlives the errand that launched it (the next errand reuses the
  // window). The launch signal only aborts a launch still in progress; once launched, close() ends the proxy.
  const proxyLifetime = new AbortController();
  const abortLaunch = (): void => proxyLifetime.abort();
  options.signal?.addEventListener("abort", abortLaunch, { once: true });
  let egress: BrowserEgressProxy | undefined;
  let context: BrowserContext | undefined;
  try {
    egress = await startBrowserEgressProxy({
      allowlist: options.networkAllowlist,
      signal: proxyLifetime.signal,
    });
    const { proxy, serviceWorkers } = buildPlaywrightContextOptions({}, undefined, egress.serverUrl);
    context = await playwright.chromium.launchPersistentContext(options.profileDir, {
      channel: options.channel,
      headless: options.headless ?? false,
      viewport: { ...VIEWPORT },
      deviceScaleFactor: 1,
      args: [...BROWSER_CHROMIUM_SECURITY_ARGS],
      proxy,
      serviceWorkers,
    });
    await installBrowserRequestGuards(context, [options.networkAllowlist]);
    const firstPage = context.pages()[0] ?? (await context.newPage());
    const browser = await createErrandBrowser(context, firstPage, egress, releaseLock);
    if (proxyLifetime.signal.aborted) {
      throw new ErrandBrowserLaunchError("launch_failed", "The errand browser launch was aborted.");
    }
    return browser;
  } catch (error) {
    await context?.close().catch(() => undefined);
    await egress?.close().catch(() => undefined);
    releaseLock();
    throw classifyLaunchError(error, options.channel);
  } finally {
    options.signal?.removeEventListener("abort", abortLaunch);
  }
}

const PROFILE_LOCK_FILE = ".goatcitadel-errand.lock";
const LOCK_HEARTBEAT_MS = 3_000;
const LOCK_STALE_AFTER_MS = 15_000;

interface ProfileLockRecord {
  pid: number;
  token: string;
}

/**
 * Chrome only guards a profile while a headed process holds it, and the bundled headless shell does not guard it at
 * all, so the launcher keeps its own lock beside the profile. The lock names the owner's pid and a random token, and
 * the owner touches the file while it lives. A lock is live only when its pid exists AND it was touched recently, so a
 * recycled pid after a crash or reboot never keeps a dead lock alive. Anything unconfirmed is treated as stale.
 */
function acquireProfileLock(profileDir: string): () => void {
  fs.mkdirSync(profileDir, { recursive: true });
  const lockPath = path.join(profileDir, PROFILE_LOCK_FILE);
  const record: ProfileLockRecord = { pid: process.pid, token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(record), { flag: "wx" });
      const heartbeat = setInterval(() => {
        try {
          const now = new Date();
          fs.utimesSync(lockPath, now, now);
        } catch {
          // Ignore: the lock file is gone, so there is nothing left to refresh; stop the heartbeat.
          clearInterval(heartbeat);
        }
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        clearInterval(heartbeat);
        if (readLockRecord(lockPath)?.token === record.token) {
          fs.rmSync(lockPath, { force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ErrandBrowserLaunchError("launch_failed", "The errand browser profile could not be locked.", {
          cause: error,
        });
      }
      if (isLockHolderLive(lockPath)) {
        throw new ErrandBrowserLaunchError(
          "profile_locked",
          "The errand browser profile is already open in another window. Close that window and try again.",
        );
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new ErrandBrowserLaunchError("profile_locked", "The errand browser profile is already open.");
}

function readLockRecord(lockPath: string): ProfileLockRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<ProfileLockRecord>;
    if (Number.isInteger(parsed.pid) && (parsed.pid as number) > 0 && typeof parsed.token === "string") {
      return { pid: parsed.pid as number, token: parsed.token };
    }
  } catch {
    // Fall back to stale: unreadable or malformed locks are treated as stale.
  }
  return undefined;
}

function isLockHolderLive(lockPath: string): boolean {
  const record = readLockRecord(lockPath);
  if (!record) {
    return false;
  }
  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_AFTER_MS) {
      return false;
    }
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function classifyLaunchError(error: unknown, channel: string | undefined): ErrandBrowserLaunchError {
  if (error instanceof ErrandBrowserLaunchError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (PROFILE_LOCKED_PATTERN.test(message)) {
    return new ErrandBrowserLaunchError(
      "profile_locked",
      "The errand browser profile is already open in another window. Close that window and try again.",
      { cause: error },
    );
  }
  if (isMissingPlaywrightBrowserError(error) || CHROME_MISSING_PATTERN.test(message)) {
    return new ErrandBrowserLaunchError(
      "chrome_missing",
      channel === "chrome"
        ? "Google Chrome was not found. Install Chrome, or use the bundled Chromium."
        : "The bundled Chromium is not installed.",
      { cause: error },
    );
  }
  return new ErrandBrowserLaunchError("launch_failed", `The errand browser failed to launch: ${message}`, {
    cause: error,
  });
}

async function createErrandBrowser(
  context: BrowserContext,
  firstPage: Page,
  egress: BrowserEgressProxy,
  releaseLock: () => void,
): Promise<ErrandBrowser> {
  let activePage = firstPage;
  const overlay = createErrandOverlay(() => activePage);
  let closed = false;
  const listeners = new Set<() => void>();

  const finalize = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    releaseLock();
    void egress.close().catch(() => undefined);
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Ignore a faulty listener (non-fatal) so the others and cleanup still run.
      }
    }
    listeners.clear();
  };

  context.on("close", finalize);
  context.on("page", (page) => {
    if (isErrandFollowablePageUrl(page.url())) {
      activePage = page;
    }
  });
  context.on("page", (page) => {
    watchPage(page);
    void overlay.attach(page).catch(() => undefined);
  });
  watchPage(firstPage);

  function watchPage(page: Page): void {
    page.on("close", () => onPageClosed(page));
    page.on("framenavigated", (frame) => {
      // A followed page that turns into an extension or browser page hands the errand back to a web page.
      if (frame === page.mainFrame() && activePage === page && !isErrandFollowablePageUrl(page.url())) {
        activePage = pickActivePage(page) ?? page;
      }
    });
  }

  /** The most recent open web page other than `excluded`, if any. */
  function pickActivePage(excluded: Page): Page | undefined {
    const open = context.pages().filter((candidate) => candidate !== excluded && !candidate.isClosed());
    return open.filter((candidate) => isErrandFollowablePageUrl(candidate.url())).at(-1);
  }

  function onPageClosed(page: Page): void {
    const remaining = context.pages().filter((candidate) => candidate !== page && !candidate.isClosed());
    if (remaining.length === 0) {
      // Closing the only page ends the errand session; the lock and proxy are released once the context is gone.
      void context.close().catch(() => undefined);
      return;
    }
    if (activePage === page) {
      activePage = pickActivePage(page) ?? remaining[remaining.length - 1]!;
    }
  }

  async function ensureWindowVisible(page: Page): Promise<void> {
    let session: CDPSession | undefined;
    try {
      session = await context.newCDPSession(page);
      const { windowId, bounds } = await session.send("Browser.getWindowForTarget");
      if (bounds.windowState === "minimized") {
        await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      }
      await page.bringToFront();
    } catch {
      // Best-effort: headless contexts have no real window; the screenshot below still works.
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }

  async function screenshot(): Promise<Buffer> {
    const page = activePage;
    await ensureWindowVisible(page);
    return page.screenshot({ type: "png" });
  }

  /** Moves the drawn cursor; purely cosmetic, so overlay failures never stop an action. */
  async function moveCursor(point: { x: number; y: number }): Promise<void> {
    try {
      const snapshot = await overlay.snapshot();
      if (snapshot.mode === "driving") {
        await overlay.render({ mode: "driving", bannerText: snapshot.bannerText ?? "", cursor: point });
      }
    } catch {
      // Best-effort, non-fatal: cursor drawing never blocks the errand.
    }
  }

  async function settle(
    ran: number,
    halted: boolean,
    error?: string,
  ): Promise<{ ran: number; halted: boolean; error?: string }> {
    await new Promise((resolve) => setTimeout(resolve, ACTION_SETTLE_MS));
    return error === undefined ? { ran, halted } : { ran, halted, error };
  }

  await overlay.attach(firstPage);

  return {
    overlay,
    describeTarget: (x, y) => describePointOverCdp(context, activePage, x, y),
    describeTargetBeneathOverlay: (x, y) =>
      overlay
        .withOverlayHidden((page) => describePointOverCdp(context, page, x, y))
        // Fallback: an overlay that cannot be hidden leaves the target unknown, which callers never treat as safe.
        .catch(() => null),
    describeFocused: () => describeFocusedOverCdp(context, activePage),
    describeFocusedBeneathOverlay: () =>
      overlay
        .withOverlayHidden((page) => describeFocusedOverCdp(context, page))
        // Fallback: an overlay that cannot be hidden leaves the focused element unknown, which callers never treat as safe.
        .catch(() => null),
    async runActions(actions, beforeAction) {
      let ran = 0;
      for (const [index, action] of actions.entries()) {
        if ((await beforeAction(action, index)) === "halt") {
          return await settle(ran, true);
        }
        const point = pointOf(action);
        if (point) {
          await moveCursor(point);
        }
        // Every mouse and keyboard action goes through the overlay's automation guard so Esc and the overlay's own
        // controls never mistake it for the operator.
        try {
          await overlay.withAutomationInput(() => dispatchComputerAction(activePage, action));
        } catch (error) {
          const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0]?.trim() ?? "";
          return await settle(ran, false, `action ${index + 1} (${action.type}) failed: ${detail}`);
        }
        ran += 1;
      }
      return await settle(ran, false);
    },
    page: () => activePage,
    currentUrl: () => (activePage.isClosed() ? "" : activePage.url()),
    async captureForModel() {
      // The overlay is hidden on, and the screenshot taken of, the same page, even if another tab opens meanwhile.
      return overlay.withOverlayHidden(async (page) => {
        await ensureWindowVisible(page);
        return page.screenshot({ type: "png" });
      });
    },
    captureForPeople: () => screenshot(),
    isClosed: () => closed,
    onClosed(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      await context.close().catch(() => undefined);
      finalize();
    },
  };
}
