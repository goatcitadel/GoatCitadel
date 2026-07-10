import { describe, expect, it } from "vitest";
import { sanitizeChannelOutboundMessage } from "./channel-sanitizer.js";

describe("sanitizeChannelOutboundMessage", () => {
  it("removes angle and bracket internal markup blocks", () => {
    const result = sanitizeChannelOutboundMessage(
      'Visible <thinking data-kind="x">secret</thinking> [tool_call id=1]hidden[/tool_call] done',
    );

    expect(result.message).toBe("Visible   done");
    expect(result.removedBlockCount).toBe(2);
  });

  it("removes internal html comments without stripping ordinary comments", () => {
    const result = sanitizeChannelOutboundMessage("Visible <!--thinking secret -->done <!-- public note -->");

    expect(result.message).toBe("Visible done <!-- public note -->");
    expect(result.removedBlockCount).toBe(1);
  });

  it("scans repeated internal comment openings without regex backtracking", () => {
    const noisyPrefix = "<!--internal ".repeat(2_000);
    const result = sanitizeChannelOutboundMessage(`Visible ${noisyPrefix}secret -->done`);

    expect(result.message).toBe("Visible done");
    expect(result.removedBlockCount).toBe(1);
  });

  it("redacts labeled secrets without swallowing following text", () => {
    const result = sanitizeChannelOutboundMessage(
      'Visible api-key="abcDEF123._~+/" token: qwerty1234, password=plainsecret done',
    );

    expect(result.message).toBe('Visible api-key="[REDACTED]" token: [REDACTED], password=[REDACTED] done');
    expect(result.redactedSecretCount).toBe(3);
  });

  it("redacts bearer tokens and url credentials with bounded scanning", () => {
    const noisyAuthorizationPrefix = "Authorization: ".repeat(2_000);
    const noisyUrlPrefix = "https://".repeat(2_000);

    const bearerResult = sanitizeChannelOutboundMessage(`${noisyAuthorizationPrefix}Bearer abcDEF-._~+/== done`);
    const credentialResult = sanitizeChannelOutboundMessage(`${noisyUrlPrefix}user:p@example.test/path`);

    expect(bearerResult.message).toBe("Authorization: [REDACTED]");
    expect(bearerResult.message).not.toContain("abcDEF");
    expect(bearerResult.redactedSecretCount).toBe(1);
    expect(credentialResult.message).toContain("[REDACTED]@example.test/path");
    expect(credentialResult.redactedSecretCount).toBe(1);
  });

  it("redacts containing keys and quoted keys inside messages", () => {
    const result = sanitizeChannelOutboundMessage(
      'stripe_api_key="abcDEF123._~+/" "git_token": qwerty1234, \'my_password\'=plainsecret done',
    );

    expect(result.message).toBe('stripe_api_key="[REDACTED]" "git_token": [REDACTED], \'my_password\'=[REDACTED] done');
    expect(result.redactedSecretCount).toBe(3);
  });

  it("redacts sk-proj project keys", () => {
    const result = sanitizeChannelOutboundMessage("Here is my key: sk-proj-1234567890abcdefghijklmnopqrstuvwxyz");
    expect(result.message).toBe("Here is my key: [REDACTED]");
    expect(result.redactedSecretCount).toBe(1);
  });
});
