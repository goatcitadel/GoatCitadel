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

import { executeBrowserTool, isBrowserToolName } from "./browser-tools.js";

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
          { action: "wait_for_selector", selector: "#done" },
          { action: "wait", timeoutMs: 10 },
        ],
      },
      config,
    );
    expect(interact.action).toBe("interact");
    expect(interact.stepsExecuted).toBe(5);
    await expect(fs.access(interactPath)).resolves.toBeUndefined();
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
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/api/generate")) {
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

  it("applies stored browser session state to playwright contexts", async () => {
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
      "browser.navigate",
      { url: "https://example.com/dashboard", maxChars: 300 },
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
});
