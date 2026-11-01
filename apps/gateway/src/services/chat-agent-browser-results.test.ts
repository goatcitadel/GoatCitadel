import { describe, expect, it } from "vitest";
import {
  buildBrowserFallbackChainEntry,
  classifyBrowserToolResult,
  normalizeBrowserToolResult,
} from "./chat-agent-browser-results.js";

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

describe("remote block detection", () => {
  const article = `Why Americans Are Working Less. ${"Average weekly hours fell for full-time employees. ".repeat(60)}`;

  it("reads a full article as content even when its footer mentions reCAPTCHA", () => {
    const result = {
      url: "https://www.gallup.com/workplace/658235/why-americans-working-less.aspx",
      title: "Why Americans Are Working Less",
      status: 200,
      textSnippet: `${article}\n\nThis site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.`,
    };

    expect(classifyBrowserToolResult("browser.navigate", result)).toEqual({});
  });

  it("still blocks a short challenge page, and a long page whose title is the challenge", () => {
    const challenge = {
      url: "https://example.com/a",
      title: "Verify you are human",
      status: 200,
      textSnippet: "Please complete the captcha below to continue.",
    };
    const titled = { url: "https://example.com/b", title: "Just a moment...", status: 200, textSnippet: article };

    expect(classifyBrowserToolResult("browser.navigate", challenge)).toEqual({
      failureClass: "remote_blocked",
      error: "remote site blocked automation (captcha challenge 200)",
    });
    expect(classifyBrowserToolResult("browser.navigate", titled)).toMatchObject({ failureClass: "remote_blocked" });
  });
});
