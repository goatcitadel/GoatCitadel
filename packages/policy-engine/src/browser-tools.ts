/* eslint-disable max-lines */
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { clampInt } from "@goatcitadel/contracts";
import { stripHtmlNoiseTags, stripHtmlTags } from "./html-noise.js";
import { assertHostAllowed, assertNotPrivateOrReservedHost, fetchAllowlisted } from "./sandbox/network-guard.js";
import { assertWritePathInJail } from "./sandbox/path-jail.js";
import { normalizeFirecrawlApiKeyEnvName } from "./safe-env-name.js";

type BrowserToolName =
  | "browser.search"
  | "browser.navigate"
  | "browser.extract"
  | "browser.screenshot"
  | "browser.interact"
  | "browser.cookies.get"
  | "browser.cookies.set"
  | "browser.cookies.clear"
  | "browser.storage.get"
  | "browser.storage.set"
  | "browser.storage.clear"
  | "browser.context.configure";

export interface BrowserExecutionContext {
  sessionId?: string;
  signal?: AbortSignal;
  matchedGrantAllowedHosts?: string[];
}

interface BrowserStepInput {
  action: "click" | "type" | "press" | "wait_for_selector" | "wait";
  selector?: string;
  text?: string;
  key?: string;
  timeoutMs?: number;
}

function shouldEnforceNetworkAllowlist(config: ToolPolicyConfig): boolean {
  void config;
  return true;
}

function assertHostAllowedForConfig(
  hostOrUrl: string,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): void {
  void shouldEnforceNetworkAllowlist(config);
  assertHostAllowed(hostOrUrl, config.sandbox.networkAllowlist);
  const grantAllowlist = executionContext?.matchedGrantAllowedHosts?.map((entry) => entry.trim()).filter(Boolean);
  if (grantAllowlist && grantAllowlist.length > 0) {
    assertHostAllowed(hostOrUrl, grantAllowlist);
  }
}

function getGrantHostAllowlist(executionContext?: BrowserExecutionContext): string[] {
  return executionContext?.matchedGrantAllowedHosts?.map((entry) => entry.trim()).filter(Boolean) ?? [];
}

function hasGrantHostConstraints(executionContext?: BrowserExecutionContext): boolean {
  return getGrantHostAllowlist(executionContext).length > 0;
}

function assertHostAllowedForGrant(hostOrUrl: string, executionContext?: BrowserExecutionContext): void {
  const grantAllowlist = getGrantHostAllowlist(executionContext);
  if (grantAllowlist.length > 0) {
    assertHostAllowed(hostOrUrl, grantAllowlist);
  }
}

function isHostAllowedForGrant(hostOrUrl: string, executionContext?: BrowserExecutionContext): boolean {
  try {
    assertHostAllowedForGrant(hostOrUrl, executionContext);
    return true;
  } catch {
    return false;
  }
}

type BrowserCookieRecord = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  url?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "None" | "Strict";
};

type BrowserStorageBucket = Record<string, Record<string, string>>;

type BrowserSessionState = {
  cookies: BrowserCookieRecord[];
  localStorage: BrowserStorageBucket;
  sessionStorage: BrowserStorageBucket;
  locale?: string;
  timezoneId?: string;
  geolocation?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
  extraHTTPHeaders?: Record<string, string>;
  httpCredentials?: {
    username: string;
    password: string;
  };
  updatedAt: number;
};

let playwrightChromiumInstallPromise: Promise<void> | null = null;
const browserSessionStates = new Map<string, { state: BrowserSessionState; lastAccess: number }>();
const MAX_BROWSER_SESSION_STATES = 128;

export function isBrowserToolName(name: string): name is BrowserToolName {
  return (
    name === "browser.search" ||
    name === "browser.navigate" ||
    name === "browser.extract" ||
    name === "browser.screenshot" ||
    name === "browser.interact" ||
    name === "browser.cookies.get" ||
    name === "browser.cookies.set" ||
    name === "browser.cookies.clear" ||
    name === "browser.storage.get" ||
    name === "browser.storage.set" ||
    name === "browser.storage.clear" ||
    name === "browser.context.configure"
  );
}

export async function executeBrowserTool(
  toolName: BrowserToolName,
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  if (toolName === "browser.search") {
    return executeBrowserSearch(args, config, executionContext);
  }
  if (toolName === "browser.navigate") {
    return executeBrowserNavigate(args, config, executionContext);
  }
  if (toolName === "browser.extract") {
    return executeBrowserExtract(args, config, executionContext);
  }
  if (toolName === "browser.screenshot") {
    return executeBrowserScreenshot(args, config, executionContext);
  }
  if (toolName === "browser.interact") {
    return executeBrowserInteract(args, config, executionContext);
  }
  if (toolName === "browser.cookies.get") {
    return executeBrowserCookiesGet(args, config, executionContext);
  }
  if (toolName === "browser.cookies.set") {
    return executeBrowserCookiesSet(args, config, executionContext);
  }
  if (toolName === "browser.cookies.clear") {
    return executeBrowserCookiesClear(args, executionContext);
  }
  if (toolName === "browser.storage.get") {
    return executeBrowserStorageGet(args, executionContext);
  }
  if (toolName === "browser.storage.set") {
    return executeBrowserStorageSet(args, config, executionContext);
  }
  if (toolName === "browser.storage.clear") {
    return executeBrowserStorageClear(args, executionContext);
  }
  return executeBrowserContextConfigure(args, executionContext);
}

async function executeBrowserSearch(
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  const query = asNonEmptyString(args.query, "query");
  const requestedEngine = normalizeSearchEngine(asString(args.engine)) ?? "auto";
  const requestedBackend = normalizeSearchBackend(asString(args.backend));
  const requestedReadBackend = requestedBackend === "firecrawl" ? "firecrawl" : "native";
  const limit = clampInt(args.limit ?? args.maxResults, 5, 1, 25);
  if (requestedReadBackend === "firecrawl") {
    try {
      const firecrawl = await executeBrowserSearchViaFirecrawl(query, limit, args, config, executionContext);
      return {
        ...firecrawl,
        action: "search",
        requestedEngine,
        attemptedEngines: ["firecrawl"],
        backend: "firecrawl",
        backendUsed: true,
        fallbackUsed: false,
      };
    } catch (firecrawlError) {
      if (!asBoolean(args.firecrawlFallbackToNative, true)) {
        throw firecrawlError;
      }
      const nativeResult = await executeBrowserSearchNative(
        query,
        requestedEngine,
        requestedBackend === "ollama" ? "ollama" : undefined,
        limit,
        args,
        config,
        executionContext,
      );
      return {
        ...nativeResult,
        backend: "firecrawl",
        backendUsed: false,
        fallbackUsed: true,
        fallbackReason: (firecrawlError as Error).message,
      };
    }
  }

  const nativeResult = await executeBrowserSearchNative(
    query,
    requestedEngine,
    requestedBackend === "ollama" ? "ollama" : undefined,
    limit,
    args,
    config,
    executionContext,
  );
  return {
    ...nativeResult,
    backend: "native",
    backendUsed: true,
  };
}

async function executeBrowserSearchNative(
  query: string,
  requestedEngine: "auto" | "duckduckgo" | "bing" | "google",
  requestedBackend: "ollama" | undefined,
  limit: number,
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  const attemptedEngines: string[] = [];
  const failures: string[] = [];

  for (const engine of resolveSearchEngineCandidates(requestedEngine)) {
    attemptedEngines.push(engine);
    const searchUrl = buildSearchUrl(engine, query);
    const searchBackendContext = browserSearchBackendExecutionContext(executionContext);
    try {
      const snapshot = await withBrowserPage(searchUrl, args, config, searchBackendContext, async (page) => {
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(400);
        const rawResults = await page.evaluate(
          (maxItems: number) => {
            const out: Array<{ href: string; title: string; snippet: string }> = [];
            const seen = new Set<string>();
            const searchRootSelectors = [
              "main",
              "[role='main']",
              "#b_results",
              "#links",
              "#search",
              ".results",
              ".results_links",
            ];
            const scopedAnchors: HTMLAnchorElement[] = [];
            for (const selector of searchRootSelectors) {
              const root = document.querySelector(selector);
              if (!root) {
                continue;
              }
              const anchors = Array.from(root.querySelectorAll("a[href]")) as HTMLAnchorElement[];
              if (anchors.length > 0) {
                scopedAnchors.push(...anchors);
              }
            }
            const anchors =
              scopedAnchors.length > 0
                ? scopedAnchors
                : (Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[]);
            for (const anchor of anchors) {
              if (out.length >= maxItems) {
                break;
              }
              const href = anchor.getAttribute("href") ?? "";
              const normalizedHref = href.trim().toLowerCase();
              if (
                !href ||
                href.startsWith("#") ||
                normalizedHref.startsWith("javascript:") ||
                normalizedHref.startsWith("data:") ||
                normalizedHref.startsWith("vbscript:")
              ) {
                continue;
              }
              if (seen.has(href)) {
                continue;
              }
              const title = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
              if (!title) {
                continue;
              }
              const containerText = (anchor.closest("article, li, div")?.textContent ?? "").replace(/\s+/g, " ").trim();
              out.push({
                href: href.slice(0, 1200),
                title: title.slice(0, 240),
                snippet: containerText.slice(0, 420),
              });
              seen.add(href);
            }
            return out;
          },
          Math.max(limit * 20, 80),
        );
        const finalUrl = page.url();
        const filteredResults = filterLikelySearchResultCandidates(rawResults, finalUrl);
        const results = normalizeBrowserSearchResults(filteredResults, finalUrl, Math.max(limit * 20, 80));

        return {
          requestedEngine,
          engine,
          query,
          results,
        };
      });

      const normalizedSnapshot = {
        requestedEngine,
        engine,
        query,
        finalUrl: String(snapshot.finalUrl ?? searchUrl),
        results: filterBrowserSearchResultsForPolicy(
          snapshot.results as Array<{ title: string; url: string; snippet: string }>,
          config,
          executionContext,
          limit,
        ),
      };

      if (normalizedSnapshot.results.length) {
        const withBackend = await applySearchBackend(normalizedSnapshot, {
          args,
          config,
          requestedBackend,
          signal: executionContext?.signal,
        });
        return {
          ...withBackend,
          action: "search",
          attemptedEngines,
          fallbackUsed: false,
        };
      }

      failures.push(`${engine}: no usable results from browser page`);
    } catch (playwrightError) {
      failures.push(`${engine}: ${(playwrightError as Error).message}`);
    }

    try {
      const fallback = await executeBrowserSearchFallback(
        query,
        Math.max(limit * 20, 80),
        config,
        engine,
        searchBackendContext,
        executionContext?.signal,
      );
      const fallbackResults = filterBrowserSearchResultsForPolicy(fallback.results, config, executionContext, limit);
      if (fallbackResults.length > 0) {
        const withBackend = await applySearchBackend(
          {
            requestedEngine,
            engine,
            query,
            finalUrl: fallback.finalUrl,
            results: fallbackResults,
          },
          {
            args,
            config,
            requestedBackend,
            signal: executionContext?.signal,
          },
        );
        return {
          ...withBackend,
          action: "search",
          requestedEngine,
          engine,
          query,
          attemptedEngines,
          fallbackUsed: true,
          fallbackReason: failures.at(-1),
        };
      }
      failures.push(`${engine}: fallback returned no usable results`);
    } catch (fallbackError) {
      failures.push(`${engine}: ${(fallbackError as Error).message}`);
    }
  }

  throw new Error(`browser.search failed: ${failures.join(" | ")}`);
}

