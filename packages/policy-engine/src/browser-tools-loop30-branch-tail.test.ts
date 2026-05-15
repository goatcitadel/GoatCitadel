import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeBrowserTool, isBrowserToolName } from "./browser-tools.js";

function config(): ToolPolicyConfig {
  return {
    profiles: { danger: ["browser.*"] },
    tools: { profile: "danger", allow: [], deny: [] },
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

describe("browser tools loop 30 branch tails", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("recognizes browser tool names exactly", () => {
    expect(isBrowserToolName("browser.search")).toBe(true);
    expect(isBrowserToolName("browser.storage.get")).toBe(true);
    expect(isBrowserToolName("browser.unknown")).toBe(false);
    expect(isBrowserToolName("fs.read")).toBe(false);
  });

  it("surfaces Firecrawl failures when native fallback is disabled", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 503, statusText: "Unavailable" })) as any;
    await expect(
      executeBrowserTool(
        "browser.search",
        {
          query: "coverage",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1:3002",
          firecrawlFallbackToNative: false,
        },
        config(),
      ),
    ).rejects.toThrow(/Firecrawl search failed/i);
  });
});
