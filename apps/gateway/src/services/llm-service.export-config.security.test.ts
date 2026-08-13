import { describe, expect, it } from "vitest";
import { previewHostsMatch } from "./llm-service.js";

// Regression coverage for CODEX_FINDING #15 (LLM config endpoint leaked
// provider.request) and #25a + #30 (LLM model preview piggybacking on
// stored secrets via baseUrl swap). Both fixes rely on careful boundary
// checks; this suite exercises the boundary helpers without standing up a
// full LlmService instance.

describe("previewHostsMatch (codex #25a, #30)", () => {
  it("returns true when both URLs share the same host", () => {
    expect(previewHostsMatch("https://api.openai.com/v1", "https://api.openai.com/v1/models")).toBe(true);
  });

  it("returns true when only the path/query/default port differs but origin matches", () => {
    expect(previewHostsMatch("https://api.openai.com/v1", "https://api.openai.com:443/anything")).toBe(true);
  });

  it("returns false when only the scheme differs", () => {
    expect(previewHostsMatch("https://api.openai.com/v1", "http://api.openai.com/v1")).toBe(false);
  });

  it("returns false when the host differs", () => {
    expect(previewHostsMatch("https://api.openai.com/v1", "https://attacker.example/v1")).toBe(false);
  });

  it("returns false when the requested URL is on a private/metadata host", () => {
    expect(previewHostsMatch("https://api.openai.com/v1", "http://169.254.169.254/latest/")).toBe(false);
  });

  it("returns true when the configured baseUrl is missing/blank", () => {
    // No previously-configured host => no inheritance hazard to guard against.
    expect(previewHostsMatch(undefined, "https://api.attacker.example/v1")).toBe(true);
    expect(previewHostsMatch("  ", "https://api.attacker.example/v1")).toBe(true);
  });

  it("treats malformed URLs as mismatched", () => {
    expect(previewHostsMatch("not-a-url", "https://api.openai.com/v1")).toBe(false);
    expect(previewHostsMatch("https://api.openai.com/v1", "not-a-url")).toBe(false);
  });

  it("is case-insensitive on host", () => {
    expect(previewHostsMatch("https://API.OpenAI.COM/v1", "https://api.openai.com/v1")).toBe(true);
  });
});