function browserSearchBackendExecutionContext(
  executionContext?: BrowserExecutionContext,
): BrowserExecutionContext | undefined {
  if (!executionContext) {
    return undefined;
  }
  return {
    sessionId: executionContext.sessionId,
    signal: executionContext.signal,
  };
}

async function executeBrowserNavigate(
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  const url = asNonEmptyString(args.url, "url");
  const maxChars = clampInt(args.maxChars, 6000, 200, 20000);
  const backend = normalizeBrowserReadBackend(asString(args.backend));
  if (backend === "firecrawl") {
    try {
      const firecrawl = await executeBrowserNavigateViaFirecrawl(
        url,
        maxChars,
        args,
        config,
        executionContext,
        executionContext?.signal,
      );
      return {
        ...firecrawl,
        action: "navigate",
        backend: "firecrawl",
        backendUsed: true,
        fallbackUsed: false,
      };
    } catch (firecrawlError) {
      if (!asBoolean(args.firecrawlFallbackToNative, true)) {
        throw firecrawlError;
      }
      const fallback = await executeBrowserNavigateNative(url, maxChars, args, config, executionContext);
      return {
        ...fallback,
        backend: "firecrawl",
        backendUsed: false,
        fallbackUsed: true,
        fallbackReason: (firecrawlError as Error).message,
      };
    }
  }

  const nativeResult = await executeBrowserNavigateNative(url, maxChars, args, config, executionContext);
  return {
    ...nativeResult,
    backend: "native",
    backendUsed: true,
  };
}

async function executeBrowserNavigateNative(
  url: string,
  maxChars: number,
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  try {
    return await withBrowserPage(url, args, config, executionContext, async (page, responseStatus) => {
      const title = await page.title();
      const domWeather = await extractWeatherSnapshot(page, title);
      let visualTextSnippet: string | undefined;
      const visualWeather = domWeather ? undefined : await extractWeatherSnapshotFromVisualTree(page, title, maxChars);
      if (visualWeather) {
        visualTextSnippet = visualWeather.visualTextSnippet;
      }
      const weather = domWeather ?? visualWeather?.weather;
      const bodyText = await extractText(page, "body", maxChars);
      const textSnippet = weather ? `${weather.summary}\n\n${bodyText}`.slice(0, maxChars) : bodyText;
      return {
        action: "navigate",
        title,
        status: responseStatus,
        textSnippet,
        weather,
        extractionMode: domWeather ? "dom" : visualWeather ? "visual" : "text",
        visualTextSnippet,
        fallbackUsed: false,
      };
    });
  } catch (playwrightError) {
    const fallback = await executeBrowserNavigateFallback(
      url,
      maxChars,
      config,
      executionContext,
      executionContext?.signal,
    );
    return {
      ...fallback,
      action: "navigate",
      fallbackUsed: true,
      fallbackReason: (playwrightError as Error).message,
    };
  }
}

async function executeBrowserExtract(
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  const url = asNonEmptyString(args.url, "url");
  const selector = asNonEmptyString(args.selector, "selector");
  const maxChars = clampInt(args.maxChars, 12000, 200, 50000);
  const backend = normalizeBrowserReadBackend(asString(args.backend));
  if (backend === "firecrawl") {
    try {
      const firecrawl = await executeBrowserExtractViaFirecrawl(
        url,
        selector,
        maxChars,
        args,
        config,
        executionContext,
        executionContext?.signal,
      );
      return {
        ...firecrawl,
        action: "extract",
        backend: "firecrawl",
        backendUsed: true,
        fallbackUsed: false,
      };
    } catch (firecrawlError) {
      if (!asBoolean(args.firecrawlFallbackToNative, true)) {
        throw firecrawlError;
      }
      const fallback = await executeBrowserExtractNative(url, selector, maxChars, args, config, executionContext);
      return {
        ...fallback,
        backend: "firecrawl",
        backendUsed: false,
        fallbackUsed: true,
        fallbackReason: (firecrawlError as Error).message,
      };
    }
  }

  const nativeResult = await executeBrowserExtractNative(url, selector, maxChars, args, config, executionContext);
  return {
    ...nativeResult,
    backend: "native",
    backendUsed: true,
  };
}

async function executeBrowserExtractNative(
  url: string,
  selector: string,
  maxChars: number,
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  try {
    return await withBrowserPage(url, args, config, executionContext, async (page, responseStatus) => {
      const title = await page.title();
      const domWeather = await extractWeatherSnapshot(page, title);
      let visualTextSnippet: string | undefined;
      const visualWeather = domWeather ? undefined : await extractWeatherSnapshotFromVisualTree(page, title, maxChars);
      if (visualWeather) {
        visualTextSnippet = visualWeather.visualTextSnippet;
      }
      const weather = domWeather ?? visualWeather?.weather;
      const extracted = await extractText(page, selector, maxChars);
      return {
        action: "extract",
        title,
        selector,
        status: responseStatus,
        text: extracted,
        weather,
        extractionMode: domWeather ? "dom" : visualWeather ? "visual" : "text",
        visualTextSnippet,
        fallbackUsed: false,
      };
    });
  } catch (playwrightError) {
    const fallback = await executeBrowserExtractFallback(
      url,
      selector,
      maxChars,
      config,
      executionContext,
      executionContext?.signal,
    );
    return {
      ...fallback,
      action: "extract",
      fallbackUsed: true,
      fallbackReason: (playwrightError as Error).message,
    };
  }
}

async function executeBrowserScreenshot(
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  const url = asNonEmptyString(args.url, "url");
  const outputPath =
    asString(args.outputPath) ?? asString(args.path) ?? `workspace/artifacts/browser-shot-${Date.now()}.png`;
  assertWritePathInJail(outputPath, config.sandbox.writeJailRoots);

  return withBrowserPage(url, args, config, executionContext, async (page, responseStatus, finalUrl) => {
    const resolvedPath = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    const fullPage = asBoolean(args.fullPage, true);
    await page.screenshot({
      path: resolvedPath,
      fullPage,
    });
    const title = await page.title();
    return {
      action: "screenshot",
      title,
      status: responseStatus,
      finalUrl,
      outputPath: resolvedPath,
      fullPage,
    };
  });
}

async function executeBrowserInteract(
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  const url = asNonEmptyString(args.url, "url");
  const rawSteps = Array.isArray(args.steps) ? args.steps : [];
  if (rawSteps.length === 0) {
    throw new Error("browser.interact requires a non-empty steps array");
  }

  const steps = rawSteps.map(parseStep);
  const finalSelector = asString(args.finalSelector) ?? "body";
  const maxChars = clampInt(args.maxChars, 6000, 200, 30000);
  const outputPath = asString(args.outputPath) ?? asString(args.path);
  if (outputPath) {
    assertWritePathInJail(outputPath, config.sandbox.writeJailRoots);
  }

  return withBrowserPage(url, args, config, executionContext, async (page, responseStatus, finalUrl) => {
    for (const step of steps) {
      const timeout = clampInt(step.timeoutMs, 12000, 500, 60000);
      if (step.action === "click") {
        const selector = ensureSelector(step.selector, "click");
        await page.locator(selector).first().click({ timeout });
        continue;
      }
      if (step.action === "type") {
        const selector = ensureSelector(step.selector, "type");
        const text = asNonEmptyString(step.text, "type.text");
        await page.locator(selector).first().fill(text, { timeout });
        continue;
      }
      if (step.action === "press") {
        const key = asString(step.key) ?? "Enter";
        if (step.selector) {
          await page.locator(step.selector).first().press(key, { timeout });
        } else {
          await page.keyboard.press(key);
        }
        continue;
      }
      if (step.action === "wait_for_selector") {
        const selector = ensureSelector(step.selector, "wait_for_selector");
        await page.waitForSelector(selector, { timeout });
        continue;
      }
      if (step.action === "wait") {
        await page.waitForTimeout(clampInt(step.timeoutMs, 1000, 100, 30000));
        continue;
      }
    }

    const title = await page.title();
    const text = await extractText(page, finalSelector, maxChars);
    let savedPath: string | undefined;
    if (outputPath) {
      const resolvedPath = path.resolve(outputPath);
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await page.screenshot({
        path: resolvedPath,
        fullPage: asBoolean(args.fullPage, true),
      });
      savedPath = resolvedPath;
    }

    return {
      action: "interact",
      title,
      status: responseStatus,
      finalUrl,
      finalSelector,
      textSnippet: text,
      screenshotPath: savedPath,
      stepsExecuted: steps.length,
    };
  });
}

async function executeBrowserCookiesGet(
  args: Record<string, unknown>,
  _config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  const browserSessionId = requireBrowserSessionId(args, executionContext, "browser.cookies.get");
  const state = cloneBrowserSessionState(getBrowserSessionState(browserSessionId));
  const filter = buildBrowserCookieFilter(args);
  assertBrowserCookieFilterAllowedForGrant(filter, executionContext);
  const cookies = state.cookies.filter(
    (cookie) => browserCookieMatchesFilter(cookie, filter) && browserCookieAllowedByGrant(cookie, executionContext),
  );
  return {
    action: "cookies.get",
    browserSessionId,
    count: cookies.length,
    cookies,
  };
}

