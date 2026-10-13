import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { launchPlaywrightChromium, loadPlaywright } from "./playwright-runtime.js";
import { assertWritePathInJail } from "./sandbox/path-jail.js";

/**
 * Offline, script-free snapshot rendering for HTML artifacts. The page never reaches the network:
 * JavaScript is disabled, the context is offline, every non-`data:`/`about:` request is aborted,
 * and the gateway's baseline Content Security Policy is injected as a meta tag. Output lands only
 * inside the caller's write jail.
 */

export const HTML_RENDER_MAX_BYTES = 512 * 1024;
export const HTML_RENDER_DEFAULT_TIMEOUT_MS = 15_000;

/** The gateway's baseline CSP (see apps/gateway/src/app.ts), with `data:` fonts allowed for rendered artifacts (D4). */
export const MISSION_CONTROL_BASELINE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export interface HtmlRenderViewport {
  name: string;
  width: number;
  height: number;
}

export const HTML_RENDER_DEFAULT_VIEWPORTS: readonly HtmlRenderViewport[] = Object.freeze([
  Object.freeze({ name: "desktop", width: 1440, height: 900 }),
  Object.freeze({ name: "phone", width: 390, height: 844 }),
]);

export interface HtmlRenderRecord {
  viewport: string;
  width: number;
  height: number;
  path: string;
  sha256: string;
  bytes: number;
  title: string;
  blockedRequests: string[];
}

export interface HtmlRenderResult {
  renders: HtmlRenderRecord[];
  contentSecurityPolicy: string;
}

