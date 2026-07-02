import { describe, expect, it } from "vitest";
import { redactSecretText } from "./secret-redaction.js";

describe("redactSecretText", () => {
  it("redacts common provider, channel, and authorization secrets", () => {
    const result = redactSecretText(
      [
        "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz",
        "1234567890:AAH0123456789012345678901234567890abc",
        "ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
        "AKIAIOSFODNN7EXAMPLE",
        "Authorization: Bearer abc123def456ghi789jkl",
      ].join(" "),
    );

    expect(result.value).toBe("[REDACTED] [REDACTED] [REDACTED] [REDACTED] Authorization: [REDACTED]");
    expect(result.redactionCount).toBe(5);
  });

  it("preserves useful key and query structure while redacting values", () => {
    const result = redactSecretText(
      'api-key="abcDEF123._~+/" token: qwerty1234 https://example.test/hook?token=secret-token&ok=1',
    );

    expect(result.value).toBe(
      "api-key=[REDACTED] token: [REDACTED] https://example.test/hook?token=[REDACTED]&ok=1",
    );
    expect(result.redactionCount).toBe(3);
  });

  it("redacts literal env values without redacting short or whitespace values", () => {
    const result = redactSecretText("custom=fcrl_abcdefghijklmnop short=abc spaced=two words", {
      env: {
        FIRECRAWL_API_KEY: "fcrl_abcdefghijklmnop",
        SHORT: "abc",
        SPACED: "two words",
      },
    });

    expect(result.value).toBe("custom=[REDACTED_ENV:FIRECRAWL_API_KEY] short=abc spaced=two words");
    expect(result.redactionCount).toBe(1);
  });
});