async function executeBrowserCookiesSet(
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  const browserSessionId = requireBrowserSessionId(args, executionContext, "browser.cookies.set");
  const rawCookies = Array.isArray(args.cookies) ? args.cookies : [args];
  if (rawCookies.length === 0) {
    throw new Error("browser.cookies.set requires a cookie object or cookies array");
  }

  const state = cloneBrowserSessionState(getBrowserSessionState(browserSessionId));
  const normalizedCookies = rawCookies.map((cookie, index) =>
    normalizeBrowserCookieRecord(cookie, config, `cookies[${index}]`, executionContext),
  );

  for (const cookie of normalizedCookies) {
    const cookieKey = buildBrowserCookieKey(cookie);
    state.cookies = state.cookies.filter((existing) => buildBrowserCookieKey(existing) !== cookieKey);
    state.cookies.push(cookie);
  }

  storeBrowserSessionState(browserSessionId, state);
  return {
    action: "cookies.set",
    browserSessionId,
    count: normalizedCookies.length,
    cookies: normalizedCookies,
  };
}

async function executeBrowserCookiesClear(
  args: Record<string, unknown>,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  const browserSessionId = requireBrowserSessionId(args, executionContext, "browser.cookies.clear");
  const state = cloneBrowserSessionState(getBrowserSessionState(browserSessionId));
  const filter = buildBrowserCookieFilter(args);
  assertBrowserCookieFilterAllowedForGrant(filter, executionContext);
  const originalCount = state.cookies.length;
  state.cookies = state.cookies.filter((cookie) => {
    if (hasBrowserCookieFilter(filter) && !browserCookieMatchesFilter(cookie, filter)) {
      return true;
    }
    return !browserCookieAllowedByGrant(cookie, executionContext);
  });
  storeBrowserSessionState(browserSessionId, state);
  return {
    action: "cookies.clear",
    browserSessionId,
    removed: originalCount - state.cookies.length,
    remaining: state.cookies.length,
  };
}

async function executeBrowserStorageGet(
  args: Record<string, unknown>,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  const browserSessionId = requireBrowserSessionId(args, executionContext, "browser.storage.get");
  const state = cloneBrowserSessionState(getBrowserSessionState(browserSessionId));
  const storage = parseBrowserStorageKind(args.storage, "both", true);
  const origin = asString(args.origin);

  if (origin) {
    const normalizedOrigin = normalizeBrowserOrigin(origin);
    assertHostAllowedForGrant(normalizedOrigin, executionContext);
    return {
      action: "storage.get",
      browserSessionId,
      origin: normalizedOrigin,
      storage,
      localStorage: { ...(state.localStorage[normalizedOrigin] ?? {}) },
      sessionStorage: { ...(state.sessionStorage[normalizedOrigin] ?? {}) },
    };
  }

  return {
    action: "storage.get",
    browserSessionId,
    storage,
    localStorage: storage === "session" ? {} : filterBrowserStorageBucketByGrant(state.localStorage, executionContext),
    sessionStorage:
      storage === "local" ? {} : filterBrowserStorageBucketByGrant(state.sessionStorage, executionContext),
  };
}

async function executeBrowserStorageSet(
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  const browserSessionId = requireBrowserSessionId(args, executionContext, "browser.storage.set");
  const storage = parseBrowserStorageKind(args.storage, "local");
  const origin = normalizeBrowserOriginForConfig(asNonEmptyString(args.origin, "origin"), config, executionContext);
  const entries = normalizeBrowserStorageEntries(args);
  const state = cloneBrowserSessionState(getBrowserSessionState(browserSessionId));
  const bucket = storage === "session" ? state.sessionStorage : state.localStorage;
  const nextOriginState = {
    ...(bucket[origin] ?? {}),
    ...entries,
  };
  bucket[origin] = nextOriginState;
  storeBrowserSessionState(browserSessionId, state);
  return {
    action: "storage.set",
    browserSessionId,
    origin,
    storage,
    count: Object.keys(entries).length,
    entries: nextOriginState,
  };
}

async function executeBrowserStorageClear(
  args: Record<string, unknown>,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  const browserSessionId = requireBrowserSessionId(args, executionContext, "browser.storage.clear");
  const storage = parseBrowserStorageKind(args.storage, "both", true);
  const key = asString(args.key);
  const origin = asString(args.origin);
  if (key && !origin) {
    throw new Error("browser.storage.clear requires origin when key is provided");
  }

  const state = cloneBrowserSessionState(getBrowserSessionState(browserSessionId));
  const normalizedOrigin = origin ? normalizeBrowserOrigin(origin) : undefined;
  if (normalizedOrigin) {
    assertHostAllowedForGrant(normalizedOrigin, executionContext);
  }
  let removed = 0;

  for (const bucket of selectBrowserStorageBuckets(state, storage)) {
    if (normalizedOrigin) {
      removed += clearBrowserStorageBucket(bucket, normalizedOrigin, key);
      continue;
    }

    for (const bucketOrigin of Object.keys(bucket)) {
      if (!isHostAllowedForGrant(bucketOrigin, executionContext)) {
        continue;
      }
      removed += clearBrowserStorageBucket(bucket, bucketOrigin, key);
    }
  }

  storeBrowserSessionState(browserSessionId, state);
  return {
    action: "storage.clear",
    browserSessionId,
    storage,
    origin: normalizedOrigin,
    key,
    removed,
  };
}

async function executeBrowserContextConfigure(
  args: Record<string, unknown>,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  const browserSessionId = requireBrowserSessionId(args, executionContext, "browser.context.configure");
  let state = cloneBrowserSessionState(getBrowserSessionState(browserSessionId));

  if (asBoolean(args.reset, false)) {
    state = createEmptyBrowserSessionState();
  }

  if (Object.prototype.hasOwnProperty.call(args, "locale")) {
    state.locale = asString(args.locale);
  }
  if (Object.prototype.hasOwnProperty.call(args, "timezoneId")) {
    state.timezoneId = asString(args.timezoneId);
  }
  if (Object.prototype.hasOwnProperty.call(args, "geolocation")) {
    state.geolocation = normalizeBrowserGeolocation(args.geolocation);
  }
  if (Object.prototype.hasOwnProperty.call(args, "extraHTTPHeaders")) {
    state.extraHTTPHeaders = normalizeBrowserHeaders(args.extraHTTPHeaders);
  }
  if (Object.prototype.hasOwnProperty.call(args, "httpCredentials")) {
    state.httpCredentials = normalizeBrowserHttpCredentials(args.httpCredentials);
  }

  storeBrowserSessionState(browserSessionId, state);
  return {
    action: "context.configure",
    browserSessionId,
    locale: state.locale,
    timezoneId: state.timezoneId,
    geolocation: state.geolocation,
    extraHTTPHeaders: state.extraHTTPHeaders,
    httpCredentialsConfigured: Boolean(state.httpCredentials),
  };
}

function createEmptyBrowserSessionState(): BrowserSessionState {
  return {
    cookies: [],
    localStorage: {},
    sessionStorage: {},
    updatedAt: Date.now(),
  };
}

function cloneBrowserSessionState(state: BrowserSessionState): BrowserSessionState {
  return {
    cookies: state.cookies.map((cookie) => ({ ...cookie })),
    localStorage: cloneBrowserStorageBucket(state.localStorage),
    sessionStorage: cloneBrowserStorageBucket(state.sessionStorage),
    locale: state.locale,
    timezoneId: state.timezoneId,
    geolocation: state.geolocation ? { ...state.geolocation } : undefined,
    extraHTTPHeaders: state.extraHTTPHeaders ? { ...state.extraHTTPHeaders } : undefined,
    httpCredentials: state.httpCredentials ? { ...state.httpCredentials } : undefined,
    updatedAt: state.updatedAt,
  };
}

function cloneBrowserStorageBucket(bucket: BrowserStorageBucket): BrowserStorageBucket {
  return Object.fromEntries(Object.entries(bucket).map(([origin, entries]) => [origin, { ...entries }]));
}

function resolveBrowserSessionId(
  args: Record<string, unknown>,
  executionContext?: BrowserExecutionContext,
): string | undefined {
  // SECURITY (codex finding #24): The browser session id determines
  // which in-memory cookie/localStorage/credentials bucket Playwright
  // will re-inject. Previously caller-supplied `args.browserSessionId`
  // or `args.sessionId` won out over the execution context, so an
  // attacker who could influence tool arguments could target ANY
  // bucket in the global map — including a bucket holding authenticated
  // state for a different chat session, simply by guessing its id.
  // We now derive the bucket strictly from the execution context
  // (chat session) and ignore caller overrides.
  return asString(executionContext?.sessionId);
}

// Test-only export for browser-tools.session-id-override.security.test.ts.
export const __resolveBrowserSessionIdForTests = resolveBrowserSessionId;

function requireBrowserSessionId(
  args: Record<string, unknown>,
  executionContext: BrowserExecutionContext | undefined,
  toolName: BrowserToolName,
): string {
  const browserSessionId = resolveBrowserSessionId(args, executionContext);
  if (!browserSessionId) {
    throw new Error(`${toolName} requires active session context`);
  }
  return browserSessionId;
}

function getBrowserSessionState(sessionId: string): BrowserSessionState {
  const existing = browserSessionStates.get(sessionId);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing.state;
  }
  const created = createEmptyBrowserSessionState();
  browserSessionStates.set(sessionId, { state: created, lastAccess: Date.now() });
  evictOldestBrowserSessionStates();
  return created;
}

function storeBrowserSessionState(sessionId: string, state: BrowserSessionState): void {
  state.updatedAt = Date.now();
  browserSessionStates.set(sessionId, { state, lastAccess: Date.now() });
  evictOldestBrowserSessionStates();
}

function evictOldestBrowserSessionStates(): void {
  while (browserSessionStates.size > MAX_BROWSER_SESSION_STATES) {
    let oldestKey = "";
    let oldestLastAccess = Number.POSITIVE_INFINITY;
    for (const [sessionId, entry] of browserSessionStates.entries()) {
      if (entry.lastAccess < oldestLastAccess) {
        oldestLastAccess = entry.lastAccess;
        oldestKey = sessionId;
      }
    }
    browserSessionStates.delete(oldestKey);
  }
}

function buildBrowserCookieKey(cookie: BrowserCookieRecord): string {
  return [cookie.name, cookie.domain ?? "", cookie.path ?? "", cookie.url ?? ""].join("::");
}

function buildBrowserCookieFilter(args: Record<string, unknown>): {
  name?: string;
  domain?: string;
  path?: string;
  url?: string;
} {
  return {
    name: asString(args.name),
    domain: asString(args.domain),
    path: asString(args.path),
    url: asString(args.url),
  };
}

function hasBrowserCookieFilter(filter: { name?: string; domain?: string; path?: string; url?: string }): boolean {
  return Boolean(filter.name || filter.domain || filter.path || filter.url);
}