export interface RenderHtmlSnapshotOptions {
  html: string;
  outputDir: string;
  writeJailRoots: string[];
  viewports?: readonly HtmlRenderViewport[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

type RenderRoute = {
  request: () => { url: () => string };
  continue: () => Promise<void>;
  abort: (errorCode?: string) => Promise<void>;
};

type RenderPage = {
  on: (event: "requestfailed", handler: (request: { url: () => string }) => void) => unknown;
  setDefaultTimeout?: (timeoutMs: number) => void;
  setContent: (html: string, options?: { waitUntil?: "load" | "domcontentloaded"; timeout?: number }) => Promise<void>;
  title: () => Promise<string>;
  screenshot: (options: { path: string; fullPage: boolean; type: "png" }) => Promise<unknown>;
};

type RenderContext = {
  route: (url: string | RegExp, handler: (route: RenderRoute) => Promise<void> | void) => Promise<void>;
  newPage: () => Promise<RenderPage>;
  close: () => Promise<void>;
};

type RenderBrowser = {
  newContext: (options: {
    javaScriptEnabled: boolean;
    offline: boolean;
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    serviceWorkers: "block";
  }) => Promise<RenderContext>;
  close: () => Promise<void>;
};

type RenderPlaywrightModule = {
  chromium: { launch: (options: { headless: boolean; args?: string[] }) => Promise<RenderBrowser> };
};

// `frame-ancestors` is ignored (with a console warning) when delivered through a meta tag.
const META_CSP = MISSION_CONTROL_BASELINE_CSP.replace(/;\s*frame-ancestors[^;]*/, "");
const CSP_META_TAG = `<meta http-equiv="Content-Security-Policy" content="${META_CSP}">`;
const ALLOWED_REQUEST_SCHEMES = new Set(["data:", "about:"]);

export async function renderHtmlSnapshot(options: RenderHtmlSnapshotOptions): Promise<HtmlRenderResult> {
  const { html, outputDir, writeJailRoots, signal } = options;
  const viewports = options.viewports ?? HTML_RENDER_DEFAULT_VIEWPORTS;
  const timeoutMs = options.timeoutMs ?? HTML_RENDER_DEFAULT_TIMEOUT_MS;

  assertWritePathInJail(outputDir, writeJailRoots);
  assertHtmlWithinRenderCap(html);
  throwIfRenderAborted(signal);

  const document = injectContentSecurityPolicy(html);
  const playwright = await loadPlaywright<RenderPlaywrightModule>();
  throwIfRenderAborted(signal);
  const browser = await launchPlaywrightChromium(playwright, true);
  try {
    await mkdir(outputDir, { recursive: true });
    const renders: HtmlRenderRecord[] = [];
    for (const viewport of viewports) {
      throwIfRenderAborted(signal);
      renders.push(await renderViewport({ browser, document, outputDir, viewport, timeoutMs }));
    }
    return { renders, contentSecurityPolicy: MISSION_CONTROL_BASELINE_CSP };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function renderViewport(input: {
  browser: RenderBrowser;
  document: string;
  outputDir: string;
  viewport: HtmlRenderViewport;
  timeoutMs: number;
}): Promise<HtmlRenderRecord> {
  const { browser, document, outputDir, viewport, timeoutMs } = input;
  const blockedRequests: string[] = [];
  const context = await browser.newContext({
    javaScriptEnabled: false,
    offline: true,
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
  });
  try {
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (isAllowedRenderRequest(url)) {
        await route.continue();
        return;
      }
      blockedRequests.push(url);
      await route.abort("blockedbyclient").catch(() => undefined);
    });
    const page = await context.newPage();
    // The injected CSP refuses most loads before the route layer sees them; the refusal
    // still surfaces as a failed request, so both layers are recorded here.
    page.on("requestfailed", (request) => {
      blockedRequests.push(request.url());
    });
    page.setDefaultTimeout?.(timeoutMs);
    await page.setContent(document, { waitUntil: "load", timeout: timeoutMs });
    const title = await page.title();
    const filePath = path.join(outputDir, `render-${sanitizeViewportName(viewport.name)}.png`);
    await page.screenshot({ path: filePath, fullPage: false, type: "png" });
    const bytes = await readFile(filePath);
    return {
      viewport: viewport.name,
      width: viewport.width,
      height: viewport.height,
      path: filePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      title,
      blockedRequests: [...new Set(blockedRequests)],
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

function assertHtmlWithinRenderCap(html: string): void {
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > HTML_RENDER_MAX_BYTES) {
    throw new Error(
      `html_render_too_large: the HTML is ${bytes} bytes; the render limit is ${HTML_RENDER_MAX_BYTES} bytes.`,
    );
  }
}

function throwIfRenderAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("The HTML render was aborted.");
    error.name = "AbortError";
    throw error;
  }
}

function isAllowedRenderRequest(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(url)?.[1]?.toLowerCase();
  return scheme !== undefined && ALLOWED_REQUEST_SCHEMES.has(scheme);
}

function sanitizeViewportName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "viewport";
}

/** Insert the CSP meta tag as the first child of `<head>`; synthesize a head when the document has none. */
export function injectContentSecurityPolicy(html: string): string {
  const headEnd = findTagEnd(html, "head");
  if (headEnd !== undefined) {
    return `${html.slice(0, headEnd)}${CSP_META_TAG}${html.slice(headEnd)}`;
  }
  const htmlEnd = findTagEnd(html, "html");
  if (htmlEnd !== undefined) {
    return `${html.slice(0, htmlEnd)}<head>${CSP_META_TAG}</head>${html.slice(htmlEnd)}`;
  }
  return `<head>${CSP_META_TAG}</head>${html}`;
}

/**
 * Offset just past the first real `<tag ...>` start tag. Comments are consumed by the same scan,
 * so a `<head>` or `<html>` that only appears inside `<!-- ... -->` never counts.
 */
function findTagEnd(html: string, tag: "head" | "html"): number | undefined {
  const scanner = new RegExp(`<!--[\\s\\S]*?(?:-->|$)|<${tag}(?:\\s[^>]*)?>`, "gi");
  for (let match = scanner.exec(html); match; match = scanner.exec(html)) {
    if (!match[0].startsWith("<!--")) {
      return match.index + match[0].length;
    }
  }
  return undefined;
}
