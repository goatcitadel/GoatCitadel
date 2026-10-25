import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { executeBrowserTool } from "./browser-tools.js";
import { resetFirecrawlReachabilityForTests } from "./firecrawl-reachability.js";

function config(networkAllowlist: string[]): ToolPolicyConfig {
  return {
    profiles: { minimal: ["browser.*"] },
    tools: { profile: "minimal", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [],
      readOnlyRoots: [],
      networkAllowlist,
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

const searchArgs = {
  query: "firecrawl self-hosted docker",
  backend: "firecrawl",
  firecrawlBaseUrl: "http://127.0.0.1:3002",
  firecrawlFallbackToNative: false,
};

/** A `/v2/search` reply: results are grouped by source, and `web` is the default source. */
function v2SearchResponse(web: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ success: true, data: { web }, creditsUsed: 2, id: "search-1" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Firecrawl v2 search results in browser tools", () => {
  afterEach(() => {
    resetFirecrawlReachabilityForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads web results from the v2 data.web group", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        v2SearchResponse([
          {
            url: "https://docs.firecrawl.dev/contributing/self-host",
            title: "Self-hosting Firecrawl",
            description: "Self-host Firecrawl with Docker Compose.",
          },
          {
            url: "https://github.com/firecrawl/firecrawl/blob/main/SELF_HOST.md",
            title: "firecrawl/SELF_HOST.md at main - GitHub",
            description: "Self-hosting Firecrawl guide.",
            category: "github",
          },
          { url: "https://example.com/third", title: "Third", description: "Past the limit." },
        ]),
      ),
    );

    const result = await executeBrowserTool("browser.search", { ...searchArgs, limit: 2 }, config([]));

    expect(result).toMatchObject({ backend: "firecrawl", backendUsed: true, fallbackUsed: false });
    expect(result.results).toEqual([
      {
        title: "Self-hosting Firecrawl",
        url: "https://docs.firecrawl.dev/contributing/self-host",
        snippet: "Self-host Firecrawl with Docker Compose.",
      },
      {
        title: "firecrawl/SELF_HOST.md at main - GitHub",
        url: "https://github.com/firecrawl/firecrawl/blob/main/SELF_HOST.md",
        snippet: "Self-hosting Firecrawl guide.",
      },
    ]);
  });

  it("filters v2 web results through grant host and private-host boundaries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        v2SearchResponse([
          { url: "https://other.example/docs", title: "Outside the grant", description: "Blocked result" },
          { url: "http://169.254.169.254/latest", title: "Metadata", description: "Private result" },
          { url: "https://allowed.example/docs", title: "Allowed", description: "Allowed result" },
        ]),
      ),
    );

    const result = await executeBrowserTool("browser.search", { ...searchArgs, limit: 5 }, config([]), {
      matchedGrantAllowedHosts: ["allowed.example"],
    });

    expect(result.results).toEqual([
      { title: "Allowed", url: "https://allowed.example/docs", snippet: "Allowed result" },
    ]);
  });
});