function browserCookieMatchesFilter(
  cookie: BrowserCookieRecord,
  filter: {
    name?: string;
    domain?: string;
    path?: string;
    url?: string;
  },
): boolean {
  if (filter.name && cookie.name !== filter.name) {
    return false;
  }
  if (filter.path && cookie.path !== filter.path) {
    return false;
  }
  if (filter.domain) {
    const normalizedFilterDomain = normalizeBrowserCookieDomain(filter.domain);
    const normalizedCookieDomain = normalizeBrowserCookieDomain(cookie.domain);
    if (normalizedFilterDomain !== normalizedCookieDomain) {
      return false;
    }
  }
  if (filter.url) {
    const parsedFilterUrl = new URL(filter.url);
    const filterHost = normalizeBrowserCookieDomain(parsedFilterUrl.hostname);
    const cookieHost = normalizeBrowserCookieDomain(cookie.domain ?? cookie.url);
    if (cookieHost !== filterHost) {
      return false;
    }
  }
  return true;
}

function assertBrowserCookieFilterAllowedForGrant(
  filter: { name?: string; domain?: string; path?: string; url?: string },
  executionContext?: BrowserExecutionContext,
): void {
  if (!hasGrantHostConstraints(executionContext)) {
    return;
  }
  if (filter.url) {
    assertHostAllowedForGrant(filter.url, executionContext);
  }
  if (filter.domain) {
    const normalizedDomain = normalizeBrowserCookieDomain(filter.domain);
    if (normalizedDomain) {
      assertHostAllowedForGrant(`https://${normalizedDomain}`, executionContext);
    }
  }
}

function browserCookieAllowedByGrant(cookie: BrowserCookieRecord, executionContext?: BrowserExecutionContext): boolean {
  if (!hasGrantHostConstraints(executionContext)) {
    return true;
  }
  const candidates: string[] = [];
  if (cookie.url) {
    candidates.push(cookie.url);
  }
  const domain = normalizeBrowserCookieDomain(cookie.domain);
  if (domain) {
    candidates.push(`https://${domain}`);
  }
  return candidates.length > 0 && candidates.every((candidate) => isHostAllowedForGrant(candidate, executionContext));
}

function normalizeBrowserCookieRecord(
  value: unknown,
  config: ToolPolicyConfig,
  fieldPrefix: string,
  executionContext?: BrowserExecutionContext,
): BrowserCookieRecord {
  if (!value || typeof value !== "object") {
    throw new Error(`${fieldPrefix} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const name = asNonEmptyString(record.name, `${fieldPrefix}.name`);
  if (typeof record.value !== "string") {
    throw new Error(`${fieldPrefix}.value is required`);
  }

  const normalized: BrowserCookieRecord = {
    name,
    value: record.value,
  };

  const url = asString(record.url);
  const domain = asString(record.domain);
  if (url) {
    assertAllowedHttpUrl(url);
    assertHostAllowedForConfig(url, config, executionContext);
    normalized.url = url;
  }
  if (domain) {
    const normalizedDomain = normalizeBrowserCookieDomain(domain);
    assertHostAllowedForConfig(`https://${normalizedDomain}`, config, executionContext);
    normalized.domain = domain.startsWith(".") ? `.${normalizedDomain}` : normalizedDomain;
  }
  if (!normalized.url && !normalized.domain) {
    throw new Error(`${fieldPrefix} requires url or domain`);
  }

  const cookiePath = asString(record.path);
  if (cookiePath) {
    normalized.path = cookiePath;
  }

  if (record.expires !== undefined) {
    const expires = Number(record.expires);
    if (!Number.isFinite(expires)) {
      throw new Error(`${fieldPrefix}.expires must be a finite number`);
    }
    normalized.expires = expires;
  }

  normalized.httpOnly = asBoolean(record.httpOnly, false);
  normalized.secure = asBoolean(record.secure, false);
  if (record.sameSite !== undefined) {
    const sameSite = asString(record.sameSite);
    if (sameSite !== "Lax" && sameSite !== "None" && sameSite !== "Strict") {
      throw new Error(`${fieldPrefix}.sameSite must be Lax, None, or Strict`);
    }
    normalized.sameSite = sameSite;
  }

  return normalized;
}

function normalizeBrowserCookieDomain(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return parsed.hostname.replace(/^\./u, "").toLowerCase();
  } catch {
    return value.replace(/^\./u, "").toLowerCase();
  }
}

function parseBrowserStorageKind(
  value: unknown,
  fallback: "local" | "session" | "both",
  allowBoth = false,
): "local" | "session" | "both" {
  const parsed = asString(value) ?? fallback;
  if (parsed === "local" || parsed === "session") {
    return parsed;
  }
  if (allowBoth && parsed === "both") {
    return parsed;
  }
  throw new Error(`storage must be ${allowBoth ? "local, session, or both" : "local or session"}`);
}

function normalizeBrowserOrigin(input: string): string {
  assertAllowedHttpUrl(input);
  return new URL(input).origin;
}

function normalizeBrowserOriginForConfig(
  input: string,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): string {
  const origin = normalizeBrowserOrigin(input);
  assertHostAllowedForConfig(origin, config, executionContext);
  return origin;
}

function filterBrowserStorageBucketByGrant(
  bucket: BrowserStorageBucket,
  executionContext?: BrowserExecutionContext,
): BrowserStorageBucket {
  if (!hasGrantHostConstraints(executionContext)) {
    return cloneBrowserStorageBucket(bucket);
  }
  const filtered: BrowserStorageBucket = {};
  for (const [origin, entries] of Object.entries(bucket)) {
    if (isHostAllowedForGrant(origin, executionContext)) {
      filtered[origin] = { ...entries };
    }
  }
  return filtered;
}

function normalizeBrowserStorageEntries(args: Record<string, unknown>): Record<string, string> {
  if (args.entries && typeof args.entries === "object" && !Array.isArray(args.entries)) {
    return normalizeBrowserStorageEntryRecord(args.entries as Record<string, unknown>, "entries");
  }

  const key = asNonEmptyString(args.key, "key");
  return {
    [key]: normalizeBrowserStorageScalar(args.value, "value"),
  };
}

function normalizeBrowserStorageEntryRecord(
  value: Record<string, unknown>,
  fieldPrefix: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const normalizedKey = entryKey.trim();
    if (!normalizedKey) {
      throw new Error(`${fieldPrefix} contains an empty key`);
    }
    out[normalizedKey] = normalizeBrowserStorageScalar(entryValue, `${fieldPrefix}.${normalizedKey}`);
  }
  return out;
}

function normalizeBrowserStorageScalar(value: unknown, field: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new Error(`${field} must be a string, number, or boolean`);
}

function selectBrowserStorageBuckets(
  state: BrowserSessionState,
  storage: "local" | "session" | "both",
): BrowserStorageBucket[] {
  if (storage === "both") {
    return [state.localStorage, state.sessionStorage];
  }
  return [storage === "local" ? state.localStorage : state.sessionStorage];
}

function clearBrowserStorageBucket(bucket: BrowserStorageBucket, origin: string, key?: string): number {
  const existing = bucket[origin];
  if (!existing) {
    return 0;
  }
  if (!key) {
    const removed = Object.keys(existing).length;
    delete bucket[origin];
    return removed;
  }
  if (!(key in existing)) {
    return 0;
  }
  delete existing[key];
  if (Object.keys(existing).length === 0) {
    delete bucket[origin];
  } else {
    bucket[origin] = existing;
  }
  return 1;
}

function normalizeBrowserGeolocation(value: unknown): BrowserSessionState["geolocation"] {
  if (value == null) {
    return undefined;
  }
  if (!value || typeof value !== "object") {
    throw new Error("geolocation must be an object");
  }
  const record = value as Record<string, unknown>;
  const latitude = Number(record.latitude);
  const longitude = Number(record.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error("geolocation.latitude must be between -90 and 90");
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("geolocation.longitude must be between -180 and 180");
  }
  const accuracy = record.accuracy === undefined ? undefined : Number(record.accuracy);
  if (accuracy !== undefined && (!Number.isFinite(accuracy) || accuracy < 0)) {
    throw new Error("geolocation.accuracy must be a non-negative number");
  }
  return {
    latitude,
    longitude,
    accuracy,
  };
}

