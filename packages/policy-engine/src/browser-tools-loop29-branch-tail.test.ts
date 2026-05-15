import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeBrowserTool } from "./browser-tools.js";

function createConfig(): ToolPolicyConfig {
  return {
    profiles: { minimal: ["browser.*"] },
    tools: { profile: "minimal", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [],
      readOnlyRoots: [],
      networkAllowlist: ["127.0.0.1:3002", "example.com"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

describe("browser tools loop 29 branch tails", () => {
  const originalFetch = globalThis.fetch;
  const originalFirecrawlBaseUrl = process.env.FIRECRAWL_BASE_URL;
  const originalFirecrawlApiKeyEnv = process.env.GOATCITADEL_FIRECRAWL_API_KEY_ENV;
  const originalLoop29FirecrawlKey = process.env.LOOP29_FIRECRAWL_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.FIRECRAWL_BASE_URL = originalFirecrawlBaseUrl;
    process.env.GOATCITADEL_FIRECRAWL_API_KEY_ENV = originalFirecrawlApiKeyEnv;
    process.env.LOOP29_FIRECRAWL_KEY = originalLoop29FirecrawlKey;
    vi.restoreAllMocks();
  });

  it("uses Firecrawl env defaults, nested result payloads, markdown snippets, and API-key headers", async () => {
    process.env.FIRECRAWL_BASE_URL = "http://127.0.0.1:3002/";
    process.env.GOATCITADEL_FIRECRAWL_API_KEY_ENV = "LOOP29_FIRECRAWL_KEY";
    process.env.LOOP29_FIRECRAWL_KEY = " firecrawl-secret ";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer firecrawl-secret" });
      return new Response(
        JSON.stringify({
          data: {
            summary: "Nested summary",
            results: [{ sourceURL: "https://example.com/one", markdown: "Markdown snippet" }, { title: "Missing URL" }],
          },
        }),
        { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await executeBrowserTool(
      "browser.search",
      { query: "coverage", backend: "firecrawl" },
      createConfig(),
    );

    expect(result).toMatchObject({
      action: "search",
      backend: "firecrawl",
      backendUsed: true,
      finalUrl: "http://127.0.0.1:3002/v2/search",
      summary: "Nested summary",
      results: [{ title: "https://example.com/one", url: "https://example.com/one", snippet: "Markdown snippet" }],
    });
  });

  it("falls back to configured Firecrawl defaults when API key env values are absent", async () => {
    delete process.env.FIRECRAWL_BASE_URL;
    delete process.env.GOATCITADEL_FIRECRAWL_API_KEY_ENV;
    delete process.env.LOOP29_FIRECRAWL_KEY;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).not.toMatchObject({ Authorization: expect.any(String) });
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await executeBrowserTool(
      "browser.search",
      { query: "coverage", backend: "firecrawl", firecrawlApiKeyEnv: "LOOP29_FIRECRAWL_KEY" },
      createConfig(),
    );

    expect(result).toMatchObject({
      backend: "firecrawl",
      backendUsed: true,
      results: [],
    });
  });
});
