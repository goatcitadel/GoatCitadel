import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";

const mocked = vi.hoisted(() => ({
  launch: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: mocked.launch,
  },
}));

vi.mock("node:child_process", () => ({
  spawnSync: mocked.spawnSync,
}));

import { describeBrowserSessionState, executeBrowserTool, isBrowserToolName } from "./browser-tools.js";

const EXAMPLE_HOST = new URL("https://example.com").hostname;
const DUCKDUCKGO_HOST = new URL("https://duckduckgo.com").hostname;
const LITE_DUCKDUCKGO_HOST = new URL("https://lite.duckduckgo.com").hostname;
const GOOGLE_HOST = new URL("https://www.google.com").hostname;
const BING_HOST = new URL("https://www.bing.com").hostname;

function createConfig(root: string): ToolPolicyConfig {
  return {
    profiles: {
      minimal: ["browser.*"],
    },
    tools: {
      profile: "minimal",
      allow: [],
      deny: [],
    },
    agents: {},
    sandbox: {
      writeJailRoots: [root],
      readOnlyRoots: [root],
      networkAllowlist: [
        EXAMPLE_HOST,
        DUCKDUCKGO_HOST,
        LITE_DUCKDUCKGO_HOST,
        GOOGLE_HOST,
        BING_HOST,
        "127.0.0.1",
        "127.0.0.1:11434",
        "127.0.0.1:3002",
      ],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function createPlaywrightStub() {
  let currentUrl = "https://example.com/start";
  let cookies: Array<Record<string, unknown>> = [];
  let localStorageByOrigin: Record<string, Record<string, string>> = {};
  const sessionStorageByOrigin: Record<string, Record<string, string>> = {};
  let pendingSessionStorageByOrigin: Record<string, Record<string, string>> = {};
  const page = {
    goto: async (url: string) => {
      currentUrl = url;
      const origin = new URL(currentUrl).origin;
      const seededSessionStorage = pendingSessionStorageByOrigin[origin];
      if (seededSessionStorage) {
        sessionStorageByOrigin[origin] = { ...seededSessionStorage };
      }
      return { status: () => 200 };
    },
    waitForLoadState: async () => undefined,
    waitForSelector: async () => undefined,
    waitForTimeout: async () => undefined,
    setContent: async () => undefined,
    title: async () => "Austin Weather | 72°F Sunny",
    url: () => currentUrl,
    evaluate: async (fn: unknown, arg: unknown) => {
      const source = String(fn);
      if (source.includes("window.sessionStorage")) {
        return { ...(sessionStorageByOrigin[new URL(currentUrl).origin] ?? {}) };
      }

      const maxItems = Number(arg ?? 0);
      const out = [];
      for (let i = 0; i < Number(maxItems); i += 1) {
        out.push({
          title: `Result ${i + 1}`,
          href: `https://example.com/${i + 1}`,
          snippet: `Snippet ${i + 1}`,
        });
      }
      return out;
    },
    locator: (_selector: string) => ({
      first: () => ({
        innerText: async () => "72°F Sunny in Austin",
        click: async () => undefined,
        fill: async () => undefined,
        press: async () => undefined,
      }),
    }),
    screenshot: async (options: { path: string }) => {
      await fs.writeFile(options.path, "png", "utf8");
    },
    keyboard: {
      press: async () => undefined,
    },
    accessibility: {
      snapshot: async () => ({
        name: "Austin 72°F sunny",
        children: [{ name: "Current conditions clear skies" }],
      }),
    },
  };
  const context = {
    addInitScript: async (_fn: unknown, arg: Record<string, Record<string, string>>) => {
      pendingSessionStorageByOrigin = Object.fromEntries(
        Object.entries(arg).map(([origin, entries]) => [origin, { ...entries }]),
      );
    },
    grantPermissions: async () => undefined,
    newPage: async () => page,
    storageState: async () => ({
      cookies: cookies.map((cookie) => ({ ...cookie })),
      origins: Object.entries(localStorageByOrigin).map(([origin, entries]) => ({
        origin,
        localStorage: Object.entries(entries).map(([name, value]) => ({ name, value })),
      })),
    }),
  };
  const browser = {
    newContext: async (options?: {
      storageState?: {
        cookies?: Array<Record<string, unknown>>;
        origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
      };
    }) => {
      cookies = (options?.storageState?.cookies ?? []).map((cookie) => ({ ...cookie }));
      localStorageByOrigin = Object.fromEntries(
        (options?.storageState?.origins ?? []).map((originRecord) => [
          originRecord.origin,
          Object.fromEntries((originRecord.localStorage ?? []).map((entry) => [entry.name, entry.value])),
        ]),
      );
      return context;
    },
    close: async () => undefined,
  };
  return browser;
}

function createSearchPlaywrightStub(
  resolveResults: (url: string) => Array<{ href: string; title: string; snippet: string }>,
) {
  let currentUrl = "https://example.com/start";
  const page = {
    goto: async (url: string) => {
      currentUrl = url;
      return { status: () => 200 };
    },
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    title: async () => `Search results for ${currentUrl}`,
    url: () => currentUrl,
    evaluate: async (_fn: unknown, _maxItems: number) => resolveResults(currentUrl),
  };
  const context = {
    newPage: async () => page,
  };
  const browser = {
    newContext: async () => context,
    close: async () => undefined,
  };
  return browser;
}

describe("browser tools coverage sweep", () => {
  const priorFetch = globalThis.fetch;
  let tempRoot = "";

  beforeEach(async () => {
    mocked.launch.mockReset();
    mocked.spawnSync.mockReset();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "browser-tools-coverage-"));
    mocked.launch.mockResolvedValue(createPlaywrightStub() as never);
    mocked.spawnSync.mockImplementation((command: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === "--version") {
        return { status: 0, stdout: "10.29.3", stderr: "" };
      }
      if (Array.isArray(args) && args.join(" ") === "exec playwright install chromium") {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected spawnSync call in test: ${command} ${(args ?? []).join(" ")}`);
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          [
            '<a href="https://example.com/a">Result A</a>',
            '<a href="/l/?uddg=https%3A%2F%2Fexample.com%2Fb">Result B</a>',
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        ),
    ) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = priorFetch;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("recognizes browser tool names", () => {
    expect(isBrowserToolName("browser.search")).toBe(true);
    expect(isBrowserToolName("browser.navigate")).toBe(true);
    expect(isBrowserToolName("browser.extract")).toBe(true);
    expect(isBrowserToolName("browser.screenshot")).toBe(true);
    expect(isBrowserToolName("browser.interact")).toBe(true);
    expect(isBrowserToolName("browser.cookies.get")).toBe(true);
    expect(isBrowserToolName("browser.storage.set")).toBe(true);
    expect(isBrowserToolName("browser.context.configure")).toBe(true);
    expect(isBrowserToolName("shell.exec")).toBe(false);
  });

  it("blocks Playwright navigation redirects to private hosts before request continuation", async () => {
    const config = createConfig(tempRoot);
    config.sandbox.networkAllowlist = [EXAMPLE_HOST];
    const abortedUrls: string[] = [];
    const continuedUrls: string[] = [];
    let routeHandler:
      | ((route: {
          request: () => { url: () => string };
          continue: () => Promise<void>;
          abort: (errorCode?: string) => Promise<void>;
        }) => Promise<void> | void)
      | undefined;
    const routeFor = (url: string) => ({
      request: () => ({ url: () => url }),
      continue: async () => {
        continuedUrls.push(url);
      },
      abort: async () => {
        abortedUrls.push(url);
      },
    });
    const page = {
      route: async (_pattern: string, handler: NonNullable<typeof routeHandler>) => {
        routeHandler = handler;
      },
      goto: async (url: string) => {
        await routeHandler?.(routeFor(url));
        await routeHandler?.(routeFor("http://127.0.0.1/private"));
        return { status: () => 200 };
      },
      waitForLoadState: async () => undefined,
      waitForSelector: async () => undefined,
      waitForTimeout: async () => undefined,
      title: async () => "redirected",
      url: () => "http://127.0.0.1/private",
      evaluate: async () => "",
      locator: () => ({ first: () => ({ innerText: async () => "", click: async () => undefined }) }),
      screenshot: async () => undefined,
      keyboard: { press: async () => undefined },
    };
    mocked.launch.mockResolvedValueOnce({
      newContext: async () => ({
        newPage: async () => page,
      }),
      close: async () => undefined,
    } as never);

    await expect(
      executeBrowserTool(
        "browser.screenshot",
        { url: "https://example.com/start", outputPath: path.join(tempRoot, "redirect.png") },
        config,
      ),
    ).rejects.toThrow(/Private|loopback|reserved/i);
    expect(continuedUrls).toEqual(["https://example.com/start"]);
    expect(abortedUrls).toEqual(["http://127.0.0.1/private"]);
  });

  it("blocks native HTML fetch redirects to private hosts", async () => {
    const config = createConfig(tempRoot);
    config.sandbox.networkAllowlist = [EXAMPLE_HOST];
    mocked.launch.mockRejectedValueOnce(new Error("missing browser runtime"));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://example.com/start") {
        return new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
      }
      throw new Error(`Unexpected private follow ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(executeBrowserTool("browser.navigate", { url: "https://example.com/start" }, config)).rejects.toThrow(
      /Private|loopback|reserved/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks native HTML fetch redirects outside matched grant hosts before following them", async () => {
    const config = createConfig(tempRoot);
    config.sandbox.networkAllowlist = [EXAMPLE_HOST, "other.example"];
    mocked.launch.mockRejectedValueOnce(new Error("missing browser runtime"));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://example.com/start") {
        return new Response("", {
          status: 302,
          headers: { location: "https://other.example/final" },
        });
      }
      throw new Error(`Unexpected grant-bypassing follow ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      executeBrowserTool("browser.navigate", { url: "https://example.com/start" }, config, {
        matchedGrantAllowedHosts: [EXAMPLE_HOST],
      }),
    ).rejects.toThrow(/not yet allowlisted/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("executes search/navigate/extract/screenshot/interact flows", async () => {
    const config = createConfig(tempRoot);

    const search = await executeBrowserTool(
      "browser.search",
      { query: "goatcitadel", engine: "duckduckgo", limit: 2 },
      config,
    );
    expect(search.action).toBe("search");
    expect(Array.isArray(search.results)).toBe(true);

    const nav = await executeBrowserTool(
      "browser.navigate",
      { url: "https://example.com/weather", maxChars: 900 },
      config,
    );
    expect(nav.action).toBe("navigate");
    expect(String(nav.textSnippet)).toContain("72");

    const extracted = await executeBrowserTool(
      "browser.extract",
      { url: "https://example.com/weather", selector: "body", maxChars: 1200 },
      config,
    );
    expect(extracted.action).toBe("extract");
    expect(String(extracted.text)).toContain("72");

    const screenshotPath = path.join(tempRoot, "shots", "coverage.png");
    const screenshot = await executeBrowserTool(
      "browser.screenshot",
      { url: "https://example.com/weather", outputPath: screenshotPath, fullPage: true },
      config,
    );
    expect(screenshot.action).toBe("screenshot");
    await expect(fs.access(screenshotPath)).resolves.toBeUndefined();

    const interactPath = path.join(tempRoot, "shots", "interact.png");
    const interact = await executeBrowserTool(
      "browser.interact",
      {
        url: "https://example.com/form",
        finalSelector: "body",
        outputPath: interactPath,
        steps: [
          { action: "click", selector: "#start" },
          { action: "type", selector: "#q", text: "coverage" },
          { action: "press", selector: "#q", key: "Enter" },
          { action: "press", key: "Escape" },
          { action: "wait_for_selector", selector: "#done" },
          { action: "wait", timeoutMs: 10 },
        ],
      },
      config,
    );
    expect(interact.action).toBe("interact");
    expect(interact.stepsExecuted).toBe(6);
    await expect(fs.access(interactPath)).resolves.toBeUndefined();
  });

  it("rejects empty and malformed browser interaction steps before launching", async () => {
    const config = createConfig(tempRoot);

    await expect(
      executeBrowserTool("browser.interact", { url: "https://example.com/form", steps: [] }, config),
    ).rejects.toThrow(/non-empty steps array/i);
    await expect(
      executeBrowserTool("browser.interact", { url: "https://example.com/form", steps: ["bad"] }, config),
    ).rejects.toThrow(/step must be an object/i);
    await expect(
      executeBrowserTool("browser.interact", { url: "https://example.com/form", steps: [{ action: "click" }] }, config),
    ).rejects.toThrow(/click step requires selector/i);
  });

  it("uses fallback parsing when playwright is unavailable for browser.search", async () => {
    const config = createConfig(tempRoot);
    mocked.launch.mockRejectedValueOnce(new Error("missing browser runtime"));

    const response = await executeBrowserTool(
      "browser.search",
      { query: "coverage", engine: "duckduckgo", limit: 3 },
      config,
    );
    expect(response.fallbackUsed).toBe(true);
    expect(Array.isArray(response.results)).toBe(true);
    expect((response.results as Array<unknown>).length).toBeGreaterThan(0);
  });

  it("normalizes DuckDuckGo redirect-style search results when playwright is available", async () => {
    const config = createConfig(tempRoot);
    mocked.launch.mockResolvedValueOnce(
      createSearchPlaywrightStub(() => [
        {
          href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle-a",
          title: "Article A",
          snippet: "Snippet A",
        },
        {
          href: "/l/?uddg=https%3A%2F%2Fexample.com%2Farticle-b",
          title: "Article B",
          snippet: "Snippet B",
        },
      ]) as never,
    );

    const response = await executeBrowserTool(
      "browser.search",
      { query: "Kristi Noem latest news", engine: "duckduckgo", limit: 2 },
      config,
    );

    expect(response.fallbackUsed).toBe(false);
    expect(response.engine).toBe("duckduckgo");
    expect(response.results).toEqual([
      { title: "Article A", url: "https://example.com/article-a", snippet: "Snippet A" },
      { title: "Article B", url: "https://example.com/article-b", snippet: "Snippet B" },
    ]);
  });

  it("executes the browser search page-evaluator against a DOM-like page", async () => {
    const config = createConfig(tempRoot);
    const globalWithDocument = globalThis as unknown as { document?: unknown };
    const priorDocument = globalWithDocument.document;
    const anchors = [
      {
        getAttribute: (name: string) => (name === "href" ? "javascript:alert(1)" : undefined),
        textContent: "Skip script",
        closest: () => ({ textContent: "Skip script" }),
      },
      {
        getAttribute: (name: string) => (name === "href" ? "https://example.com/dom-result" : undefined),
        textContent: " DOM Result ",
        closest: () => ({ textContent: "DOM Result snippet text" }),
      },
      {
        getAttribute: (name: string) => (name === "href" ? "https://example.com/dom-result" : undefined),
        textContent: "Duplicate Result",
        closest: () => ({ textContent: "Duplicate" }),
      },
      {
        getAttribute: (name: string) => (name === "href" ? "https://example.com/empty-title" : undefined),
        textContent: "   ",
        closest: () => ({ textContent: "Empty title" }),
      },
    ];
    globalWithDocument.document = {
      querySelector: (selector: string) =>
        selector === "main"
          ? {
              querySelectorAll: () => anchors,
            }
          : null,
      querySelectorAll: () => anchors,
    };
    try {
      mocked.launch.mockResolvedValueOnce({
        newContext: async () => ({
          newPage: async () => ({
            goto: async (url: string) => ({ status: () => (url ? 200 : undefined) }),
            waitForLoadState: async () => undefined,
            waitForTimeout: async () => undefined,
            evaluate: async (fn: unknown, arg: unknown) => (fn as (maxItems: number) => unknown)(Number(arg ?? 0)),
            url: () => "https://lite.duckduckgo.com/lite/?q=coverage",
            title: async () => "Search",
          }),
        }),
        close: async () => undefined,
      } as never);

      const response = await executeBrowserTool(
        "browser.search",
        { query: "coverage", engine: "duckduckgo", limit: 2 },
        config,
      );

      expect(response.results).toEqual([
        {
          title: "DOM Result",
          url: "https://example.com/dom-result",
          snippet: "DOM Result snippet text",
        },
      ]);
    } finally {
      globalWithDocument.document = priorDocument;
    }
  });

  it("uses unscoped DOM anchors and stops page search extraction at the evaluator limit", async () => {
    const config = createConfig(tempRoot);
    const globalWithDocument = globalThis as unknown as { document?: unknown };
    const priorDocument = globalWithDocument.document;
    const anchors = Array.from({ length: 90 }, (_unused, index) => ({
      getAttribute: (name: string) => (name === "href" ? `https://example.com/result-${index}` : undefined),
      textContent: `Result ${index}`,
      closest: () => ({ textContent: `Result ${index} snippet` }),
    }));
    globalWithDocument.document = {
      querySelector: () => null,
      querySelectorAll: () => anchors,
    };
    try {
      mocked.launch.mockResolvedValueOnce({
        newContext: async () => ({
          newPage: async () => ({
            goto: async () => ({ status: () => 200 }),
            waitForLoadState: async () => undefined,
            waitForTimeout: async () => undefined,
            evaluate: async (fn: unknown, arg: unknown) => (fn as (maxItems: number) => unknown)(Number(arg)),
            url: () => "https://lite.duckduckgo.com/lite/?q=coverage",
            title: async () => "Search",
          }),
        }),
        close: async () => undefined,
      } as never);

      const response = await executeBrowserTool("browser.search", { query: "coverage", limit: 1 }, config);

      expect(response.results).toEqual([
        {
          title: "Result 0",
          url: "https://example.com/result-0",
          snippet: "Result 0 snippet",
        },
      ]);
    } finally {
      globalWithDocument.document = priorDocument;
    }
  });

  it("falls back from empty DuckDuckGo results to Bing and decodes Bing redirect targets", async () => {
    const config = createConfig(tempRoot);
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body><p>No usable results</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    mocked.launch.mockResolvedValue(
      createSearchPlaywrightStub((url) => {
        if (new URL(url).hostname === LITE_DUCKDUCKGO_HOST) {
          return [];
        }
        if (new URL(url).hostname === BING_HOST) {
          return [
            {
              href: "https://www.bing.com/ck/a?!&u=a1aHR0cHM6Ly93d3cuYmJjLmNvbS9uZXdzL2xpdmUvY2pkOXk0azU1ODN0",
              title: "BBC result",
              snippet: "BBC snippet",
            },
          ];
        }
        return [];
      }) as never,
    );

    const response = await executeBrowserTool("browser.search", { query: "Kristi Noem latest news", limit: 2 }, config);

    expect(response.engine).toBe("bing");
    expect(response.attemptedEngines).toEqual(["duckduckgo", "bing"]);
    expect(response.fallbackUsed).toBe(false);
    expect(response.results).toEqual([
      {
        title: "BBC result",
        url: "https://www.bbc.com/news/live/cjd9y4k5583t",
        snippet: "BBC snippet",
      },
    ]);
  });

  it("continues search fallback attempts when an engine fetch throws", async () => {
    const config = createConfig(tempRoot);
    mocked.launch.mockResolvedValue(createSearchPlaywrightStub(() => []) as never);
    globalThis.fetch = vi.fn(async (input) => {
      const hostname = new URL(String(input)).hostname;
      if (hostname === LITE_DUCKDUCKGO_HOST) {
        throw new Error("duck fetch failed");
      }
      if (hostname === BING_HOST) {
        return new Response('<a href="https://example.com/bing-fallback">Bing Fallback</a>', {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const response = await executeBrowserTool("browser.search", { query: "coverage", limit: 2 }, config);

    expect(response).toMatchObject({
      engine: "bing",
      fallbackUsed: true,
      results: [
        {
          title: "Bing Fallback",
          url: "https://example.com/bing-fallback",
        },
      ],
    });
  });

  it("filters obvious search-page chrome links before returning browser search results", async () => {
    const config = createConfig(tempRoot);
    mocked.launch.mockResolvedValueOnce(
      createSearchPlaywrightStub(() => [
        {
          href: "https://accounts.google.com/signin",
          title: "Sign in",
          snippet: "",
        },
        {
          href: "https://policies.google.com/privacy",
          title: "Privacy",
          snippet: "",
        },
        {
          href: "https://www.bbc.com/news/articles/cx2xexample",
          title: "Kristi Noem latest news",
          snippet: "Coverage summary",
        },
      ]) as never,
    );

    const response = await executeBrowserTool(
      "browser.search",
      { query: "Kristi Noem latest news", engine: "google", limit: 3 },
      config,
    );

    expect(response.results).toEqual([
      {
        title: "Kristi Noem latest news",
        url: "https://www.bbc.com/news/articles/cx2xexample",
        snippet: "Coverage summary",
      },
    ]);
  });

  it("normalizes and filters search-result URL edge cases from browser results", async () => {
    const config = createConfig(tempRoot);
    const bingTarget = Buffer.from("https://example.com/bing-decoded", "utf8").toString("base64");
    mocked.launch.mockResolvedValueOnce(
      createSearchPlaywrightStub(() => [
        { href: "", title: "Missing href", snippet: "" },
        { href: "://bad", title: "Bad URL", snippet: "" },
        { href: "https://example.com/duplicate", title: "Duplicate A", snippet: "A" },
        { href: "https://example.com/duplicate", title: "Duplicate B", snippet: "B" },
        {
          href: "https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fgoogle-target",
          title: "Google Target",
          snippet: "G",
        },
        { href: "https://www.google.com/search?q=coverage", title: "Google Search", snippet: "chrome" },
        { href: "https://accounts.google.com/home", title: "Account Home", snippet: "chrome" },
        { href: "https://example.com/search/results", title: "Search Path", snippet: "chrome" },
        { href: "https://google.co.uk/news", title: "News", snippet: "" },
        { href: "http://[::1", title: "Invalid Absolute", snippet: "bad" },
        { href: "https://www.google.com/httpservice/retry", title: "Google Service", snippet: "chrome" },
        { href: "https://duckduckgo.com/l/?q=missing-target", title: "Duck Missing", snippet: "missing" },
        { href: "https://duckduckgo.com/l/?uddg=notaurl", title: "Duck Non Http", snippet: "non-http" },
        { href: "https://duckduckgo.com/l/?uddg=http%3A%2F%2F%25", title: "Duck Invalid URL", snippet: "invalid" },
        { href: "https://duckduckgo.com/l/?uddg=https%3A%2F%2F", title: "Duck Incomplete URL", snippet: "invalid" },
        { href: `https://www.bing.com/ck/a?u=a1${bingTarget}`, title: "Bing Target", snippet: "Bing" },
        { href: "https://www.bing.com/ck/a", title: "Bing Missing", snippet: "missing" },
        { href: "https://www.bing.com/ck/a?u=%%%bad", title: "Bing Bad", snippet: "bad" },
        { href: "https://www.bing.com/search?q=coverage", title: "Bing Search", snippet: "chrome" },
        { href: "https://www.bing.com/", title: "Bing Home", snippet: "chrome" },
        { href: "ftp://example.com/file", title: "FTP", snippet: "ftp" },
        { href: "https://www.google.com/preferences", title: "Preferences", snippet: "" },
        { href: "https://www.google.com/maps", title: "Maps", snippet: "" },
        { href: "https://example.com/relative", title: "Relative", snippet: "Relative snippet" },
      ]) as never,
    );

    const response = await executeBrowserTool(
      "browser.search",
      { query: "coverage", engine: "yahoo", backend: "weird", limit: 5 },
      config,
    );

    expect(response.results).toEqual([
      { title: "Duplicate A", url: "https://example.com/duplicate", snippet: "A" },
      { title: "Google Target", url: "https://example.com/google-target", snippet: "G" },
      { title: "Bing Target", url: "https://example.com/bing-decoded", snippet: "Bing" },
      { title: "Relative", url: "https://example.com/relative", snippet: "Relative snippet" },
    ]);
  });

  it("fails when every search engine returns no usable results", async () => {
    const config = createConfig(tempRoot);
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body><p>No usable results</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    mocked.launch.mockResolvedValue(createSearchPlaywrightStub(() => []) as never);

    await expect(
      executeBrowserTool("browser.search", { query: "Kristi Noem latest news", limit: 2 }, config),
    ).rejects.toThrow(/browser\.search failed/i);
  });

  it("uses the Ollama search backend when configured", async () => {
    const config = createConfig(tempRoot);
    mocked.launch.mockResolvedValueOnce(
      createSearchPlaywrightStub(() => [
        {
          href: "https://example.com/result-a",
          title: "Result A",
          snippet: "Snippet A",
        },
      ]) as never,
    );
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/generate")) {
        expect(init).toHaveProperty("dispatcher");
        return new Response(JSON.stringify({ response: "Local summary from Ollama." }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const response = await executeBrowserTool(
      "browser.search",
      { query: "coverage", engine: "duckduckgo", backend: "ollama" },
      config,
    );

    expect(response.backend).toBe("native");
    expect(response.summaryBackend).toBe("ollama");
    expect(response.summaryBackendUsed).toBe(true);
    expect(response.summary).toBe("Local summary from Ollama.");
  });

  it("keeps search results when Ollama responds unsuccessfully or without a summary", async () => {
    const config = createConfig(tempRoot);
    process.env.OLLAMA_HOST = "http://127.0.0.1:11434/";
    mocked.launch.mockResolvedValue(
      createSearchPlaywrightStub(() => [
        {
          href: "https://example.com/result-a",
          title: "Result A",
          snippet: "Snippet A",
        },
      ]) as never,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 500, statusText: "Backend Down" }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ response: "   " }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const failed = await executeBrowserTool(
        "browser.search",
        { query: "coverage", engine: "bing", backend: "ollama" },
        config,
      );
      expect(failed).toMatchObject({
        engine: "bing",
        summaryBackendUsed: false,
      });
      expect(String(failed.backendWarning)).toContain("500 Backend Down");

      const empty = await executeBrowserTool(
        "browser.search",
        {
          query: "coverage",
          engine: "bing",
          backend: "ollama",
          ollamaUrl: "http://127.0.0.1:11434/api/generate",
        },
        config,
      );
      expect(empty).toMatchObject({
        summaryBackendUsed: false,
      });
      expect(String(empty.backendWarning)).toContain("returned no summary");
    } finally {
      delete process.env.OLLAMA_HOST;
    }
  });

  it("keeps browser search results when the Ollama backend is unavailable", async () => {
    const config = createConfig(tempRoot);
    mocked.launch.mockResolvedValueOnce(
      createSearchPlaywrightStub(() => [
        {
          href: "https://example.com/result-a",
          title: "Result A",
          snippet: "Snippet A",
        },
      ]) as never,
    );
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/api/generate")) {
        throw new Error("connection refused");
      }
      return new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const response = await executeBrowserTool(
      "browser.search",
      { query: "coverage", engine: "duckduckgo", backend: "ollama" },
      config,
    );

    expect(response.backend).toBe("native");
    expect(response.summaryBackend).toBe("ollama");
    expect(response.summaryBackendUsed).toBe(false);
    expect(response.backendWarning).toContain("connection refused");
    expect(response.results).toEqual([
      {
        title: "Result A",
        url: "https://example.com/result-a",
        snippet: "Snippet A",
      },
    ]);
  });

  it("uses Firecrawl for search, navigate, and extract when requested", async () => {
    const config = createConfig(tempRoot);
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v2/search")) {
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({
            data: [{ url: "https://example.com/firecrawl-a", title: "Firecrawl A", description: "Snippet A" }],
            summary: "Firecrawl summary",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.endsWith("/v2/scrape")) {
        return new Response(
          JSON.stringify({
            data: {
              markdown: "# Firecrawl Page\n\nCoverage text from markdown.",
              html: "<html><head><title>Firecrawl Page</title></head><body><main>Coverage text from html.</main></body></html>",
              metadata: {
                title: "Firecrawl Page",
                sourceURL: "https://example.com/firecrawl-page",
                statusCode: 200,
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as unknown as typeof fetch;

    const search = await executeBrowserTool(
      "browser.search",
      { query: "coverage", backend: "firecrawl", firecrawlBaseUrl: "http://127.0.0.1:3002" },
      config,
    );
    expect(search.backend).toBe("firecrawl");
    expect(search.backendUsed).toBe(true);
    expect(search.results).toEqual([
      { title: "Firecrawl A", url: "https://example.com/firecrawl-a", snippet: "Snippet A" },
    ]);

    const navigate = await executeBrowserTool(
      "browser.navigate",
      { url: "https://example.com/firecrawl-page", backend: "firecrawl", firecrawlBaseUrl: "http://127.0.0.1:3002" },
      config,
    );
    expect(navigate.backend).toBe("firecrawl");
    expect(navigate.extractionMode).toBe("firecrawl-markdown");
    expect(String(navigate.textSnippet)).toContain("Coverage text");

    const extract = await executeBrowserTool(
      "browser.extract",
      {
        url: "https://example.com/firecrawl-page",
        selector: "main",
        backend: "firecrawl",
        firecrawlBaseUrl: "http://127.0.0.1:3002",
      },
      config,
    );
    expect(extract.backend).toBe("firecrawl");
    expect(extract.extractionMode).toBe("firecrawl-html-selector");
  });

  it("rejects Firecrawl-reported final URLs on private hosts", async () => {
    const config = createConfig(tempRoot);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              markdown: "private content must not be returned",
              metadata: {
                title: "Private",
                sourceURL: "http://127.0.0.1/private",
                statusCode: 200,
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;

    await expect(
      executeBrowserTool(
        "browser.navigate",
        {
          url: "https://example.com/firecrawl-page",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1:3002",
          firecrawlFallbackToNative: false,
        },
        config,
      ),
    ).rejects.toThrow(/Private, metadata, or reserved host is blocked/);
  });

  it("rejects Firecrawl final URLs outside matched grant host constraints", async () => {
    const config = createConfig(tempRoot);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              markdown: "grant-blocked content must not be returned",
              metadata: {
                title: "Other host",
                sourceURL: "https://other.example/final",
                statusCode: 200,
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;

    await expect(
      executeBrowserTool(
        "browser.navigate",
        {
          url: "https://example.com/firecrawl-page",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1:3002",
          firecrawlFallbackToNative: false,
        },
        {
          ...config,
          sandbox: { ...config.sandbox, networkAllowlist: [...config.sandbox.networkAllowlist, "other.example"] },
        },
        { matchedGrantAllowedHosts: ["example.com"] },
      ),
    ).rejects.toThrow(/not yet allowlisted/i);
  });

  it("rejects Firecrawl content without final source proof under matched grant host constraints", async () => {
    const config = createConfig(tempRoot);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              markdown: "unproved content must not be returned",
              metadata: {
                title: "Missing source",
                statusCode: 200,
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;

    await expect(
      executeBrowserTool(
        "browser.navigate",
        {
          url: "https://example.com/firecrawl-page",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1:3002",
          firecrawlFallbackToNative: false,
        },
        config,
        { matchedGrantAllowedHosts: ["example.com"] },
      ),
    ).rejects.toThrow(/did not report a final source URL/i);
  });

  it("rejects unsafe Firecrawl scrape targets before delegating to Firecrawl", async () => {
    const config = createConfig(tempRoot);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      executeBrowserTool(
        "browser.navigate",
        {
          url: "file:///etc/passwd",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1:3002",
          firecrawlFallbackToNative: false,
        },
        config,
      ),
    ).rejects.toThrow(/Unsupported URL protocol for browser tool: file:/i);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      executeBrowserTool(
        "browser.navigate",
        {
          url: "http://169.254.169.254/latest/meta-data",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1:3002",
          firecrawlFallbackToNative: false,
        },
        config,
      ),
    ).rejects.toThrow(/Private|reserved|metadata/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not read Firecrawl API keys from non-Firecrawl env-name input", async () => {
    const priorOpenAi = process.env.OPENAI_API_KEY;
    const priorFirecrawl = process.env.FIRECRAWL_API_KEY;
    try {
      process.env.OPENAI_API_KEY = "openai-secret";
      delete process.env.FIRECRAWL_API_KEY;
      const config = createConfig(tempRoot);
      globalThis.fetch = vi.fn(async (_input, init) => {
        expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      await executeBrowserTool(
        "browser.search",
        {
          query: "coverage",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1:3002",
          firecrawlApiKeyEnv: "OPENAI_API_KEY",
        },
        config,
      );
    } finally {
      if (priorOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = priorOpenAi;
      }
      if (priorFirecrawl === undefined) {
        delete process.env.FIRECRAWL_API_KEY;
      } else {
        process.env.FIRECRAWL_API_KEY = priorFirecrawl;
      }
    }
  });

  it("rejects non-canonical loopback Firecrawl browser base URLs", async () => {
    const config = createConfig(tempRoot);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      executeBrowserTool(
        "browser.search",
        {
          query: "coverage",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1:9999",
          firecrawlFallbackToNative: false,
        },
        config,
      ),
    ).rejects.toThrow(/Private|reserved|metadata/i);
    await expect(
      executeBrowserTool(
        "browser.search",
        {
          query: "coverage",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1",
          firecrawlFallbackToNative: false,
        },
        config,
      ),
    ).rejects.toThrow(/Private|reserved|metadata/i);
    await expect(
      executeBrowserTool(
        "browser.navigate",
        {
          url: "https://example.com/article",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://localhost:9999",
          firecrawlFallbackToNative: false,
        },
        config,
      ),
    ).rejects.toThrow(/Private|reserved|metadata/i);
    await expect(
      executeBrowserTool(
        "browser.navigate",
        {
          url: "https://example.com/article",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://localhost:80",
          firecrawlFallbackToNative: false,
        },
        config,
      ),
    ).rejects.toThrow(/Private|reserved|metadata/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws Firecrawl errors when fallback is disabled", async () => {
    const config = createConfig(tempRoot);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "firecrawl down" }), {
          status: 503,
          statusText: "Unavailable",
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      executeBrowserTool(
        "browser.search",
        {
          query: "coverage",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1:3002",
          firecrawlFallbackToNative: false,
        },
        config,
      ),
    ).rejects.toThrow(/Firecrawl search failed/i);
    await expect(
      executeBrowserTool(
        "browser.navigate",
        {
          url: "https://example.com/article",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1:3002",
          firecrawlFallbackToNative: "false",
        },
        config,
      ),
    ).rejects.toThrow(/Firecrawl scrape failed/i);
    await expect(
      executeBrowserTool(
        "browser.extract",
        {
          url: "https://example.com/article",
          selector: "main",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1:3002",
          firecrawlFallbackToNative: false,
        },
        config,
      ),
    ).rejects.toThrow(/Firecrawl scrape failed/i);
  });

  it("falls back from Firecrawl selector extraction when the HTML page adapter is incomplete", async () => {
    const config = createConfig(tempRoot);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              html: "<html><head><title>Firecrawl Fallback</title></head><body><main>Selector text</main></body></html>",
              metadata: {
                sourceURL: "https://example.com/firecrawl-selector",
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;
    mocked.launch.mockResolvedValueOnce({
      newContext: async () => ({
        newPage: async () => ({
          locator: () => ({
            first: () => ({
              innerText: async () => "unused",
            }),
          }),
        }),
      }),
      close: async () => undefined,
    } as never);

    const result = await executeBrowserTool(
      "browser.extract",
      {
        url: "https://example.com/firecrawl-selector",
        selector: "main",
        backend: "firecrawl",
        firecrawlBaseUrl: "http://127.0.0.1:3002",
      },
      config,
    );

    expect(result).toMatchObject({
      extractionMode: "firecrawl-html-body-fallback",
    });
    expect(String(result.text)).toContain("Selector text");
  });

  it("normalizes empty Firecrawl search payloads as empty result sets", async () => {
    const config = createConfig(tempRoot);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const result = await executeBrowserTool(
      "browser.search",
      { query: "coverage", backend: "firecrawl", firecrawlBaseUrl: "http://127.0.0.1:3002" },
      config,
    );

    expect(result).toMatchObject({
      backend: "firecrawl",
      results: [],
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3002/v2/search",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("filters Firecrawl search results through runtime and grant host boundaries", async () => {
    const config = createConfig(tempRoot);
    config.sandbox.networkAllowlist.push("allowed.example");
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { title: "Allowed", url: "https://allowed.example/docs", description: "Allowed result" },
              { title: "Blocked", url: "https://other.example/docs", description: "Blocked result" },
              { title: "Private", url: "http://169.254.169.254/latest", description: "Private result" },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;

    const result = await executeBrowserTool(
      "browser.search",
      { query: "coverage", backend: "firecrawl", firecrawlBaseUrl: "http://127.0.0.1:3002", limit: 5 },
      config,
      { matchedGrantAllowedHosts: ["allowed.example"] },
    );

    expect(result.results).toEqual([
      { title: "Allowed", url: "https://allowed.example/docs", snippet: "Allowed result" },
    ]);
  });

  it("filters native search results through grant host and private-host boundaries", async () => {
    const config = createConfig(tempRoot);
    config.sandbox.networkAllowlist.push("allowed.example", "other.example");
    mocked.launch.mockResolvedValueOnce(
      createSearchPlaywrightStub(() => [
        { title: "Blocked first", href: "https://other.example/docs", snippet: "Blocked result" },
        { title: "Allowed", href: "https://allowed.example/docs", snippet: "Allowed result" },
        { title: "Private", href: "http://169.254.169.254/latest", snippet: "Private result" },
      ]) as never,
    );

    const result = await executeBrowserTool(
      "browser.search",
      { query: "coverage", engine: "duckduckgo", limit: 5 },
      config,
      { matchedGrantAllowedHosts: ["allowed.example"] },
    );

    expect(result.results).toEqual([
      { title: "Allowed", url: "https://allowed.example/docs", snippet: "Allowed result" },
    ]);
  });

  it("falls back to native browser reads when Firecrawl fails and fallback is enabled", async () => {
    const config = createConfig(tempRoot);
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v2/search")) {
        return new Response("boom", { status: 503 });
      }
      return new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    mocked.launch.mockResolvedValueOnce(
      createSearchPlaywrightStub(() => [
        { href: "https://example.com/fallback", title: "Fallback Result", snippet: "Fallback snippet" },
      ]) as never,
    );

    const response = await executeBrowserTool(
      "browser.search",
      {
        query: "coverage",
        backend: "firecrawl",
        firecrawlBaseUrl: "http://127.0.0.1:3002",
        firecrawlFallbackToNative: true,
      },
      config,
    );

    expect(response.backend).toBe("firecrawl");
    expect(response.backendUsed).toBe(false);
    expect(response.fallbackUsed).toBe(true);
    expect(response.results).toEqual([
      { title: "Fallback Result", url: "https://example.com/fallback", snippet: "Fallback snippet" },
    ]);

    const navigate = await executeBrowserTool(
      "browser.navigate",
      {
        url: "https://example.com/firecrawl-fallback-page",
        backend: "firecrawl",
        firecrawlBaseUrl: "http://127.0.0.1:3002",
        firecrawlFallbackToNative: true,
      },
      config,
    );
    expect(navigate).toMatchObject({
      backend: "firecrawl",
      backendUsed: false,
      fallbackUsed: true,
      action: "navigate",
    });

    const extract = await executeBrowserTool(
      "browser.extract",
      {
        url: "https://example.com/firecrawl-fallback-page",
        selector: "body",
        backend: "firecrawl",
        firecrawlBaseUrl: "http://127.0.0.1:3002",
        firecrawlFallbackToNative: true,
      },
      config,
    );
    expect(extract).toMatchObject({
      backend: "firecrawl",
      backendUsed: false,
      fallbackUsed: true,
      action: "extract",
    });
  });

  it("uses HTML fetch fallback for navigate and extract when playwright runtime is unavailable", async () => {
    const config = createConfig(tempRoot);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          [
            "<html><head><title>Kristi Noem latest</title></head>",
            "<body><main><h1>Kristi Noem latest</h1><p>News coverage summary.</p></main></body></html>",
          ].join(""),
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        ),
    ) as unknown as typeof fetch;
    mocked.launch.mockRejectedValue(new Error("missing browser runtime"));

    const nav = await executeBrowserTool(
      "browser.navigate",
      { url: "https://example.com/news", maxChars: 400 },
      config,
    );
    expect(nav.fallbackUsed).toBe(true);
    expect(nav.extractionMode).toBe("html-fetch");
    expect(String(nav.textSnippet)).toContain("Kristi Noem");

    const extracted = await executeBrowserTool(
      "browser.extract",
      { url: "https://example.com/news", selector: "article", maxChars: 400 },
      config,
    );
    expect(extracted.fallbackUsed).toBe(true);
    expect(String(extracted.text)).toContain("News coverage summary");
  });

  it("surfaces failed HTML search fetches after browser extraction yields no results", async () => {
    const config = createConfig(tempRoot);
    mocked.launch.mockResolvedValue(createSearchPlaywrightStub(() => []) as never);
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(
      executeBrowserTool("browser.search", { query: "coverage", engine: "duckduckgo" }, config),
    ).rejects.toThrow(/Search fetch failed \(500\)/i);
  });

  it("rejects browser.extract requests that omit selector", async () => {
    const config = createConfig(tempRoot);

    await expect(
      executeBrowserTool("browser.extract", { url: "https://example.com/news", maxChars: 400 }, config),
    ).rejects.toThrow(/selector/i);
  });

  it("auto-installs Playwright Chromium when the executable is missing and retries launch", async () => {
    const config = createConfig(tempRoot);
    mocked.launch.mockReset();
    mocked.spawnSync.mockReset();
    mocked.spawnSync.mockImplementation((command: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === "--version") {
        return { status: 0, stdout: "10.29.3", stderr: "" };
      }
      if (
        Array.isArray(args) &&
        args.join(" ") === "--filter @goatcitadel/policy-engine exec playwright install chromium"
      ) {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected spawnSync call in test: ${command} ${(args ?? []).join(" ")}`);
    });
    mocked.launch
      .mockRejectedValueOnce(new Error("browserType.launch: Executable doesn't exist at C:\\\\missing\\\\chrome.exe"))
      .mockResolvedValueOnce(createPlaywrightStub() as never);

    const response = await executeBrowserTool(
      "browser.navigate",
      { url: "https://example.com/weather", maxChars: 400 },
      config,
    );

    expect(response.fallbackUsed).toBe(false);
    expect(mocked.launch).toHaveBeenCalledTimes(2);
    expect(mocked.spawnSync).toHaveBeenCalledWith(
      expect.stringMatching(/pnpm(\.cmd|\.exe)?$/i),
      ["--filter", "@goatcitadel/policy-engine", "exec", "playwright", "install", "chromium"],
      expect.objectContaining({
        cwd: process.cwd(),
        stdio: "inherit",
      }),
    );
  });

  it("rejects disallowed hosts and invalid interact steps", async () => {
    const config = createConfig(tempRoot);

    await expect(executeBrowserTool("browser.navigate", { url: "https://blocked.invalid" }, config)).rejects.toThrow(
      /allowlist/i,
    );

    await expect(
      executeBrowserTool(
        "browser.interact",
        {
          url: "https://example.com",
          steps: [{ action: "invalid" }],
        },
        config,
      ),
    ).rejects.toThrow(/Unsupported browser\.interact step action/i);
  });

  it("keeps browser host allowlist enforcement in bypass approval mode", async () => {
    const baseConfig = createConfig(tempRoot);
    const config: ToolPolicyConfig = {
      ...baseConfig,
      tools: {
        approvalMode: "bypass",
        allow: [],
        deny: [],
      },
      sandbox: {
        ...baseConfig.sandbox,
        networkAllowlist: ["localhost"],
      },
    };

    await expect(
      executeBrowserTool("browser.navigate", { url: "https://apnews.com/oddities", maxChars: 400 }, config),
    ).rejects.toThrow(/allowlisted/i);
  });

  it("still blocks metadata hosts under the danger profile", async () => {
    const baseConfig = createConfig(tempRoot);
    const config: ToolPolicyConfig = {
      ...baseConfig,
      tools: {
        approvalMode: "bypass",
        allow: [],
        deny: [],
      },
      sandbox: {
        ...baseConfig.sandbox,
        networkAllowlist: ["localhost"],
      },
    };

    await expect(
      executeBrowserTool("browser.navigate", { url: "http://169.254.169.254/latest/meta-data" }, config),
    ).rejects.toThrow(/blocked/i);
  });

  it("manages browser cookies and storage in session-scoped state", async () => {
    const config = createConfig(tempRoot);
    const executionContext = { sessionId: "sess-browser-state" };

    await executeBrowserTool(
      "browser.context.configure",
      {
        locale: "en-US",
        timezoneId: "America/Los_Angeles",
        extraHTTPHeaders: { "x-goat-test": "1" },
        httpCredentials: { username: "goat", password: "citadel" },
      },
      config,
      executionContext,
    );

    await executeBrowserTool(
      "browser.storage.set",
      {
        origin: "https://example.com",
        storage: "local",
        entries: { theme: "signal-noir", density: "compact" },
      },
      config,
      executionContext,
    );

    await executeBrowserTool(
      "browser.storage.set",
      {
        origin: "https://example.com",
        storage: "session",
        entries: { token: "session-123" },
      },
      config,
      executionContext,
    );

    await executeBrowserTool(
      "browser.cookies.set",
      {
        cookies: [{ name: "sid", value: "abc123", url: "https://example.com" }],
      },
      config,
      executionContext,
    );

    const cookies = await executeBrowserTool("browser.cookies.get", {}, config, executionContext);
    expect(cookies.cookies).toEqual([
      expect.objectContaining({ name: "sid", value: "abc123", url: "https://example.com" }),
    ]);

    const storage = await executeBrowserTool(
      "browser.storage.get",
      { origin: "https://example.com" },
      config,
      executionContext,
    );
    expect(storage.localStorage).toEqual({ theme: "signal-noir", density: "compact" });
    expect(storage.sessionStorage).toEqual({ token: "session-123" });

    const clearedStorage = await executeBrowserTool(
      "browser.storage.clear",
      { origin: "https://example.com", storage: "session", key: "token" },
      config,
      executionContext,
    );
    expect(clearedStorage.removed).toBe(1);

    const clearedCookies = await executeBrowserTool("browser.cookies.clear", { name: "sid" }, config, executionContext);
    expect(clearedCookies.removed).toBe(1);
  });

  it("enforces matched grant host allowlists for browser cookies and storage state", async () => {
    const config = createConfig(tempRoot);
    config.sandbox.networkAllowlist = [...config.sandbox.networkAllowlist, "allowed.example", "blocked.example"];
    const seedContext = { sessionId: "sess-browser-grant-state" };
    const grantContext = {
      ...seedContext,
      matchedGrantAllowedHosts: ["allowed.example"],
    };

    await executeBrowserTool(
      "browser.storage.set",
      { origin: "https://allowed.example", storage: "local", key: "mode", value: "allowed" },
      config,
      seedContext,
    );
    await executeBrowserTool(
      "browser.storage.set",
      { origin: "https://blocked.example", storage: "local", key: "mode", value: "blocked" },
      config,
      seedContext,
    );
    await executeBrowserTool(
      "browser.cookies.set",
      {
        cookies: [
          { name: "allowed", value: "1", domain: "allowed.example" },
          { name: "blocked", value: "1", domain: "blocked.example" },
        ],
      },
      config,
      seedContext,
    );

    const grantStorage = await executeBrowserTool("browser.storage.get", { storage: "local" }, config, grantContext);
    expect(grantStorage.localStorage).toEqual({
      "https://allowed.example": { mode: "allowed" },
    });
    const grantCookies = await executeBrowserTool("browser.cookies.get", {}, config, grantContext);
    expect(grantCookies.cookies).toEqual([expect.objectContaining({ name: "allowed", domain: "allowed.example" })]);

    await expect(
      executeBrowserTool(
        "browser.storage.set",
        { origin: "https://blocked.example", storage: "local", key: "mode", value: "denied" },
        config,
        grantContext,
      ),
    ).rejects.toThrow(/allowlisted/i);
    await expect(
      executeBrowserTool(
        "browser.cookies.set",
        { name: "denied", value: "1", domain: "blocked.example" },
        config,
        grantContext,
      ),
    ).rejects.toThrow(/allowlisted/i);
    await expect(
      executeBrowserTool("browser.storage.get", { origin: "https://blocked.example" }, config, grantContext),
    ).rejects.toThrow(/allowlisted/i);
    await expect(
      executeBrowserTool("browser.cookies.get", { domain: "blocked.example" }, config, grantContext),
    ).rejects.toThrow(/allowlisted/i);

    const storageClear = await executeBrowserTool("browser.storage.clear", { storage: "local" }, config, grantContext);
    expect(storageClear.removed).toBe(1);
    const storageAfterClear = await executeBrowserTool(
      "browser.storage.get",
      { storage: "local" },
      config,
      seedContext,
    );
    expect(storageAfterClear.localStorage).toEqual({
      "https://blocked.example": { mode: "blocked" },
    });

    const cookiesClear = await executeBrowserTool("browser.cookies.clear", {}, config, grantContext);
    expect(cookiesClear.removed).toBe(1);
    const cookiesAfterClear = await executeBrowserTool("browser.cookies.get", {}, config, seedContext);
    expect(cookiesAfterClear.cookies).toEqual([
      expect.objectContaining({ name: "blocked", domain: "blocked.example" }),
    ]);
  });

  it("ignores caller-supplied browser session ids and uses active session context", async () => {
    const config = createConfig(tempRoot);
    const executionContext = { sessionId: "sess-context-state" };

    await executeBrowserTool(
      "browser.context.configure",
      { browserSessionId: "sess-arg-state", locale: "en-GB" },
      config,
      executionContext,
    );
    await executeBrowserTool(
      "browser.storage.set",
      {
        browserSessionId: "sess-arg-state",
        origin: "https://example.com",
        storage: "local",
        key: "theme",
        value: "context",
      },
      config,
      executionContext,
    );
    expect(
      (
        await executeBrowserTool(
          "browser.storage.get",
          { browserSessionId: "sess-arg-state", origin: "https://example.com" },
          config,
          executionContext,
        )
      ).localStorage,
    ).toEqual({ theme: "context" });

    await expect(
      executeBrowserTool(
        "browser.storage.get",
        { browserSessionId: "sess-arg-state", origin: "https://example.com" },
        config,
      ),
    ).rejects.toThrow(/requires active session context/i);
  });

  it("validates cookie input and filters cookies by domain, path, and URL", async () => {
    const config = createConfig(tempRoot);
    const executionContext = { sessionId: "sess-browser-cookie-filter" };

    await expect(
      executeBrowserTool("browser.cookies.set", { cookies: [{ name: "bad" }] }, config, executionContext),
    ).rejects.toThrow(/value is required/i);
    await expect(
      executeBrowserTool("browser.cookies.set", { cookies: [{ name: "bad", value: "1" }] }, config, executionContext),
    ).rejects.toThrow(/requires url or domain/i);
    await expect(
      executeBrowserTool(
        "browser.cookies.set",
        { cookies: [{ name: "bad", value: "1", url: "https://example.com", expires: "nope" }] },
        config,
        executionContext,
      ),
    ).rejects.toThrow(/expires must be a finite number/i);
    await expect(
      executeBrowserTool(
        "browser.cookies.set",
        { cookies: [{ name: "bad", value: "1", url: "https://example.com", sameSite: "Loose" }] },
        config,
        executionContext,
      ),
    ).rejects.toThrow(/sameSite must be/i);

    await executeBrowserTool(
      "browser.cookies.set",
      {
        cookies: [
          {
            name: "sid",
            value: "abc123",
            domain: ".example.com",
            path: "/app",
            expires: 1_900_000_000,
            httpOnly: true,
            secure: true,
            sameSite: "Strict",
          },
          { name: "other", value: "zzz", url: "https://example.com" },
        ],
      },
      config,
      executionContext,
    );

    const byDomain = await executeBrowserTool(
      "browser.cookies.get",
      { domain: "https://example.com", path: "/app" },
      config,
      executionContext,
    );
    expect(byDomain.cookies).toEqual([
      expect.objectContaining({
        name: "sid",
        domain: ".example.com",
        path: "/app",
        sameSite: "Strict",
      }),
    ]);

    const byUrl = await executeBrowserTool(
      "browser.cookies.get",
      { name: "sid", url: "https://example.com/account" },
      config,
      executionContext,
    );
    expect(byUrl.cookies).toEqual([expect.objectContaining({ name: "sid" })]);

    const byMissingCookieDomain = await executeBrowserTool(
      "browser.cookies.get",
      { name: "other", domain: "example.com" },
      config,
      executionContext,
    );
    expect(byMissingCookieDomain.cookies).toEqual([]);

    const byMismatchedUrl = await executeBrowserTool(
      "browser.cookies.get",
      { name: "sid", url: "https://other.example.net/account" },
      config,
      executionContext,
    );
    expect(byMismatchedUrl.cookies).toEqual([]);

    const removed = await executeBrowserTool(
      "browser.cookies.clear",
      { domain: "example.com", path: "/app" },
      config,
      executionContext,
    );
    expect(removed.removed).toBe(1);
  });

  it("covers browser state validation, clearing, and eviction edges", async () => {
    const config = createConfig(tempRoot);
    const executionContext = { sessionId: "sess-browser-state-edges" };

    await expect(executeBrowserTool("browser.cookies.get", {}, config)).rejects.toThrow(
      /requires active session context/i,
    );
    await expect(executeBrowserTool("browser.cookies.set", { cookies: [] }, config, executionContext)).rejects.toThrow(
      /requires a cookie object/i,
    );
    await expect(
      executeBrowserTool("browser.cookies.set", { cookies: ["bad"] }, config, executionContext),
    ).rejects.toThrow(/must be an object/i);

    await executeBrowserTool(
      "browser.cookies.set",
      { name: "url-domain", value: "1", domain: "https://example.com", path: "/edge" },
      config,
      executionContext,
    );
    expect(
      (await executeBrowserTool("browser.cookies.get", { domain: ".example.com" }, config, executionContext)).count,
    ).toBe(1);
    expect((await executeBrowserTool("browser.cookies.clear", {}, config, executionContext)).remaining).toBe(0);

    await executeBrowserTool(
      "browser.storage.set",
      { origin: "https://example.com", storage: "local", key: "count", value: 1 },
      config,
      executionContext,
    );
    await executeBrowserTool(
      "browser.storage.set",
      { origin: "https://example.com", storage: "local", key: "mode", value: "edge" },
      config,
      executionContext,
    );
    await executeBrowserTool(
      "browser.storage.set",
      { origin: "https://example.com", storage: "session", entries: { flag: true, mode: "edge" } },
      config,
      executionContext,
    );
    expect(
      (await executeBrowserTool("browser.storage.get", { storage: "session" }, config, executionContext)).localStorage,
    ).toEqual({});
    expect(
      (await executeBrowserTool("browser.storage.get", { storage: "local" }, config, executionContext)).sessionStorage,
    ).toEqual({});
    await expect(
      executeBrowserTool("browser.storage.clear", { key: "count" }, config, executionContext),
    ).rejects.toThrow(/requires origin/i);
    expect(
      (
        await executeBrowserTool(
          "browser.storage.clear",
          { origin: "https://www.google.com", storage: "local" },
          config,
          executionContext,
        )
      ).removed,
    ).toBe(0);
    expect(
      (
        await executeBrowserTool(
          "browser.storage.clear",
          { origin: "https://example.com", storage: "local", key: "missing" },
          config,
          executionContext,
        )
      ).removed,
    ).toBe(0);
    expect(
      (
        await executeBrowserTool(
          "browser.storage.clear",
          { origin: "https://example.com", storage: "local", key: "count" },
          config,
          executionContext,
        )
      ).removed,
    ).toBe(1);
    expect(
      (
        await executeBrowserTool(
          "browser.storage.clear",
          { origin: "https://example.com", storage: "local" },
          config,
          executionContext,
        )
      ).removed,
    ).toBe(1);
    expect(
      (await executeBrowserTool("browser.storage.clear", { storage: "both" }, config, executionContext)).removed,
    ).toBe(2);

    await expect(
      executeBrowserTool(
        "browser.storage.set",
        { origin: "https://example.com", storage: "both", key: "bad", value: "x" },
        config,
        executionContext,
      ),
    ).rejects.toThrow(/storage must be local or session/i);
    await expect(
      executeBrowserTool(
        "browser.storage.set",
        { origin: "https://example.com", entries: { " ": "x" } },
        config,
        executionContext,
      ),
    ).rejects.toThrow(/empty key/i);
    await expect(
      executeBrowserTool(
        "browser.storage.set",
        { origin: "https://example.com", key: "object", value: { nested: true } },
        config,
        executionContext,
      ),
    ).rejects.toThrow(/must be a string, number, or boolean/i);

    await executeBrowserTool(
      "browser.context.configure",
      {
        reset: true,
        geolocation: null,
        extraHTTPHeaders: null,
        httpCredentials: null,
      },
      config,
      executionContext,
    );
    await expect(
      executeBrowserTool("browser.context.configure", { geolocation: "nearby" }, config, executionContext),
    ).rejects.toThrow(/geolocation must be an object/i);
    await expect(
      executeBrowserTool(
        "browser.context.configure",
        { geolocation: { latitude: -100, longitude: 0 } },
        config,
        executionContext,
      ),
    ).rejects.toThrow(/latitude/i);
    await expect(
      executeBrowserTool(
        "browser.context.configure",
        { geolocation: { latitude: 0, longitude: 181 } },
        config,
        executionContext,
      ),
    ).rejects.toThrow(/longitude/i);
    await expect(
      executeBrowserTool(
        "browser.context.configure",
        { geolocation: { latitude: 0, longitude: 0, accuracy: -1 } },
        config,
        executionContext,
      ),
    ).rejects.toThrow(/accuracy/i);
    await expect(
      executeBrowserTool("browser.context.configure", { extraHTTPHeaders: [] }, config, executionContext),
    ).rejects.toThrow(/extraHTTPHeaders must be an object/i);
    await expect(
      executeBrowserTool("browser.context.configure", { httpCredentials: "basic" }, config, executionContext),
    ).rejects.toThrow(/httpCredentials must be an object/i);

    for (let index = 0; index < 130; index += 1) {
      await executeBrowserTool(
        "browser.context.configure",
        { locale: `en-${String(index).padStart(2, "0")}` },
        config,
        { sessionId: `sess-evict-${index}` },
      );
    }
  });

  it("uses visual accessibility text when DOM weather extraction is empty", async () => {
    const config = createConfig(tempRoot);
    const page = {
      goto: async () => ({ status: () => 200 }),
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      title: async () => "Forecast",
      url: () => "https://example.com/forecast",
      locator: () => ({
        first: () => ({
          innerText: async () => "ordinary page text",
        }),
      }),
      accessibility: {
        snapshot: async () => ({
          name: "Austin 72°F sunny",
          value: "Current conditions",
          children: [{ name: "Clear skies" }],
        }),
      },
    };
    mocked.launch.mockResolvedValueOnce({
      newContext: async () => ({
        newPage: async () => page,
      }),
      close: async () => undefined,
    } as never);

    const result = await executeBrowserTool(
      "browser.navigate",
      { url: "https://example.com/forecast", maxChars: 500 },
      config,
    );

    expect(result.extractionMode).toBe("visual");
    expect(result.weather).toMatchObject({
      temperature: "72°F",
      condition: "Sunny",
    });
    expect(String(result.visualTextSnippet)).toContain("Clear skies");
  });

  it("uses visual accessibility weather during extract and falls back to body text on selector misses", async () => {
    const config = createConfig(tempRoot);
    const page = {
      goto: async () => ({ status: () => 200 }),
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      title: async () => "Forecast for Austin | Example",
      url: () => "https://example.com/forecast",
      locator: (selector: string) => ({
        first: () => ({
          innerText: async () => {
            if (selector === "body") {
              return "Body fallback text";
            }
            throw new Error("selector missing");
          },
        }),
      }),
      accessibility: {
        snapshot: async () => ({
          name: "72 degrees fahrenheit and mostly sunny",
          children: [{ value: "Austin current conditions" }],
        }),
      },
    };
    mocked.launch.mockResolvedValueOnce({
      newContext: async () => ({
        newPage: async () => page,
      }),
      close: async () => undefined,
    } as never);

    const result = await executeBrowserTool(
      "browser.extract",
      { url: "https://example.com/forecast", selector: "#missing", maxChars: 500 },
      config,
    );

    expect(result).toMatchObject({
      extractionMode: "visual",
      text: "Body fallback text",
      weather: expect.objectContaining({
        location: "Austin",
        temperature: "72°F",
      }),
    });
  });

  it("treats empty, null, and throwing accessibility snapshots as non-weather visual text", async () => {
    const config = createConfig(tempRoot);
    for (const snapshot of [null, new Error("snapshot boom"), { name: "12345" }]) {
      mocked.launch.mockResolvedValueOnce({
        newContext: async () => ({
          newPage: async () => ({
            goto: async () => ({ status: () => 200 }),
            waitForLoadState: async () => undefined,
            waitForTimeout: async () => undefined,
            title: async () => "Plain Page",
            url: () => "https://example.com/plain",
            locator: () => ({
              first: () => ({
                innerText: async () => "plain body",
              }),
            }),
            accessibility: {
              snapshot: async () => {
                if (snapshot instanceof Error) {
                  throw snapshot;
                }
                return snapshot;
              },
            },
          }),
        }),
        close: async () => undefined,
      } as never);

      const result = await executeBrowserTool(
        "browser.navigate",
        { url: "https://example.com/plain", maxChars: 500 },
        config,
      );
      expect(result.extractionMode).toBe("text");
    }
  });

  it("decodes HTML entities from fallback search result markup", async () => {
    const config = createConfig(tempRoot);
    mocked.launch.mockRejectedValue(new Error("missing browser runtime"));
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          [
            '<a href="bad href">Bad</a>',
            '<a href="https://example.com/empty"></a>',
            '<a href="https://example.com/entity">',
            "A &amp; &quot; &#39; &lt; &gt; &#x27; &#x2F; &#65; &#abc; &#bogus;",
            "</a>",
            '<a href="https://example.com/entity">Duplicate</a>',
          ].join(""),
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        ),
    ) as unknown as typeof fetch;

    const result = await executeBrowserTool("browser.search", { query: "entities", engine: "duckduckgo" }, config);

    expect(result.results).toEqual([
      {
        title: "A & \" ' ' / A &#abc; &#bogus;",
        url: "https://example.com/entity",
        snippet: "A & \" ' ' / A &#abc; &#bogus; Duplicate",
      },
    ]);
  });

  it("applies stored browser session state to approved interaction contexts", async () => {
    const config = createConfig(tempRoot);
    const executionContext = { sessionId: "sess-browser-context" };
    const seenContextOptions: Array<Record<string, unknown> | undefined> = [];
    mocked.launch.mockResolvedValueOnce({
      ...createPlaywrightStub(),
      newContext: async (options?: Record<string, unknown>) => {
        seenContextOptions.push(options);
        return (createPlaywrightStub() as unknown as { newContext: () => Promise<unknown> }).newContext();
      },
    } as never);

    await executeBrowserTool(
      "browser.context.configure",
      {
        locale: "en-US",
        timezoneId: "America/Los_Angeles",
        geolocation: { latitude: 30.2672, longitude: -97.7431 },
        extraHTTPHeaders: { "x-goat-test": "1" },
      },
      config,
      executionContext,
    );
    await executeBrowserTool(
      "browser.storage.set",
      {
        origin: "https://example.com",
        storage: "local",
        entries: { theme: "signal-noir" },
      },
      config,
      executionContext,
    );
    await executeBrowserTool(
      "browser.cookies.set",
      {
        cookies: [{ name: "sid", value: "abc123", url: "https://example.com" }],
      },
      config,
      executionContext,
    );

    await executeBrowserTool(
      "browser.interact",
      { url: "https://example.com/dashboard", maxChars: 300, steps: [{ action: "wait", timeoutMs: 100 }] },
      config,
      executionContext,
    );

    expect(seenContextOptions[0]).toMatchObject({
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
      geolocation: { latitude: 30.2672, longitude: -97.7431 },
      extraHTTPHeaders: { "x-goat-test": "1" },
      storageState: {
        cookies: [expect.objectContaining({ name: "sid", value: "abc123" })],
        origins: [
          {
            origin: "https://example.com",
            localStorage: [{ name: "theme", value: "signal-noir" }],
          },
        ],
      },
    });
  });

  it("does not apply stored browser session state to read-only navigation", async () => {
    const config = createConfig(tempRoot);
    const executionContext = { sessionId: "sess-browser-stateless-read" };
    const seenContextOptions: Array<Record<string, unknown> | undefined> = [];
    mocked.launch.mockResolvedValueOnce({
      ...createPlaywrightStub(),
      newContext: async (options?: Record<string, unknown>) => {
        seenContextOptions.push(options);
        return (createPlaywrightStub() as unknown as { newContext: () => Promise<unknown> }).newContext();
      },
    } as never);

    await executeBrowserTool(
      "browser.context.configure",
      {
        locale: "en-US",
        timezoneId: "America/Los_Angeles",
      },
      config,
      executionContext,
    );
    await executeBrowserTool(
      "browser.storage.set",
      {
        origin: "https://example.com",
        storage: "local",
        entries: { theme: "signal-noir" },
      },
      config,
      executionContext,
    );
    await executeBrowserTool(
      "browser.cookies.set",
      {
        cookies: [{ name: "sid", value: "abc123", url: "https://example.com" }],
      },
      config,
      executionContext,
    );

    const result = await executeBrowserTool(
      "browser.navigate",
      { url: "https://example.com/dashboard", maxChars: 300 },
      config,
      executionContext,
    );

    expect(result.browserSessionId).toBeUndefined();
    expect(seenContextOptions[0]).toMatchObject({
      locale: undefined,
      timezoneId: undefined,
      storageState: undefined,
    });
  });

  it("stores mapped browser storage state and copied credentials after approved interaction", async () => {
    const config = createConfig(tempRoot);
    const executionContext = { sessionId: "sess-browser-mapped-state" };
    mocked.launch.mockResolvedValueOnce({
      newContext: async () => ({
        grantPermissions: async () => undefined,
        newPage: async () => ({
          goto: async () => ({ status: () => 200 }),
          waitForLoadState: async () => undefined,
          waitForTimeout: async () => undefined,
          title: async () => "Mapped State",
          url: () => "https://example.com/mapped",
          evaluate: async () => ({ token: "mapped-session" }),
          locator: () => ({
            first: () => ({
              innerText: async () => "mapped body",
            }),
          }),
        }),
        storageState: async () => ({
          cookies: [{ name: "mapped", value: "1", domain: "example.com", path: "/" }],
          origins: [
            {
              origin: "https://example.com",
              localStorage: [{ name: "theme", value: "mapped" }],
            },
          ],
        }),
      }),
      close: async () => undefined,
    } as never);

    await executeBrowserTool(
      "browser.context.configure",
      {
        geolocation: { latitude: 30.2672, longitude: -97.7431 },
        httpCredentials: { username: "goat", password: "citadel" },
      },
      config,
      executionContext,
    );
    await executeBrowserTool(
      "browser.interact",
      { url: "https://example.com/mapped", steps: [{ action: "wait", timeoutMs: 100 }] },
      config,
      executionContext,
    );

    const storage = await executeBrowserTool(
      "browser.storage.get",
      { origin: "https://example.com", storage: "both" },
      config,
      executionContext,
    );
    const cookies = await executeBrowserTool("browser.cookies.get", { name: "mapped" }, config, executionContext);
    expect(storage.localStorage).toEqual({ theme: "mapped" });
    expect(storage.sessionStorage).toEqual({ token: "mapped-session" });
    expect(cookies.cookies).toEqual([expect.objectContaining({ name: "mapped" })]);
    const summary = describeBrowserSessionState("sess-browser-mapped-state");
    expect(summary).toMatchObject({
      availability: "present",
      valuesHidden: true,
      cookies: { count: 1, domains: ["example.com"] },
      localStorage: { originCount: 1, keyCount: 1, origins: ["https://example.com"] },
      sessionStorage: { originCount: 1, keyCount: 1, origins: ["https://example.com"] },
      context: {
        geolocationConfigured: true,
        extraHTTPHeadersCount: 0,
        httpCredentialsConfigured: true,
      },
    });
    expect(JSON.stringify(summary)).not.toContain("mapped-session");
    expect(JSON.stringify(summary)).not.toContain("citadel");
  });

  it("returns explicit unavailable state when no in-memory browser session state exists", () => {
    expect(describeBrowserSessionState("missing-browser-state")).toMatchObject({
      availability: "not_available",
      valuesHidden: true,
      cookies: { count: 0, domains: [] },
      localStorage: { originCount: 0, keyCount: 0, origins: [] },
      sessionStorage: { originCount: 0, keyCount: 0, origins: [] },
      context: {
        geolocationConfigured: false,
        extraHTTPHeadersCount: 0,
        httpCredentialsConfigured: false,
      },
    });
  });

  it("closes the browser from the abort handler when a signal aborts after launch", async () => {
    const config = createConfig(tempRoot);
    const abortController = new AbortController();
    const close = vi.fn(async () => undefined);
    mocked.launch.mockResolvedValueOnce({
      newContext: async () => {
        abortController.abort();
        return {
          newPage: async () => ({
            goto: async () => ({ status: () => 200 }),
            waitForLoadState: async () => undefined,
            waitForTimeout: async () => undefined,
            title: async () => "Abort",
            url: () => "https://example.com/abort-late",
            evaluate: async () => ({}),
            locator: () => ({
              first: () => ({
                innerText: async () => "abort body",
              }),
            }),
          }),
        };
      },
      close,
    } as never);

    const result = await executeBrowserTool("browser.navigate", { url: "https://example.com/abort-late" }, config, {
      signal: abortController.signal,
    });

    expect(result.finalUrl).toBe("https://example.com/abort-late");
    expect(close).toHaveBeenCalled();
  });

  it("recognizes additional weather normalization and boolean-string paths", async () => {
    const config = createConfig(tempRoot);
    const screenshotPath = path.join(tempRoot, "shots", "string-full-page.png");
    mocked.launch.mockResolvedValueOnce({
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => ({ status: () => 200 }),
          waitForLoadState: async () => undefined,
          waitForTimeout: async () => undefined,
          title: async () => "",
          url: () => "https://example.com/weather-json",
          screenshot: async (options: { path: string }) => {
            await fs.writeFile(options.path, "png", "utf8");
          },
          evaluate: async () => ({}),
          locator: () => ({
            first: () => ({
              innerText: async () => "weather-json body",
            }),
          }),
          accessibility: {
            snapshot: async () => ({
              name: "currentTemp: 18 and clear",
              children: [{ name: "12345" }],
            }),
          },
        }),
      }),
      close: async () => undefined,
    } as never);
    const screenshot = await executeBrowserTool(
      "browser.screenshot",
      { url: "https://example.com/weather-json", outputPath: screenshotPath, fullPage: "true" },
      config,
    );
    expect(screenshot.fullPage).toBe(true);

    mocked.launch.mockResolvedValueOnce({
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => ({ status: () => 200 }),
          waitForLoadState: async () => undefined,
          waitForTimeout: async () => undefined,
          title: async () => "",
          url: () => "https://example.com/weather-celsius",
          evaluate: async () => ({}),
          locator: () => ({
            first: () => ({
              innerText: async () => "celsius body",
            }),
          }),
          accessibility: {
            snapshot: async () => ({
              name: "21 degrees celsius and rainy",
            }),
          },
        }),
      }),
      close: async () => undefined,
    } as never);
    const nav = await executeBrowserTool("browser.navigate", { url: "https://example.com/weather-celsius" }, config);
    expect(nav.weather).toMatchObject({ temperature: "21°C", condition: "Rainy" });

    mocked.launch.mockResolvedValueOnce({
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => ({ status: () => 200 }),
          waitForLoadState: async () => undefined,
          waitForTimeout: async () => undefined,
          title: async () => "12345",
          url: () => "https://example.com/weather-jsonlike",
          evaluate: async () => ({}),
          locator: () => ({
            first: () => ({
              innerText: async () => "jsonlike body",
            }),
          }),
          accessibility: {
            snapshot: async () => ({
              name: "currentTemp: 18 and clear",
            }),
          },
        }),
      }),
      close: async () => undefined,
    } as never);
    const jsonLike = await executeBrowserTool(
      "browser.navigate",
      { url: "https://example.com/weather-jsonlike" },
      config,
    );
    expect(jsonLike.weather).toMatchObject({ temperature: "18°", condition: "Clear" });
  });

  it("applies session storage, signal hooks, and empty storage state to approved interaction contexts", async () => {
    const config = createConfig(tempRoot);
    const executionContext = { sessionId: "sess-browser-session-storage", signal: new AbortController().signal };
    const seenContextOptions: Array<Record<string, unknown> | undefined> = [];
    let seededSessionStorage: Record<string, Record<string, string>> | undefined;
    const priorWindow = (globalThis as unknown as { window?: unknown }).window;
    mocked.launch.mockResolvedValueOnce({
      newContext: async (options?: Record<string, unknown>) => {
        seenContextOptions.push(options);
        return {
          addInitScript: async (fn: unknown, arg: Record<string, Record<string, string>>) => {
            seededSessionStorage = arg;
            (globalThis as unknown as { window?: unknown }).window = {
              location: { origin: "https://example.com" },
              sessionStorage: createSessionStorageShim(),
            };
            (fn as (sessionStorageByOrigin: Record<string, Record<string, string>>) => void)(arg);
          },
          newPage: async () => ({
            goto: async () => ({ status: () => 200 }),
            waitForLoadState: async () => undefined,
            waitForTimeout: async () => undefined,
            title: async () => "Session Page",
            url: () => "https://example.com/session",
            evaluate: async (fn: unknown) => {
              (globalThis as unknown as { window?: unknown }).window = {
                sessionStorage: createSessionStorageShim({ token: "after-nav" }),
              };
              return (fn as () => unknown)();
            },
            locator: () => ({
              first: () => ({
                innerText: async () => "Session page text",
              }),
            }),
          }),
          storageState: async () => ({ cookies: [], origins: [] }),
        };
      },
      close: async () => undefined,
    } as never);

    await executeBrowserTool(
      "browser.context.configure",
      {
        locale: "en-US",
      },
      config,
      executionContext,
    );
    await executeBrowserTool(
      "browser.storage.set",
      {
        origin: "https://example.com",
        storage: "session",
        entries: { token: "before-nav" },
      },
      config,
      executionContext,
    );

    try {
      const result = await executeBrowserTool(
        "browser.interact",
        { url: "https://example.com/session", maxChars: 300, steps: [{ action: "wait", timeoutMs: 100 }] },
        config,
        executionContext,
      );
      expect(result.browserSessionId).toBe("sess-browser-session-storage");
      expect(seenContextOptions[0]).toMatchObject({
        locale: "en-US",
        storageState: undefined,
      });
      expect(seededSessionStorage).toEqual({
        "https://example.com": { token: "before-nav" },
      });
    } finally {
      (globalThis as unknown as { window?: unknown }).window = priorWindow;
    }
  });

  it("keeps previous local storage when storageState is unavailable and handles session snapshot failures", async () => {
    const config = createConfig(tempRoot);
    const executionContext = { sessionId: "sess-browser-storage-fallback" };
    const priorWindow = (globalThis as unknown as { window?: unknown }).window;
    let addInitScriptCalls = 0;
    mocked.launch.mockResolvedValue({
      newContext: async () => ({
        addInitScript: async (fn: unknown, arg: Record<string, Record<string, string>>) => {
          addInitScriptCalls += 1;
          (globalThis as unknown as { window?: unknown }).window = {
            location: { origin: "https://example.com" },
            sessionStorage: createSessionStorageShim(arg["https://example.com"] ?? {}),
          };
          (fn as (sessionStorageByOrigin: Record<string, Record<string, string>>) => void)(arg);
        },
        newPage: async () => ({
          goto: async () => ({ status: () => 200 }),
          waitForLoadState: async () => undefined,
          waitForTimeout: async () => undefined,
          title: async () => "Storage Fallback",
          url: () => "https://example.com/storage",
          evaluate: async () => {
            throw new Error("sessionStorage denied");
          },
          locator: () => ({
            first: () => ({
              innerText: async () => "storage fallback body",
            }),
          }),
        }),
      }),
      close: async () => undefined,
    } as never);

    await executeBrowserTool(
      "browser.storage.set",
      { origin: "https://example.com", storage: "local", key: "theme", value: "noir" },
      config,
      executionContext,
    );
    await executeBrowserTool(
      "browser.storage.set",
      { origin: "https://example.com", storage: "session", key: "token", value: "before" },
      config,
      executionContext,
    );

    try {
      await executeBrowserTool(
        "browser.interact",
        { url: "https://example.com/storage", waitUntil: "networkidle", steps: [{ action: "wait", timeoutMs: 100 }] },
        config,
        executionContext,
      );
      expect(addInitScriptCalls).toBe(1);
      const storage = await executeBrowserTool(
        "browser.storage.get",
        { origin: "https://example.com", storage: "both" },
        config,
        executionContext,
      );
      expect(storage.localStorage).toEqual({ theme: "noir" });
      expect(storage.sessionStorage).toEqual({ token: "before" });
    } finally {
      (globalThis as unknown as { window?: unknown }).window = priorWindow;
    }
  });

  it("ignores seeded session storage for unrelated origins and skips null session keys", async () => {
    const config = createConfig(tempRoot);
    const executionContext = { sessionId: "sess-browser-session-null-key" };
    const priorWindow = (globalThis as unknown as { window?: unknown }).window;
    mocked.launch.mockResolvedValueOnce({
      newContext: async () => ({
        addInitScript: async (fn: unknown, arg: Record<string, Record<string, string>>) => {
          (globalThis as unknown as { window?: unknown }).window = {
            location: { origin: "https://example.com" },
            sessionStorage: createSessionStorageShim(arg["https://example.com"] ?? {}),
          };
          (fn as (sessionStorageByOrigin: Record<string, Record<string, string>>) => void)(arg);
        },
        newPage: async () => ({
          goto: async () => ({ status: () => 200 }),
          waitForLoadState: async () => undefined,
          waitForTimeout: async () => undefined,
          title: async () => "Null Key",
          url: () => "https://example.com/null-key",
          evaluate: async (fn: unknown) => {
            (globalThis as unknown as { window?: unknown }).window = {
              sessionStorage: {
                length: 1,
                key: () => null,
                getItem: () => "ignored",
              },
            };
            return (fn as () => unknown)();
          },
          locator: () => ({
            first: () => ({
              innerText: async () => "null key body",
            }),
          }),
          accessibility: {},
        }),
      }),
      close: async () => undefined,
    } as never);

    await executeBrowserTool(
      "browser.storage.set",
      { origin: "https://www.google.com", storage: "session", key: "other", value: "origin" },
      config,
      executionContext,
    );

    try {
      await executeBrowserTool(
        "browser.navigate",
        { url: "https://example.com/null-key", waitUntil: "load" },
        config,
        executionContext,
      );
      const storage = await executeBrowserTool(
        "browser.storage.get",
        { origin: "https://www.google.com", storage: "session" },
        config,
        executionContext,
      );
      expect(storage.sessionStorage).toEqual({ other: "origin" });
    } finally {
      (globalThis as unknown as { window?: unknown }).window = priorWindow;
    }
  });

  it("handles browser launch failures, install failures, invalid URLs, and aborted signals", async () => {
    const config = createConfig(tempRoot);
    mocked.launch.mockRejectedValueOnce(new Error("browser died before launch"));
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><head><title>Fallback</title></head><body>Fallback text</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;

    const fallback = await executeBrowserTool("browser.navigate", { url: "https://example.com/fallback" }, config);
    expect(fallback).toMatchObject({
      fallbackUsed: true,
      fallbackReason: "browser died before launch",
    });

    mocked.spawnSync.mockReset();
    mocked.spawnSync.mockImplementation((_command: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === "--version") {
        return { status: 0, stdout: "10.29.3", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "install failed" };
    });
    mocked.launch.mockRejectedValueOnce(new Error("browserType.launch: Executable doesn't exist at C:\\\\missing.exe"));
    const installFailureFallback = await executeBrowserTool(
      "browser.navigate",
      { url: "https://example.com/install-fallback" },
      config,
    );
    expect(String(installFailureFallback.fallbackReason)).toContain("Failed to install Playwright Chromium runtime");

    mocked.spawnSync.mockReset();
    mocked.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
    mocked.launch.mockRejectedValueOnce(new Error("browserType.launch: Executable doesn't exist at C:\\\\missing.exe"));
    const pnpmMissingFallback = await executeBrowserTool(
      "browser.navigate",
      { url: "https://example.com/pnpm-fallback" },
      config,
    );
    expect(String(pnpmMissingFallback.fallbackReason)).toContain("pnpm is not available");

    await expect(executeBrowserTool("browser.navigate", { url: "not a url" }, config)).rejects.toThrow(/Invalid URL/i);
    await expect(executeBrowserTool("browser.navigate", { url: "ftp://example.com/file" }, config)).rejects.toThrow(
      /Unsupported URL protocol/i,
    );

    const abortController = new AbortController();
    abortController.abort();
    const abortedFallback = await executeBrowserTool(
      "browser.navigate",
      { url: "https://example.com/aborted" },
      config,
      { signal: abortController.signal },
    );
    expect(abortedFallback).toMatchObject({
      fallbackUsed: true,
      fallbackReason: "The operation was aborted.",
    });
  });

  it("reports Playwright install spawn errors and uses the configured app dir", async () => {
    const config = createConfig(tempRoot);
    process.env.GOATCITADEL_APP_DIR = tempRoot;
    mocked.spawnSync.mockReset();
    mocked.spawnSync.mockImplementation((_command: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === "--version") {
        return { status: 0, stdout: "10.29.3", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "", error: new Error("spawn failed") };
    });
    mocked.launch.mockRejectedValueOnce(new Error("browserType.launch: Executable doesn't exist at C:\\\\missing.exe"));
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body>install fallback</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;

    try {
      const result = await executeBrowserTool("browser.navigate", { url: "https://example.com/install-spawn" }, config);
      expect(String(result.fallbackReason)).toContain("spawn failed");
      expect(mocked.spawnSync).toHaveBeenCalledWith(
        expect.stringMatching(/pnpm/i),
        ["--filter", "@goatcitadel/policy-engine", "exec", "playwright", "install", "chromium"],
        expect.objectContaining({ cwd: tempRoot }),
      );
    } finally {
      delete process.env.GOATCITADEL_APP_DIR;
    }
  });

  it("covers fallback extraction and Firecrawl normalization edge paths", async () => {
    const config = createConfig(tempRoot);
    mocked.launch.mockRejectedValue(new Error("missing browser runtime"));
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body = String((init as RequestInit | undefined)?.body ?? "");
      if (url.endsWith("/v2/search")) {
        expect(new Headers((init as RequestInit | undefined)?.headers).get("Authorization")).toBe("Bearer fc-token");
        expect(body).toContain('"query":"coverage"');
        return new Response(
          JSON.stringify({
            data: {
              results: [
                { sourceURL: "https://example.com/from-source", markdown: "Markdown snippet" },
                { title: "Missing URL" },
              ],
              summary: "Nested summary",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.endsWith("/v2/scrape")) {
        return new Response(
          JSON.stringify({
            data: {
              content: "Content fallback",
              title: "Data Title",
              url: "https://example.com/data-url",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        [
          "<html><head><title>Fallback &amp; Title</title></head><body>",
          '<a href="/url?q=https%3A%2F%2Fexample.com%2Fgoogle">Google Result</a>',
          '<a href="/search?q=coverage">Search Chrome</a>',
          '<a href="https://www.bing.com/search?q=coverage">Bing Chrome</a>',
          '<a href="mailto:test@example.com">Mail</a>',
          "</body></html>",
        ].join(""),
        {
          status: 200,
          headers: { "content-type": "text/html" },
        },
      );
    }) as unknown as typeof fetch;
    process.env.FIRECRAWL_API_KEY = "fc-token";

    try {
      const search = await executeBrowserTool(
        "browser.search",
        { query: "coverage", backend: "firecrawl", firecrawlBaseUrl: "http://127.0.0.1:3002/" },
        config,
      );
      expect(search).toMatchObject({
        backend: "firecrawl",
        summary: "Nested summary",
        results: [{ title: "https://example.com/from-source", url: "https://example.com/from-source" }],
      });

      const navigate = await executeBrowserTool(
        "browser.navigate",
        {
          url: "https://example.com/firecrawl-content",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1:3002",
        },
        config,
      );
      expect(navigate).toMatchObject({
        finalUrl: "https://example.com/data-url",
        title: "Data Title",
        extractionMode: "firecrawl-markdown",
      });

      const extracted = await executeBrowserTool(
        "browser.extract",
        {
          url: "https://example.com/firecrawl-empty-html",
          selector: "main",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1:3002",
        },
        config,
      );
      expect(extracted).toMatchObject({
        text: "",
        extractionMode: "firecrawl-html-body-fallback",
      });
    } finally {
      delete process.env.FIRECRAWL_API_KEY;
    }
  });
});

function createSessionStorageShim(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    get length() {
      return entries.size;
    },
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    clear: () => {
      entries.clear();
    },
  };
}