function normalizeBrowserHeaders(value: unknown): Record<string, string> | undefined {
  if (value == null) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("extraHTTPHeaders must be an object");
  }
  const headers = normalizeBrowserStorageEntryRecord(value as Record<string, unknown>, "extraHTTPHeaders");
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeBrowserHttpCredentials(value: unknown): BrowserSessionState["httpCredentials"] {
  if (value == null) {
    return undefined;
  }
  if (!value || typeof value !== "object") {
    throw new Error("httpCredentials must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    username: asNonEmptyString(record.username, "httpCredentials.username"),
    password: asNonEmptyString(record.password, "httpCredentials.password"),
  };
}

async function snapshotBrowserSessionStorage(
  page: PlaywrightPage,
  finalUrl: string,
  previousState: BrowserSessionState | undefined,
): Promise<BrowserStorageBucket> {
  const nextSessionStorage = cloneBrowserStorageBucket(previousState?.sessionStorage ?? {});
  try {
    const origin = new URL(finalUrl).origin;
    const entries = await page.evaluate(() => {
      const out: Record<string, string> = {};
      for (let index = 0; index < window.sessionStorage.length; index += 1) {
        const key = window.sessionStorage.key(index);
        if (!key) {
          continue;
        }
        const value = window.sessionStorage.getItem(key);
        if (value !== null) {
          out[key] = value;
        }
      }
      return out;
    }, undefined);
    if (Object.keys(entries).length === 0) {
      delete nextSessionStorage[origin];
    } else {
      nextSessionStorage[origin] = entries;
    }
  } catch {
    // Ignore sessionStorage capture failures and keep the last known in-memory snapshot.
  }
  return nextSessionStorage;
}

function buildPlaywrightStorageState(state: BrowserSessionState | undefined): PlaywrightStorageState | undefined {
  if (!state) {
    return undefined;
  }
  const cookies = state.cookies.map((cookie) => ({ ...cookie }));
  const origins = Object.entries(state.localStorage).map(([origin, entries]) => ({
    origin,
    localStorage: Object.entries(entries).map(([name, value]) => ({ name, value })),
  }));
  if (cookies.length === 0 && origins.length === 0) {
    return undefined;
  }
  return {
    cookies,
    origins,
  };
}

function buildPlaywrightContextOptions(
  args: Record<string, unknown>,
  state: BrowserSessionState | undefined,
): PlaywrightContextOptions {
  const storageState = buildPlaywrightStorageState(state);
  return {
    locale: state?.locale,
    timezoneId: state?.timezoneId,
    geolocation: state?.geolocation,
    extraHTTPHeaders: state?.extraHTTPHeaders,
    httpCredentials: state?.httpCredentials,
    storageState,
  };
}

async function withBrowserPage(
  url: string,
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext: BrowserExecutionContext | undefined,
  run: (page: PlaywrightPage, responseStatus: number | undefined, finalUrl: string) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  throwIfBrowserExecutionAborted(executionContext?.signal);
  assertAllowedHttpUrl(url);
  assertHostAllowedForConfig(url, config, executionContext);

  const playwright = await loadPlaywright();
  const headless = asBoolean(args.headless, true);
  const timeout = clampInt(args.timeoutMs, 20000, 2000, 120000);
  const waitUntil = parseWaitUntil(args.waitUntil);
  const browserSessionId = resolveBrowserSessionId(args, executionContext);
  const previousSessionState = browserSessionId
    ? cloneBrowserSessionState(getBrowserSessionState(browserSessionId))
    : undefined;
  const browser = await launchPlaywrightChromium(playwright, headless);
  const abortSignal = executionContext?.signal;
  const abortHandler = abortSignal
    ? () => {
        void browser.close().catch(() => undefined);
      }
    : undefined;

  try {
    if (abortSignal && abortHandler) {
      abortSignal.addEventListener("abort", abortHandler, { once: true });
      throwIfBrowserExecutionAborted(abortSignal);
    }
    const context = await browser.newContext(buildPlaywrightContextOptions(args, previousSessionState));
    if (previousSessionState?.geolocation) {
      await context.grantPermissions?.(["geolocation"], { origin: new URL(url).origin });
    }
    if (previousSessionState && Object.keys(previousSessionState.sessionStorage).length > 0) {
      await context.addInitScript?.((sessionStorageByOrigin: BrowserStorageBucket) => {
        const entries = sessionStorageByOrigin[window.location.origin];
        if (!entries) {
          return;
        }
        window.sessionStorage.clear();
        for (const [key, value] of Object.entries(entries)) {
          window.sessionStorage.setItem(key, value);
        }
      }, previousSessionState.sessionStorage);
    }
    const page = await context.newPage();
    let navigationGuardError: Error | undefined;
    if (page.route) {
      await page.route("**/*", async (route) => {
        try {
          const requestUrl = route.request().url();
          assertAllowedHttpUrl(requestUrl);
          assertHostAllowedForConfig(requestUrl, config, executionContext);
        } catch (error) {
          navigationGuardError = error instanceof Error ? error : new Error(String(error));
          await route.abort("blockedbyclient").catch(() => undefined);
          return;
        }
        await route.continue();
      });
    }
    const response = await page
      .goto(url, {
        timeout,
        waitUntil,
      })
      .catch((error: unknown) => {
        if (navigationGuardError) {
          throw navigationGuardError;
        }
        throw error;
      });
    if (navigationGuardError) {
      throw navigationGuardError;
    }

    const finalUrl = page.url();
    assertAllowedHttpUrl(finalUrl);
    assertHostAllowedForConfig(finalUrl, config, executionContext);

    const result = await run(page, response?.status(), finalUrl);
    if (browserSessionId) {
      const storageState = await context.storageState?.();
      const nextState: BrowserSessionState = {
        cookies: (storageState?.cookies ?? previousSessionState?.cookies ?? []).map((cookie) => ({ ...cookie })),
        localStorage: storageState
          ? Object.fromEntries(
              storageState.origins.map((originRecord) => [
                originRecord.origin,
                Object.fromEntries(originRecord.localStorage.map((entry) => [entry.name, entry.value])),
              ]),
            )
          : cloneBrowserStorageBucket(previousSessionState?.localStorage ?? {}),
        sessionStorage: await snapshotBrowserSessionStorage(page, finalUrl, previousSessionState),
        locale: previousSessionState?.locale,
        timezoneId: previousSessionState?.timezoneId,
        geolocation: previousSessionState?.geolocation ? { ...previousSessionState.geolocation } : undefined,
        extraHTTPHeaders: previousSessionState?.extraHTTPHeaders
          ? { ...previousSessionState.extraHTTPHeaders }
          : undefined,
        httpCredentials: previousSessionState?.httpCredentials
          ? { ...previousSessionState.httpCredentials }
          : undefined,
        updatedAt: Date.now(),
      };
      storeBrowserSessionState(browserSessionId, nextState);
    }
    return {
      url,
      finalUrl,
      browserSessionId,
      ...result,
    };
  } finally {
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
    await browser.close().catch(() => undefined);
  }
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  const moduleName = "playwright";
  try {
    const loaded = await import(moduleName);
    return loaded as PlaywrightModule;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "Unknown error");
    throw new Error(
      `Playwright runtime is unavailable: ${reason}. Install dependencies and run "pnpm --filter @goatcitadel/policy-engine exec playwright install chromium".`,
      {
        cause: error,
      },
    );
  }
}

async function launchPlaywrightChromium(playwright: PlaywrightModule, headless: boolean): Promise<PlaywrightBrowser> {
  try {
    return await playwright.chromium.launch({ headless });
  } catch (error) {
    if (!isMissingPlaywrightBrowserError(error)) {
      throw error;
    }
    await ensurePlaywrightChromiumInstalled();
    return playwright.chromium.launch({ headless });
  }
}

function isMissingPlaywrightBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /browsertype\.launch: executable doesn't exist/i.test(message);
}

async function ensurePlaywrightChromiumInstalled(): Promise<void> {
  if (!playwrightChromiumInstallPromise) {
    playwrightChromiumInstallPromise = (async () => {
      const appDir = resolvePlaywrightInstallDir();
      const pnpmCommand = resolvePnpmCommand();
      const result = spawnSync(
        pnpmCommand,
        ["--filter", "@goatcitadel/policy-engine", "exec", "playwright", "install", "chromium"],
        {
          cwd: appDir,
          stdio: "inherit",
          env: process.env,
        },
      );
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(`Failed to install Playwright Chromium runtime (exit code ${result.status ?? "unknown"})`);
      }
    })().finally(() => {
      playwrightChromiumInstallPromise = null;
    });
  }
  return playwrightChromiumInstallPromise;
}

function throwIfBrowserExecutionAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    throw error;
  }
}

function resolvePlaywrightInstallDir(): string {
  const fromEnv = process.env.GOATCITADEL_APP_DIR?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return process.cwd();
}

function resolvePnpmCommand(): string {
  const candidates = process.platform === "win32" ? ["pnpm.cmd", "pnpm", "pnpm.exe"] : ["pnpm"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  throw new Error("pnpm is not available to install Playwright Chromium runtime");
}

async function extractText(page: PlaywrightPage, selector: string, maxChars: number): Promise<string> {
  await page.waitForTimeout(750);
  try {
    const text = await page.locator(selector).first().innerText({
      timeout: 5000,
    });
    return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
  } catch {
    const text = await page.locator("body").first().innerText({ timeout: 5000 });
    return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
  }
}

interface WeatherSnapshot {
  summary: string;
  location?: string;
  condition?: string;
  temperature?: string;
}

async function extractWeatherSnapshot(page: PlaywrightPage, title: string): Promise<WeatherSnapshot | undefined> {
  await page.waitForTimeout(900);
  const rawTemperature = await readFirstLocatorText(page, [
    "[data-testid='TemperatureValue']",
    "[data-testid='TemperatureValue'] span",
    "[class*='CurrentConditions--tempValue']",
    "[class*='CurrentConditions--tempValue'] span",
    "[class*='CurrentConditions--primary-temp']",
    "span[data-testid*='Temperature']",
  ]);
  const rawCondition = await readFirstLocatorText(page, [
    "[data-testid='wxPhrase']",
    "[data-testid='wxPhrase'] span",
    "[class*='CurrentConditions--phraseValue']",
    "[class*='CurrentConditions--phraseValue'] span",
    "[class*='CurrentConditions--condition']",
  ]);
  const rawLocation = await readFirstLocatorText(page, [
    "[data-testid='PresentationName']",
    "[data-testid='LocationPageTitle']",
    "[class*='CurrentConditions--location']",
    "h1[data-testid*='LocationPageTitle']",
    "h1",
  ]);
  const body = await extractText(page, "body", 3500);

  const temperature = normalizeTemperature(rawTemperature) ?? normalizeTemperature(title) ?? normalizeTemperature(body);
  const condition = normalizeCondition(rawCondition) ?? normalizeCondition(title) ?? normalizeCondition(body);
  const location = normalizeLocation(rawLocation) ?? extractLocationFromTitle(title) ?? normalizeLocation(title);

  if (!temperature && !condition) {
    return undefined;
  }

  const parts = [location, temperature, condition].filter(Boolean).join(" | ");
  return {
    summary: `Current weather snapshot: ${parts}.`,
    location: location ?? undefined,
    condition: condition ?? undefined,
    temperature: temperature ?? undefined,
  };
}

async function extractWeatherSnapshotFromVisualTree(
  page: PlaywrightPage,
  title: string,
  maxChars: number,
): Promise<{ weather: WeatherSnapshot; visualTextSnippet: string } | undefined> {
  const visualText = await extractVisualTextFromAccessibilityTree(page, Math.max(800, maxChars));
  if (!visualText) {
    return undefined;
  }

  const temperature = normalizeTemperature(visualText) ?? normalizeTemperature(title);
  const condition = normalizeCondition(visualText) ?? normalizeCondition(title);
  const location = extractLocationFromTitle(title) ?? normalizeLocation(visualText) ?? normalizeLocation(title);

  if (!temperature && !condition) {
    return undefined;
  }

  const parts = [location, temperature, condition].filter(Boolean).join(" | ");
  return {
    weather: {
      summary: `Visual weather snapshot: ${parts}.`,
      location: location ?? undefined,
      condition: condition ?? undefined,
      temperature: temperature ?? undefined,
    },
    visualTextSnippet: visualText.slice(0, 900),
  };
}

async function extractVisualTextFromAccessibilityTree(
  page: PlaywrightPage,
  maxChars: number,
): Promise<string | undefined> {
  if (!page.accessibility?.snapshot) {
    return undefined;
  }

  try {
    const root = await page.accessibility.snapshot({ interestingOnly: false });
    if (!root) {
      return undefined;
    }
    const chunks: string[] = [];
    collectAccessibilityText(root, chunks);
    const merged = chunks.join(" ").replace(/\s+/g, " ").trim();
    return merged ? merged.slice(0, maxChars) : undefined;
  } catch {
    return undefined;
  }
}

function collectAccessibilityText(node: AccessibilitySnapshotNode, output: string[]): void {
  if (typeof node.name === "string" && node.name.trim()) {
    output.push(node.name.trim());
  }
  if (typeof node.value === "string" && node.value.trim()) {
    output.push(node.value.trim());
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      collectAccessibilityText(child, output);
    }
  }
}

