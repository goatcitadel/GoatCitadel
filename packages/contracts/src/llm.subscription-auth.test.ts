import { describe, expect, it } from "vitest";
import { isSubscriptionAuthMode, LLM_PROVIDER_AUTH_MODES } from "./llm.js";

describe("isSubscriptionAuthMode", () => {
  it("names exactly the sign-in modes that bill a subscription", () => {
    expect(LLM_PROVIDER_AUTH_MODES.filter(isSubscriptionAuthMode)).toEqual([
      "codex-oauth",
      "claude-code-oauth",
      "claude-code-cli-login",
    ]);
    expect(isSubscriptionAuthMode(undefined)).toBe(false);
  });
});
