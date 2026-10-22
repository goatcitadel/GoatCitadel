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

  it("replaces a caller-supplied engine order so disabled engines stay off", () => {
    const result = applyRuntimeBrowserBackendDefaults(
      search({ query: "q", searchEngineOrder: ["google", "duckduckgo"] }),
      web({ enabled: false }, { engineOrder: ["bing"] }),
      [],
    ) as { args: Record<string, unknown> };
    expect(result.args.searchEngineOrder).toEqual(["bing"]);
  });

  it("reroutes an explicit docs.ingest Firecrawl read when the URL is not allowlisted", () => {
    const ingest = (fallbackToNative: boolean) =>
      applyRuntimeBrowserBackendDefaults(
        {
          toolName: "docs.ingest",
          args: { sourceType: "url", source: "https://example.com", backend: "firecrawl" },
        } as never,
        web({ fallbackToNative }),
        [],
      ) as { args: Record<string, unknown> };

    expect(ingest(true).args).toMatchObject({ backend: "native" });
    expect(ingest(true).args.firecrawlBaseUrl).toBeUndefined();
    expect(ingest(false).args).toMatchObject({ backend: "firecrawl", firecrawlBaseUrl: "https://api.firecrawl.dev" });
  });

  it.each([
    { engine: "brave" },
    { engine: "parallel" },
    { providers: ["brave"] },
    { providers: ["brave", "parallel"], mode: "research" },
  ])("keeps an official selection official: %j", (selection) => {
    const result = applyRuntimeBrowserBackendDefaults(
      search({ query: "goats", ...selection }),
      web({ defaultReadBackend: "firecrawl" }, { engineOrder: ["bing"] }),
      ["api.firecrawl.dev"],
    ) as { args: Record<string, unknown> };
    expect(result.args.backend).toBe("official");
    expect(result.args.firecrawlBaseUrl).toBeUndefined();
    expect(result.args.firecrawlTimeoutMs).toBeUndefined();
    expect(result.args.firecrawlApiKeyEnv).toBeUndefined();
    expect(result.args.firecrawlFallbackToNative).toBeUndefined();
    expect(result.args.searchEngineOrder).toEqual(["bing"]);
  });

  it("still defaults a plain search to Firecrawl when Firecrawl is usable", () => {
    const result = applyRuntimeBrowserBackendDefaults(search({ query: "x" }), web(), ["api.firecrawl.dev"]) as {
      args: Record<string, unknown>;
    };
    expect(result.args.backend).toBe("firecrawl");
  });

  it("leaves an explicit native backend alone even with engine brave", () => {
    const result = applyRuntimeBrowserBackendDefaults(
      search({ query: "x", engine: "brave", backend: "native" }),
      web(),
      ["api.firecrawl.dev"],
    ) as { args: Record<string, unknown> };
    expect(result.args.backend).toBe("native");
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
