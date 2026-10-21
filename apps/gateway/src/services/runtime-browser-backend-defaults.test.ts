import { describe, expect, it } from "vitest";
import type { WebRuntimeConfig } from "../config.js";
import {
  applyRuntimeBrowserBackendDefaults,
  isFirecrawlBaseUrlAllowlisted,
} from "./runtime-browser-backend-defaults.js";

function web(
  overrides: Partial<WebRuntimeConfig["firecrawl"]> = {},
  engineOrder?: WebRuntimeConfig["search"],
): WebRuntimeConfig {
  return {
    firecrawl: {
      enabled: true,
      baseUrl: "https://api.firecrawl.dev",
      apiKeyEnv: "FIRECRAWL_API_KEY",
      timeoutMs: 20_000,
      defaultReadBackend: "firecrawl",
      fallbackToNative: true,
      ...overrides,
    },
    ...(engineOrder ? { search: engineOrder } : {}),
  };
}

const search = (args: Record<string, unknown> = { query: "goats" }) =>
  ({ toolName: "browser.search", args, agentId: "assistant", sessionId: "s-1" }) as never;

describe("applyRuntimeBrowserBackendDefaults", () => {
  it("routes defaulted reads to an allowlisted hosted Firecrawl", () => {
    const result = applyRuntimeBrowserBackendDefaults(search(), web(), ["api.firecrawl.dev"]) as {
      args: Record<string, unknown>;
    };
    expect(result.args).toMatchObject({
      backend: "firecrawl",
      firecrawlBaseUrl: "https://api.firecrawl.dev",
      firecrawlFallbackToNative: true,
    });
  });

  it("uses native search instead of a Firecrawl URL that skipped the allowlist guard", () => {
    const result = applyRuntimeBrowserBackendDefaults(search(), web(), []) as { args: Record<string, unknown> };
    expect(result.args.backend).toBeUndefined();
    expect(result.args.firecrawlBaseUrl).toBeUndefined();
  });

  it("drops an explicit Firecrawl read to native when fallback is allowed", () => {
    const explicit = applyRuntimeBrowserBackendDefaults(search({ query: "q", backend: "firecrawl" }), web(), []) as {
      args: Record<string, unknown>;
    };
    expect(explicit.args.backend).toBe("native");

    const strict = applyRuntimeBrowserBackendDefaults(
      search({ query: "q", backend: "firecrawl" }),
      web({ fallbackToNative: false }),
      [],
    ) as { args: Record<string, unknown> };
    expect(strict.args.backend).toBe("firecrawl");
  });

  it("keeps a defaulted Firecrawl read when the operator turned native fallback off", () => {
    const result = applyRuntimeBrowserBackendDefaults(search(), web({ fallbackToNative: false }), []) as {
      args: Record<string, unknown>;
    };
    expect(result.args).toMatchObject({ backend: "firecrawl", firecrawlFallbackToNative: false });
  });

  it("injects the operator engine order into browser.search only", () => {
    const config = web({ enabled: false }, { engineOrder: ["bing", "google"] });
    const searched = applyRuntimeBrowserBackendDefaults(search(), config, []) as { args: Record<string, unknown> };
    expect(searched.args.searchEngineOrder).toEqual(["bing", "google"]);

    const navigated = applyRuntimeBrowserBackendDefaults(
      { toolName: "browser.navigate", args: { url: "https://example.com" } } as never,
      config,
      [],
    ) as { args: Record<string, unknown> };
    expect(navigated.args.searchEngineOrder).toBeUndefined();
  });

  it("falls back to the default engine order when none is configured", () => {
    const result = applyRuntimeBrowserBackendDefaults(search(), web({ enabled: false }), []) as {
      args: Record<string, unknown>;
    };
    expect(result.args.searchEngineOrder).toEqual(["duckduckgo", "bing", "google"]);
  });
});

describe("isFirecrawlBaseUrlAllowlisted", () => {
  it("mirrors the policy engine host rules", () => {
    expect(isFirecrawlBaseUrlAllowlisted("http://127.0.0.1:3002", [])).toBe(true);
    expect(isFirecrawlBaseUrlAllowlisted("https://api.firecrawl.dev", ["api.firecrawl.dev"])).toBe(true);
    expect(isFirecrawlBaseUrlAllowlisted("https://api.firecrawl.dev", [])).toBe(false);
    expect(isFirecrawlBaseUrlAllowlisted("http://192.168.1.20:3002", ["192.168.1.20:3002"])).toBe(false);
    expect(isFirecrawlBaseUrlAllowlisted("not a url", ["*"])).toBe(false);
  });
});