async function readFirstLocatorText(page: PlaywrightPage, selectors: string[]): Promise<string | undefined> {
  for (const selector of selectors) {
    try {
      const value = await page.locator(selector).first().innerText({ timeout: 1200 });
      const normalized = value.replace(/\s+/g, " ").trim();
      if (normalized) {
        return normalized;
      }
    } catch {
      // Continue searching other selectors.
    }
  }
  return undefined;
}

function normalizeTemperature(input: string | undefined): string | undefined {
  const value = (input ?? "").replace(/\s+/g, " ").trim();
  if (!value) {
    return undefined;
  }

  const direct = value.match(/(-?\d{1,3})\s*°\s*([FC])?/i);
  if (direct) {
    const unit = direct[2] ? direct[2].toUpperCase() : "";
    return `${direct[1]}°${unit}`;
  }

  const fahrenheitWord = value.match(/(-?\d{1,3})\s*(degrees?|deg)\s*fahrenheit/i);
  if (fahrenheitWord) {
    return `${fahrenheitWord[1]}°F`;
  }
  const celsiusWord = value.match(/(-?\d{1,3})\s*(degrees?|deg)\s*celsius/i);
  if (celsiusWord) {
    return `${celsiusWord[1]}°C`;
  }

  const jsonLike = value.match(/(?:temp(?:erature)?|currentTemp|feelsLike)[^0-9-]{0,12}(-?\d{1,3})/i);
  if (jsonLike) {
    return `${jsonLike[1]}°`;
  }

  return undefined;
}

function normalizeCondition(input: string | undefined): string | undefined {
  const value = (input ?? "").replace(/\s+/g, " ").trim();
  if (!value) {
    return undefined;
  }

  const phrase = value.match(
    /\b(sunny|mostly sunny|partly cloudy|cloudy|overcast|rain|rainy|showers|snow|snowy|fog|mist|haze|clear|windy|thunderstorms?)\b/i,
  );
  if (!phrase) {
    return undefined;
  }
  return phrase[0]
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeLocation(input: string | undefined): string | undefined {
  const value = (input ?? "").replace(/\s+/g, " ").trim();
  if (!value) {
    return undefined;
  }

  const cleaned = value
    .replace(/\b(weather|forecast|today|hourly|current conditions)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 3) {
    return undefined;
  }
  if (/^-?\d{1,3}\s*°[FC]?$/i.test(cleaned) || cleaned.includes("°")) {
    return undefined;
  }
  if (/^\d+$/.test(cleaned)) {
    return undefined;
  }
  return cleaned.slice(0, 80);
}

function extractLocationFromTitle(title: string): string | undefined {
  const value = title.replace(/\s+/g, " ").trim();
  if (!value) {
    return undefined;
  }

  const weatherFor = value.match(/\bfor\s+(.+?)\s*(?:\||$)/i);
  if (weatherFor?.[1]) {
    return normalizeLocation(weatherFor[1]);
  }

  const dashSplit = value.split("|")[0]?.trim();
  return normalizeLocation(dashSplit);
}

function parseStep(value: unknown): BrowserStepInput {
  if (!value || typeof value !== "object") {
    throw new Error("browser.interact step must be an object");
  }
  const step = value as Record<string, unknown>;
  const action = asString(step.action) as BrowserStepInput["action"] | undefined;
  if (!action || !["click", "type", "press", "wait_for_selector", "wait"].includes(action)) {
    throw new Error(`Unsupported browser.interact step action: ${String(step.action ?? "")}`);
  }
  return {
    action,
    selector: asString(step.selector),
    text: asString(step.text),
    key: asString(step.key),
    timeoutMs: typeof step.timeoutMs === "number" ? step.timeoutMs : undefined,
  };
}

function buildSearchUrl(engine: string, query: string): string {
  const encoded = encodeURIComponent(query);
  if (engine === "google") {
    return `https://www.google.com/search?q=${encoded}`;
  }
  if (engine === "bing") {
    return `https://www.bing.com/search?q=${encoded}`;
  }
  return `https://lite.duckduckgo.com/lite/?q=${encoded}`;
}

function normalizeSearchEngine(engine: string | undefined): "auto" | "duckduckgo" | "bing" | "google" | undefined {
  if (!engine) {
    return undefined;
  }
  if (engine === "auto" || engine === "duckduckgo" || engine === "bing" || engine === "google") {
    return engine;
  }
  return undefined;
}

function normalizeSearchBackend(backend: string | undefined): "native" | "firecrawl" | "ollama" | undefined {
  if (!backend) {
    return undefined;
  }
  const normalized = backend.toLowerCase();
  if (normalized === "native" || normalized === "firecrawl" || normalized === "ollama") {
    return normalized;
  }
  return undefined;
}

function normalizeBrowserReadBackend(backend: string | undefined): "native" | "firecrawl" {
  return backend?.toLowerCase() === "firecrawl" ? "firecrawl" : "native";
}

function resolveSearchEngineCandidates(
  engine: "auto" | "duckduckgo" | "bing" | "google",
): Array<"duckduckgo" | "bing" | "google"> {
  if (engine === "google") {
    return ["google", "bing", "duckduckgo"];
  }
  if (engine === "bing") {
    return ["bing", "duckduckgo", "google"];
  }
  if (engine === "duckduckgo") {
    return ["duckduckgo", "bing", "google"];
  }
  return ["duckduckgo", "bing", "google"];
}

function parseWaitUntil(input: unknown): "load" | "domcontentloaded" | "networkidle" {
  const value = asString(input)?.toLowerCase();
  if (value === "load" || value === "networkidle" || value === "domcontentloaded") {
    return value;
  }
  return "domcontentloaded";
}

function ensureSelector(value: string | undefined, action: string): string {
  if (!value || !value.trim()) {
    throw new Error(`browser.interact ${action} step requires selector`);
  }
  return value;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string): string {
  const parsed = asString(value);
  if (!parsed) {
    throw new Error(`${field} is required`);
  }
  return parsed;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") {
      return true;
    }
    if (value.toLowerCase() === "false") {
      return false;
    }
  }
  return fallback;
}

function assertAllowedHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol for browser tool: ${parsed.protocol}`);
  }
}

async function executeBrowserSearchFallback(
  query: string,
  limit: number,
  config: ToolPolicyConfig,
  engine: string,
  executionContext?: BrowserExecutionContext,
  signal?: AbortSignal,
): Promise<{
  finalUrl: string;
  results: Array<{ title: string; url: string; snippet: string }>;
}> {
  const url = buildSearchUrl(engine, query);
  const page = await fetchTextAllowlisted(url, config, executionContext, signal);
  return {
    finalUrl: page.finalUrl,
    results: filterBrowserSearchResultsForPolicy(
      parseSearchResults(page.html, Math.max(limit * 20, 80), page.finalUrl),
      config,
      executionContext,
      limit,
    ),
  };
}

async function applySearchBackend(
  base: {
    requestedEngine?: string;
    engine: string;
    query: string;
    finalUrl: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  },
  input: {
    args: Record<string, unknown>;
    config: ToolPolicyConfig;
    requestedBackend?: "ollama";
    signal?: AbortSignal;
  },
): Promise<
  typeof base & {
    summaryBackend?: "ollama";
    summaryBackendUsed?: boolean;
    backendWarning?: string;
    summary?: string;
  }
> {
  if (!input.requestedBackend || base.results.length === 0) {
    return base;
  }

  try {
    const summary = await summarizeSearchResultsWithOllama(base.query, base.results, input);
    return {
      ...base,
      summaryBackend: "ollama",
      summaryBackendUsed: true,
      summary,
    };
  } catch (error) {
    return {
      ...base,
      summaryBackend: "ollama",
      summaryBackendUsed: false,
      backendWarning: (error as Error).message,
    };
  }
}

async function summarizeSearchResultsWithOllama(
  query: string,
  results: Array<{ title: string; url: string; snippet: string }>,
  input: {
    args: Record<string, unknown>;
    config: ToolPolicyConfig;
    signal?: AbortSignal;
  },
): Promise<string> {
  const endpoint = resolveOllamaSearchEndpoint(input.args);
  assertAllowedHttpUrl(endpoint);
  assertHostAllowedForConfig(endpoint, input.config);

  const model = asString(input.args.ollamaModel) ?? process.env.GOATCITADEL_OLLAMA_SEARCH_MODEL?.trim() ?? "llama3.2";
  const renderedResults = results
    .slice(0, 8)
    .map((result, index) => `${index + 1}. ${result.title}\nURL: ${result.url}\nSnippet: ${result.snippet}`)
    .join("\n\n");
  const prompt = [
    "Summarize the most relevant web results for the query below.",
    "Use only the provided results.",
    "Keep the answer concise and high-signal.",
    "",
    `Query: ${query}`,
    "",
    renderedResults,
  ].join("\n");

  const response = await fetchAllowlisted(endpoint, {
    allowlist: input.config.sandbox.networkAllowlist,
    timeoutMs: 15_000,
    init: {
      method: "POST",
      signal: input.signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0.2,
        },
      }),
    },
  });
  if (!response.ok) {
    throw new Error(`Ollama search backend failed (${response.status} ${response.statusText}).`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const summary = typeof payload.response === "string" ? payload.response.trim() : "";
  if (!summary) {
    throw new Error("Ollama search backend returned no summary.");
  }
  return summary;
}

function resolveOllamaSearchEndpoint(args: Record<string, unknown>): string {
  const explicit = asString(args.ollamaUrl);
  if (explicit) {
    return explicit;
  }
  const envHost = process.env.OLLAMA_HOST?.trim() || process.env.GOATCITADEL_OLLAMA_SEARCH_URL?.trim();
  const base = envHost && envHost.length > 0 ? trimTrailingSlashes(envHost) : "http://127.0.0.1:11434";
  return base.endsWith("/api/generate") ? base : `${base}/api/generate`;
}

function resolveFirecrawlRuntimeConfig(args: Record<string, unknown>): {
  baseUrl: string;
  timeoutMs: number;
  apiKey?: string;
} {
  const baseUrl = asString(args.firecrawlBaseUrl) ?? process.env.FIRECRAWL_BASE_URL?.trim() ?? "http://127.0.0.1:3002";
  const timeoutMs = clampInt(args.firecrawlTimeoutMs, 20_000, 1_000, 120_000);
  const apiKeyEnv =
    normalizeFirecrawlApiKeyEnvName(asString(args.firecrawlApiKeyEnv)) ??
    normalizeFirecrawlApiKeyEnvName(process.env.GOATCITADEL_FIRECRAWL_API_KEY_ENV) ??
    "FIRECRAWL_API_KEY";
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv]?.trim() : undefined;
  return {
    baseUrl: trimTrailingSlashes(baseUrl),
    timeoutMs,
    apiKey: apiKey || undefined,
  };
}

function isCanonicalLocalFirecrawlBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port === "3002";
  } catch {
    return false;
  }
}

function assertFirecrawlBaseUrlAllowed(baseUrl: string, config: ToolPolicyConfig): void {
  assertAllowedHttpUrl(baseUrl);
  if (isCanonicalLocalFirecrawlBaseUrl(baseUrl)) {
    return;
  }
  assertHostAllowedForConfig(baseUrl, config);
  assertNotPrivateOrReservedHost(baseUrl);
}

async function fetchFirecrawlEndpoint(
  firecrawl: { baseUrl: string; timeoutMs: number },
  path: string,
  config: ToolPolicyConfig,
  init: RequestInit,
): Promise<Response> {
  const targetUrl = `${firecrawl.baseUrl}${path}`;
  if (isCanonicalLocalFirecrawlBaseUrl(firecrawl.baseUrl)) {
    return fetchAllowlisted(targetUrl, {
      allowlist: ["127.0.0.1:3002", "localhost:3002"],
      timeoutMs: firecrawl.timeoutMs,
      init,
    });
  }
  return fetchAllowlisted(targetUrl, {
    allowlist: config.sandbox.networkAllowlist,
    timeoutMs: firecrawl.timeoutMs,
    init,
  });
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

async function executeBrowserSearchViaFirecrawl(
  query: string,
  limit: number,
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): Promise<Record<string, unknown>> {
  const firecrawl = resolveFirecrawlRuntimeConfig(args);
  assertFirecrawlBaseUrlAllowed(firecrawl.baseUrl, config);
  const response = await fetchFirecrawlEndpoint(firecrawl, "/v2/search", config, {
    method: "POST",
    signal: executionContext?.signal ?? AbortSignal.timeout(firecrawl.timeoutMs),
    headers: {
      "Content-Type": "application/json",
      ...(firecrawl.apiKey ? { Authorization: `Bearer ${firecrawl.apiKey}` } : {}),
    },
    body: JSON.stringify({
      query,
      limit,
    }),
  });
  if (!response.ok) {
    throw new Error(`Firecrawl search failed (${response.status} ${response.statusText}).`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const payloadData = asRecord(payload.data);
  const data = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payloadData.results)
      ? (payloadData.results as unknown[])
      : [];
  const results = data
    .map((item) => normalizeFirecrawlSearchResult(item))
    .filter((item): item is { title: string; url: string; snippet: string } => Boolean(item))
    .filter((item) => isBrowserSearchResultAllowed(item.url, config, executionContext))
    .slice(0, limit);
  return {
    query,
    engine: "firecrawl",
    finalUrl: `${firecrawl.baseUrl}/v2/search`,
    results,
    summary: asString(payloadData.summary) ?? asString(payload.summary),
  };
}

function normalizeFirecrawlSearchResult(value: unknown): { title: string; url: string; snippet: string } | undefined {
  const item = asRecord(value);
  const url = asString(item.url) ?? asString(item.sourceURL) ?? asString(item.sourceUrl);
  if (!url) {
    return undefined;
  }
  return {
    title: asString(item.title) ?? url,
    url,
    snippet: asString(item.description) ?? asString(item.snippet) ?? asString(item.markdown) ?? "",
  };
}

function isBrowserSearchResultAllowed(
  url: string,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
): boolean {
  try {
    void config;
    assertAllowedHttpUrl(url);
    assertHostAllowedForGrant(url, executionContext);
    assertNotPrivateOrReservedHost(url);
    return true;
  } catch {
    return false;
  }
}

function filterBrowserSearchResultsForPolicy(
  results: Array<{ title: string; url: string; snippet: string }>,
  config: ToolPolicyConfig,
  executionContext: BrowserExecutionContext | undefined,
  limit: number,
): Array<{ title: string; url: string; snippet: string }> {
  const filtered: Array<{ title: string; url: string; snippet: string }> = [];
  for (const result of results) {
    if (!isBrowserSearchResultAllowed(result.url, config, executionContext)) {
      continue;
    }
    filtered.push(result);
    if (filtered.length >= limit) {
      break;
    }
  }
  return filtered;
}

async function executeBrowserNavigateViaFirecrawl(
  url: string,
  maxChars: number,
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const scrape = await executeFirecrawlScrape(url, ["markdown", "html"], args, config, executionContext, signal);
  return {
    url,
    finalUrl: scrape.finalUrl,
    title: scrape.title,
    status: scrape.status,
    textSnippet: (scrape.markdown || extractHtmlText(scrape.html, maxChars)).slice(0, maxChars),
    extractionMode: scrape.markdown ? "firecrawl-markdown" : "firecrawl-html",
  };
}

async function executeBrowserExtractViaFirecrawl(
  url: string,
  selector: string,
  maxChars: number,
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const scrape = await executeFirecrawlScrape(url, ["html", "markdown"], args, config, executionContext, signal);
  const extracted = await extractHtmlSelectorText(scrape.html, selector, maxChars, signal);
  return {
    url,
    finalUrl: scrape.finalUrl,
    title: scrape.title,
    selector,
    status: scrape.status,
    text: extracted.text,
    extractionMode: extracted.extractionMode,
  };
}

async function executeFirecrawlScrape(
  url: string,
  formats: string[],
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
  signal?: AbortSignal,
): Promise<{
  finalUrl: string;
  title: string;
  status: number;
  markdown: string;
  html: string;
}> {
  const firecrawl = resolveFirecrawlRuntimeConfig(args);
  assertFirecrawlBaseUrlAllowed(firecrawl.baseUrl, config);
  assertAllowedHttpUrl(url);
  assertHostAllowedForConfig(url, config, executionContext);
  assertNotPrivateOrReservedHost(url);
  const response = await fetchFirecrawlEndpoint(firecrawl, "/v2/scrape", config, {
    method: "POST",
    signal: signal ?? AbortSignal.timeout(firecrawl.timeoutMs),
    headers: {
      "Content-Type": "application/json",
      ...(firecrawl.apiKey ? { Authorization: `Bearer ${firecrawl.apiKey}` } : {}),
    },
    body: JSON.stringify({
      url,
      formats,
    }),
  });
  if (!response.ok) {
    throw new Error(`Firecrawl scrape failed (${response.status} ${response.statusText}).`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const data = asRecord(payload.data);
  const metadata = asRecord(data.metadata);
  const html = asString(data.html) ?? "";
  const markdown = asString(data.markdown) ?? asString(data.content) ?? "";
  const reportedFinalUrl = asString(metadata.sourceURL) ?? asString(metadata.sourceUrl) ?? asString(data.url);
  const grantAllowlist = getGrantHostAllowlist(executionContext);
  if (!reportedFinalUrl && (config.sandbox.networkAllowlist.length > 0 || grantAllowlist.length > 0)) {
    throw new Error("Firecrawl did not report a final source URL; refusing to return allowlist-constrained content.");
  }
  const finalUrl = reportedFinalUrl ?? url;
  assertAllowedHttpUrl(finalUrl);
  assertHostAllowedForConfig(finalUrl, config, executionContext);
  assertNotPrivateOrReservedHost(finalUrl);
  return {
    finalUrl,
    title: asString(metadata.title) ?? asString(data.title) ?? extractHtmlTitle(html) ?? finalUrl,
    status: typeof metadata.statusCode === "number" ? metadata.statusCode : response.status,
    markdown,
    html,
  };
}

async function extractHtmlSelectorText(
  html: string,
  selector: string,
  maxChars: number,
  signal?: AbortSignal,
): Promise<{ text: string; extractionMode: string }> {
  if (!html) {
    return {
      text: "",
      extractionMode: selector === "body" ? "firecrawl-html" : "firecrawl-html-body-fallback",
    };
  }

  try {
    const playwright = await loadPlaywright();
    const browser = await launchPlaywrightChromium(playwright, true);
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      if (!page.setContent) {
        throw new Error("Playwright page.setContent is unavailable.");
      }
      throwIfBrowserExecutionAborted(signal);
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      const text = await page.locator(selector).first().innerText({ timeout: 5_000 });
      return {
        text: text.replace(/\s+/g, " ").trim().slice(0, maxChars),
        extractionMode: "firecrawl-html-selector",
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch {
    return {
      text: extractHtmlText(html, maxChars),
      extractionMode: selector === "body" ? "firecrawl-html" : "firecrawl-html-body-fallback",
    };
  }
}

async function executeBrowserNavigateFallback(
  url: string,
  maxChars: number,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const page = await fetchTextAllowlisted(url, config, executionContext, signal);
  const title = extractHtmlTitle(page.html) ?? page.finalUrl;
  const textSnippet = extractHtmlText(page.html, maxChars);
  return {
    url,
    finalUrl: page.finalUrl,
    title,
    status: 200,
    textSnippet,
    extractionMode: "html-fetch",
  };
}

async function executeBrowserExtractFallback(
  url: string,
  selector: string,
  maxChars: number,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const page = await fetchTextAllowlisted(url, config, executionContext, signal);
  const title = extractHtmlTitle(page.html) ?? page.finalUrl;
  const text = extractHtmlText(page.html, maxChars);
  return {
    url,
    finalUrl: page.finalUrl,
    title,
    selector,
    status: 200,
    text,
    extractionMode: selector === "body" ? "html-fetch" : "html-fetch-body-fallback",
  };
}

async function fetchTextAllowlisted(
  url: string,
  config: ToolPolicyConfig,
  executionContext?: BrowserExecutionContext,
  signal?: AbortSignal,
): Promise<{ html: string; finalUrl: string }> {
  assertAllowedHttpUrl(url);
  assertHostAllowedForConfig(url, config, executionContext);
  const grantAllowlist = getGrantHostAllowlist(executionContext);

  const response = await fetchAllowlisted(url, {
    allowlist: config.sandbox.networkAllowlist,
    additionalAllowlists: grantAllowlist.length > 0 ? [grantAllowlist] : undefined,
    timeoutMs: 20_000,
    init: {
      method: "GET",
      signal,
      headers: {
        "User-Agent": "GoatCitadel/1.0.0 (+https://localhost)",
        Accept: "text/html,application/xhtml+xml",
      },
    },
  });

  const finalUrl = response.url || url;
  assertAllowedHttpUrl(finalUrl);
  assertHostAllowedForConfig(finalUrl, config, executionContext);

  if (!response.ok) {
    throw new Error(`Search fetch failed (${response.status})`);
  }

  return {
    html: await response.text(),
    finalUrl,
  };
}

function parseSearchResults(
  html: string,
  limit: number,
  baseUrl: string,
): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null && out.length < limit) {
    const rawHref = decodeHtmlEntities(match[1] ?? "").trim();
    const resolvedUrl = normalizeSearchResultUrl(rawHref, baseUrl);
    if (!resolvedUrl || seen.has(resolvedUrl)) {
      continue;
    }

    const title = stripHtml(decodeHtmlEntities(match[2] ?? ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!title) {
      continue;
    }

    const snippet = extractSnippetNear(html, match.index, 420);
    out.push({
      title: title.slice(0, 240),
      url: resolvedUrl,
      snippet,
    });
    seen.add(resolvedUrl);
  }

  return out;
}

function normalizeBrowserSearchResults(
  rawResults: Array<{ href: string; title: string; snippet: string }>,
  baseUrl: string,
  limit: number,
): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  const seen = new Set<string>();
  for (const raw of rawResults) {
    const resolvedUrl = normalizeSearchResultUrl(raw.href, baseUrl);
    if (!resolvedUrl || seen.has(resolvedUrl)) {
      continue;
    }
    const title = raw.title.replace(/\s+/g, " ").trim();
    out.push({
      title: title.slice(0, 240),
      url: resolvedUrl,
      snippet: raw.snippet.replace(/\s+/g, " ").trim().slice(0, 420),
    });
    seen.add(resolvedUrl);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

const SEARCH_PAGE_CHROME_TITLE_PATTERNS = [
  /^(sign in|log in|login)$/i,
  /^(privacy|privacy policy)$/i,
  /^(terms|terms of service|terms of use)$/i,
  /^(settings|preferences)$/i,
  /^(feedback|help|support)$/i,
  /^(advertising|about|all regions)$/i,
];

const SEARCH_PAGE_CHROME_HOST_PATTERNS = [
  /^accounts\.google\.com$/i,
  /^support\.google\.com$/i,
  /^policies\.google\.com$/i,
  /^duckduckgo\.com$/i,
  /^www\.duckduckgo\.com$/i,
  /^lite\.duckduckgo\.com$/i,
  /^bing\.com$/i,
  /^www\.bing\.com$/i,
  /^help\.bing\.com$/i,
  /^search\.yahoo\.com$/i,
  /^www\.search\.yahoo\.com$/i,
];

const SEARCH_RESULT_PORTAL_HOST_PATTERNS = [
  /^google\./i,
  /^www\.google\./i,
  /^bing\.com$/i,
  /^www\.bing\.com$/i,
  /^duckduckgo\.com$/i,
  /^www\.duckduckgo\.com$/i,
  /^lite\.duckduckgo\.com$/i,
  /^search\.yahoo\.com$/i,
  /^www\.search\.yahoo\.com$/i,
];

const SEARCH_PAGE_CHROME_PATH_PATTERNS = [
  /^\/(preferences|settings|account|accounts|privacy|terms|policies|support|help)(\/|$)/i,
  /^\/search(\/|$)/i,
];

function filterLikelySearchResultCandidates(
  rawResults: Array<{ href: string; title: string; snippet: string }>,
  baseUrl: string,
): Array<{ href: string; title: string; snippet: string }> {
  return rawResults.filter((raw) => {
    const title = raw.title.replace(/\s+/g, " ").trim();
    if (!title || SEARCH_PAGE_CHROME_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
      return false;
    }
    const resolvedUrl = normalizeSearchResultUrl(raw.href, baseUrl);
    if (!resolvedUrl) {
      return false;
    }
    try {
      const parsed = new URL(resolvedUrl);
      const hostname = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      if (SEARCH_PAGE_CHROME_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) {
        return false;
      }
      if (SEARCH_PAGE_CHROME_PATH_PATTERNS.some((pattern) => pattern.test(pathname))) {
        return false;
      }
      const snippet = raw.snippet.replace(/\s+/g, " ").trim();
      if (
        !snippet &&
        title.split(/\s+/).length <= 2 &&
        SEARCH_RESULT_PORTAL_HOST_PATTERNS.some((pattern) => pattern.test(hostname))
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  });
}

function normalizeSearchResultUrl(href: string, baseUrl: string): string | undefined {
  if (!href) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(href, baseUrl);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();

  if (host === "duckduckgo.com" || host === "www.duckduckgo.com" || host === "lite.duckduckgo.com") {
    const target = parsed.searchParams.get("uddg");
    return normalizeExternalResultTarget(target);
  }

  if (host === "www.google.com" || host === "google.com") {
    if (parsed.pathname === "/url") {
      return normalizeExternalResultTarget(parsed.searchParams.get("q") ?? parsed.searchParams.get("url"));
    }
    if (parsed.pathname.startsWith("/search") || parsed.pathname.startsWith("/httpservice/")) {
      return undefined;
    }
  }

  if (host === "www.bing.com" || host === "bing.com") {
    if (parsed.pathname.startsWith("/ck/")) {
      return normalizeExternalResultTarget(decodeBingRedirectUrl(parsed.searchParams.get("u")));
    }
    if (parsed.pathname === "/" || parsed.pathname.startsWith("/search")) {
      return undefined;
    }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  return parsed.toString();
}

function normalizeExternalResultTarget(target: string | null | undefined): string | undefined {
  if (!target) {
    return undefined;
  }
  try {
    const decoded = decodeURIComponent(target);
    if (!decoded.startsWith("http://") && !decoded.startsWith("https://")) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

function decodeBingRedirectUrl(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const raw = value.startsWith("a1") ? value.slice(2) : value;
  const decoded = Buffer.from(raw, "base64").toString("utf8").trim();
  if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
    return decoded;
  }
  return normalizeExternalResultTarget(value);
}

function extractSnippetNear(html: string, index: number, maxChars: number): string {
  const window = html.slice(Math.max(0, index), Math.min(html.length, index + 900));
  const stripped = stripHtml(decodeHtmlEntities(window)).replace(/\s+/g, " ").trim();
  return stripped.slice(0, maxChars);
}

function extractHtmlTitle(html: string): string | undefined {
  const matched = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const raw = matched?.[1];
  if (!raw) {
    return undefined;
  }
  const title = stripHtml(decodeHtmlEntities(raw)).replace(/\s+/g, " ").trim();
  return title || undefined;
}

function extractHtmlText(html: string, maxChars: number): string {
  const withoutNoise = stripHtmlNoise(html);
  return stripHtml(decodeHtmlEntities(withoutNoise)).replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function stripHtml(input: string): string {
  return stripHtmlTags(input);
}

function stripHtmlNoise(input: string): string {
  return stripHtmlNoiseTags(input, ["script", "style", "noscript"]);
}

function decodeHtmlEntities(input: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    quot: '"',
    lt: "<",
    gt: ">",
  };
  return input.replace(/&(?:amp|quot|#39|lt|gt|#x27|#x2F|#\d+);/gi, (entity) => {
    const normalized = entity.slice(1, -1).toLowerCase();
    if (normalized.startsWith("#")) {
      if (normalized === "#39" || normalized === "#x27") {
        return "'";
      }
      if (normalized === "#x2f") {
        return "/";
      }
      const numeric = Number(normalized.slice(1));
      return Number.isFinite(numeric) ? String.fromCharCode(numeric) : "";
    }
    return namedEntities[normalized] ?? "";
  });
}

type PlaywrightModule = {
  chromium: {
    launch: (options: { headless: boolean }) => Promise<PlaywrightBrowser>;
  };
};

type PlaywrightContextOptions = {
  locale?: string;
  timezoneId?: string;
  geolocation?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
  extraHTTPHeaders?: Record<string, string>;
  httpCredentials?: {
    username: string;
    password: string;
  };
  storageState?: PlaywrightStorageState;
};

type PlaywrightStorageState = {
  cookies: BrowserCookieRecord[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
};

type PlaywrightBrowser = {
  newContext: (options?: PlaywrightContextOptions) => Promise<PlaywrightContext>;
  close: () => Promise<void>;
};

type PlaywrightContext = {
  newPage: () => Promise<PlaywrightPage>;
  storageState?: () => Promise<PlaywrightStorageState>;
  addInitScript?: (
    fn: (sessionStorageByOrigin: BrowserStorageBucket) => void,
    arg: BrowserStorageBucket,
  ) => Promise<void>;
  grantPermissions?: (permissions: string[], options?: { origin?: string }) => Promise<void>;
};

type PlaywrightPage = {
  route?: (url: string | RegExp, handler: (route: PlaywrightRoute) => Promise<void> | void) => Promise<void>;
  goto: (
    url: string,
    options: { timeout: number; waitUntil: "load" | "domcontentloaded" | "networkidle" },
  ) => Promise<{ status: () => number } | null>;
  setContent?: (html: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" }) => Promise<void>;
  waitForLoadState: (state: "domcontentloaded" | "load" | "networkidle") => Promise<void>;
  waitForSelector: (selector: string, options: { timeout: number }) => Promise<void>;
  waitForTimeout: (timeoutMs: number) => Promise<void>;
  title: () => Promise<string>;
  url: () => string;
  evaluate: <T, Arg>(fn: (arg: Arg) => T, arg: Arg) => Promise<T>;
  locator: (selector: string) => {
    first: () => {
      innerText: (options?: { timeout: number }) => Promise<string>;
      click: (options: { timeout: number }) => Promise<void>;
      fill: (text: string, options: { timeout: number }) => Promise<void>;
      press: (key: string, options: { timeout: number }) => Promise<void>;
    };
  };
  screenshot: (options: { path: string; fullPage: boolean }) => Promise<void>;
  keyboard: {
    press: (key: string) => Promise<void>;
  };
  accessibility?: {
    snapshot: (options?: { interestingOnly?: boolean }) => Promise<AccessibilitySnapshotNode | null>;
  };
};

type PlaywrightRoute = {
  request: () => {
    url: () => string;
  };
  continue: () => Promise<void>;
  abort: (errorCode?: string) => Promise<void>;
};

interface AccessibilitySnapshotNode {
  name?: string;
  value?: string;
  children?: AccessibilitySnapshotNode[];
}
