import { describe, expect, it } from "vitest";
import { redactSensitivePayload } from "./improvement-common.js";

// Regression coverage for CODEX_FINDING #27: the weekly improvement
// replay job ships transcript excerpts + tool args/results to the
// configured LLM provider for a judge pass. Without redaction, any secret
// that previously appeared in a transcript or tool log leaks. The
// redactor applies pattern-based scrubbing first, then literal-value
// scrubbing for `process.env` values so org-specific secret env vars
// (which we cannot enumerate ahead of time) still get caught.

describe("redactSensitivePayload (codex #27)", () => {
  it("redacts OpenAI-shape keys", () => {
    expect(redactSensitivePayload("call ok with sk-proj-A1b2C3d4E5f6G7h8I9j0", {})).toBe(
      "call ok with [REDACTED]",
    );
  });

  it("redacts Telegram bot tokens", () => {
    expect(redactSensitivePayload("token 1234567890:AAH0123456789012345678901234567890abc", {})).toBe(
      "token [REDACTED]",
    );
  });

  it("redacts Authorization Bearer header values", () => {
    expect(redactSensitivePayload("Authorization: Bearer abc123def456ghi789jkl", {})).toBe(
      "Authorization: [REDACTED]",
    );
  });

  it("redacts GitHub personal access tokens", () => {
    expect(redactSensitivePayload("gh token ghp_aaaaaaaaaaaaaaaaaaaaaaaa", {})).toBe("gh token [REDACTED]");
  });

  it("redacts AWS access keys", () => {
    expect(redactSensitivePayload("env AKIAIOSFODNN7EXAMPLE in args", {})).toBe("env [REDACTED] in args");
  });

  it("redacts email addresses (PII)", () => {
    expect(redactSensitivePayload("user alice@example.com requested", {})).toBe("user [REDACTED] requested");
  });

  it("redacts literal env-resolved values with the env-name marker", () => {
    const env = { FIRECRAWL_API_KEY: "fcrl_abcdefghijklmnop", OPENAI_API_KEY: "sk-test-aaaaaaaaaaaa" };
    const redacted = redactSensitivePayload(
      "headers: { Authorization: Bearer sk-test-aaaaaaaaaaaa, X-Firecrawl: fcrl_abcdefghijklmnop }",
      env,
    );
    expect(redacted).not.toContain("fcrl_abcdefghijklmnop");
    expect(redacted).toContain("[REDACTED_ENV:FIRECRAWL_API_KEY]");
    // sk- value also matched the LLM key pattern, so it could be redacted either way.
    expect(redacted).not.toContain("sk-test-aaaaaaaaaaaa");
  });

  it("ignores empty / short / whitespace env values", () => {
    const env = { SHORT: "abc", BLANK: "   ", WITH_SPACE: "two words go here" };
    const original = "value abc plus two words go here";
    expect(redactSensitivePayload(original, env)).toBe(original);
  });

  it("handles empty input safely", () => {
    expect(redactSensitivePayload("", {})).toBe("");
  });

  it("does not introduce false positives on benign text", () => {
    expect(redactSensitivePayload("the quick brown fox jumped over the lazy dog", {})).toBe(
      "the quick brown fox jumped over the lazy dog",
    );
  });
});
