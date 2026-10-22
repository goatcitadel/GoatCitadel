import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { executeBrowserTool } from "./browser-tools.js";
import {
  FIRECRAWL_UNREACHABLE_COOLDOWN_MS,
  FirecrawlUnavailableError,
  resetFirecrawlReachabilityForTests,
} from "./firecrawl-reachability.js";

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
const navigateArgs = { url: "https://example.com/slow-page", backend: "firecrawl", firecrawlFallbackToNative: false };

function refusedConnection(): TypeError {
  return Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
}

describe("Firecrawl reachability breaker in browser tools", () => {
  afterEach(() => {
    resetFirecrawlReachabilityForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it("does not cool Firecrawl down when a scrape times out on a slow page", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new Error("fetchAllowlisted timed out");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeBrowserTool("browser.navigate", navigateArgs, config(["*"]))).rejects.toThrow(
      "fetchAllowlisted timed out",
    );
    await expect(executeBrowserTool("browser.navigate", navigateArgs, config(["*"]))).rejects.toThrow(
      "fetchAllowlisted timed out",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still cools Firecrawl down when a search times out", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new Error("fetchAllowlisted timed out");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeBrowserTool("browser.search", searchArgs, config(["*"]))).rejects.toThrow(
      "fetchAllowlisted timed out",
    );
    await expect(executeBrowserTool("browser.search", searchArgs, config(["*"]))).rejects.toBeInstanceOf(
      FirecrawlUnavailableError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tries Firecrawl again once the cooldown expires and clears it on a response", async () => {
    const trippedAt = 1_000_000;
    let now = trippedAt;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw refusedConnection();
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeBrowserTool("browser.search", searchArgs, config(["*"]))).rejects.toThrow();
    await expect(executeBrowserTool("browser.search", searchArgs, config(["*"]))).rejects.toBeInstanceOf(
      FirecrawlUnavailableError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += FIRECRAWL_UNREACHABLE_COOLDOWN_MS + 1;
    fetchMock.mockImplementation(async () => Response.json({ success: true, data: [] }));
    await expect(executeBrowserTool("browser.search", searchArgs, config(["*"]))).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Inside the old window, only a deleted entry (not a merely expired one) lets the next call through.
    now = trippedAt + 1;
    await expect(executeBrowserTool("browser.search", searchArgs, config(["*"]))).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
