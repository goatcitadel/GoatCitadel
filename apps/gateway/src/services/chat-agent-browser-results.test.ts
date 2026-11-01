import { describe, expect, it } from "vitest";
import { buildBrowserFallbackChainEntry, normalizeBrowserToolResult } from "./chat-agent-browser-results.js";

const BUILTIN = { engineTier: "builtin", engineLabel: "Built-in browser" };

describe("browser engine labels", () => {
  it("labels a result Firecrawl served as Firecrawl, in the result and its fallback chain entry", () => {
    const raw = { action: "search", backend: "firecrawl", results: [{ url: "https://example.com/a" }] };
    const normalized = normalizeBrowserToolResult("browser.search", raw, BUILTIN);
    const entry = buildBrowserFallbackChainEntry({
      toolName: "browser.search",
      ...BUILTIN,
      result: normalized,
      status: "executed",
    });

    expect(normalized).toMatchObject({ engineTier: "firecrawl", engineLabel: "Firecrawl" });
    expect(entry).toMatchObject({ engineTier: "firecrawl", engineLabel: "Firecrawl" });
  });

  it("keeps the built-in label when native served the call, including after a Firecrawl fallback", () => {
    const raw = { action: "navigate", backend: "native", fallbackUsed: true, url: "https://example.com/b" };
    const normalized = normalizeBrowserToolResult("browser.navigate", raw, BUILTIN);
    const entry = buildBrowserFallbackChainEntry({ toolName: "browser.navigate", ...BUILTIN, status: "failed" });

    expect(normalized).toMatchObject(BUILTIN);
    expect(entry).toMatchObject(BUILTIN);
  });
});
