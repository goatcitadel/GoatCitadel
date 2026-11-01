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
  /** A PNG of the page for the model. The errand overlay is hidden for this capture (wired in a later task). */
  captureForModel(): Promise<Buffer>;
  /** A PNG of the page as the operator sees it. */
  captureForPeople(): Promise<Buffer>;
  isClosed(): boolean;
  /** Registers a listener for the browser going away; returns an unsubscribe function. */
  onClosed(listener: () => void): () => void;
  close(): Promise<void>;
}

const VIEWPORT = { width: 1280, height: 800 } as const;
const PROFILE_LOCKED_PATTERN =
  /user data directory is already in use|processsingleton|existing browser session|profile.{0,40}(in use|locked)/iu;
const CHROME_MISSING_PATTERN = /executable doesn't exist|distribution '?chrome'? is not found|chromium distribution/iu;

export async function launchErrandBrowser(options: ErrandBrowserLaunchOptions): Promise<ErrandBrowser> {
  if (options.signal?.aborted) {
    throw new ErrandBrowserLaunchError("launch_failed", "The errand browser launch was aborted.");
  }
  const playwright = await loadPlaywright<typeof import("playwright")>();

  const releaseLock = acquireProfileLock(options.profileDir);
  let egress: BrowserEgressProxy | undefined;
  let context: BrowserContext | undefined;
  try {
    egress = await startBrowserEgressProxy({
      allowlist: options.networkAllowlist,
      signal: options.signal,
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
    return createErrandBrowser(context, firstPage, egress, releaseLock);
  } catch (error) {
    await context?.close().catch(() => undefined);
    await egress?.close().catch(() => undefined);
    releaseLock();
    throw classifyLaunchError(error, options.channel);
  }
}

const PROFILE_LOCK_FILE = ".goatcitadel-errand.lock";

/**
 * Chrome only guards a profile while a headed process holds it, and the bundled headless shell does not guard it at
 * all, so the launcher keeps its own pid lock beside the profile. A lock whose process is gone is stale and reclaimed.
 */
function acquireProfileLock(profileDir: string): () => void {
  fs.mkdirSync(profileDir, { recursive: true });
  const lockPath = path.join(profileDir, PROFILE_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      let released = false;
      return () => {
        if (!released) {
          released = true;
          fs.rmSync(lockPath, { force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ErrandBrowserLaunchError("launch_failed", "The errand browser profile could not be locked.", {
          cause: error,
        });
      }
      if (isLockHolderAlive(lockPath)) {
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

function isLockHolderAlive(lockPath: string): boolean {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    process.kill(pid, 0);
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

function createErrandBrowser(
  context: BrowserContext,
  firstPage: Page,
  egress: BrowserEgressProxy,
  releaseLock: () => void,
): ErrandBrowser {
  let activePage = firstPage;
  let closed = false;
  const listeners = new Set<() => void>();

  const markClosed = (): void => {
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
        // A faulty listener must not stop the others or the teardown.
      }
    }
    listeners.clear();
  };

  context.on("close", markClosed);
  context.on("page", (page) => {
    activePage = page;
  });
  context.on("page", (page) => {
    page.on("close", () => onPageClosed(page));
  });
  firstPage.on("close", () => onPageClosed(firstPage));

  function onPageClosed(page: Page): void {
    const remaining = context.pages().filter((candidate) => candidate !== page && !candidate.isClosed());
    if (remaining.length === 0) {
      // Closing the only page ends the errand session.
      markClosed();
      void context.close().catch(() => undefined);
      return;
    }
    if (activePage === page) {
      activePage = remaining[remaining.length - 1]!;
    }
  }

  async function ensureWindowVisible(): Promise<void> {
    let session: CDPSession | undefined;
    try {
      session = await context.newCDPSession(activePage);
      const { windowId, bounds } = await session.send("Browser.getWindowForTarget");
      if (bounds.windowState === "minimized") {
        await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      }
      await activePage.bringToFront();
    } catch {
      // Headless contexts have no real window; the screenshot below still works.
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }

  async function screenshot(): Promise<Buffer> {
    await ensureWindowVisible();
    return activePage.screenshot({ type: "png" });
  }

  return {
    page: () => activePage,
    currentUrl: () => (activePage.isClosed() ? "" : activePage.url()),
    async captureForModel() {
      // Hook point: the errand overlay is hidden here before the capture and restored after it (wired in Task 2).
      return screenshot();
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
      markClosed();
      await context.close().catch(() => undefined);
    },
  };
}
