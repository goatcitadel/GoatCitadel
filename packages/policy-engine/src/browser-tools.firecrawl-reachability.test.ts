import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { executeBrowserTool } from "./browser-tools.js";
import { FirecrawlUnavailableError, resetFirecrawlReachabilityForTests } from "./firecrawl-reachability.js";

function config(networkAllowlist: string[]): ToolPolicyConfig {
  return {
    profiles: { minimal: ["browser.*"] },
    tools: { profile: "minimal", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: ["C:\\tmp"],
      readOnlyRoots: ["C:\\tmp"],
      networkAllowlist,
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

const searchArgs = { query: "q", backend: "firecrawl", firecrawlFallbackToNative: false };

describe("Firecrawl reachability breaker in browser tools", () => {
  afterEach(() => {
    resetFirecrawlReachabilityForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("skips Firecrawl without a network call while it is cooling down", async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeBrowserTool("browser.search", searchArgs, config(["*"]))).rejects.toThrow();
    await expect(executeBrowserTool("browser.search", searchArgs, config(["*"]))).rejects.toBeInstanceOf(
      FirecrawlUnavailableError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cool down on an HTTP error response", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeBrowserTool("browser.search", searchArgs, config(["*"]))).rejects.toThrow(
      /Firecrawl search failed \(500/,
    );
    await expect(executeBrowserTool("browser.search", searchArgs, config(["*"]))).rejects.toThrow(
      /Firecrawl search failed \(500/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not trip the breaker when the turn was cancelled", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (): Promise<Response> => {
      controller.abort(new Error("turn cancelled"));
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeBrowserTool("browser.search", searchArgs, config(["*"]), { signal: controller.signal }),
    ).rejects.toThrow();
    fetchMock.mockImplementation(async () => new Response("", { status: 500 }));
    await expect(executeBrowserTool("browser.search", searchArgs, config(["*"]))).rejects.toThrow(
      /Firecrawl search failed \(500/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
