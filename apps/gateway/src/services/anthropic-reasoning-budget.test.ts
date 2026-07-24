import { describe, expect, it } from "vitest";
import {
  assertAnthropicThinkingFitsMaxTokens,
  resolveAnthropicEffort,
  resolveAnthropicMaxTokensForVisibleOutput,
  resolveAnthropicThinkingBudgetTokens,
  resolveAnthropicThinkingMode,
} from "./anthropic-reasoning-budget.js";

describe("Anthropic reasoning budgets", () => {
  it("maps every governed reasoning effort to one bounded thinking budget", () => {
    expect(resolveAnthropicThinkingBudgetTokens("none")).toBeUndefined();
    expect(resolveAnthropicThinkingBudgetTokens("low")).toBe(1_024);
    expect(resolveAnthropicThinkingBudgetTokens("medium")).toBe(4_096);
    expect(resolveAnthropicThinkingBudgetTokens("high")).toBe(8_192);
    expect(resolveAnthropicThinkingBudgetTokens("xhigh")).toBe(16_384);
    expect(resolveAnthropicThinkingBudgetTokens("max")).toBe(32_768);
    expect(resolveAnthropicThinkingBudgetTokens("ultra")).toBe(65_536);
  });

  it("adds a visible-answer allowance above the thinking budget", () => {
    expect(resolveAnthropicMaxTokensForVisibleOutput({ effort: "xhigh", visibleOutputTokenBudget: 1_600 })).toBe(
      17_984,
    );
    expect(resolveAnthropicMaxTokensForVisibleOutput({ effort: "none", visibleOutputTokenBudget: 1_600 })).toBe(1_600);
  });

  it("rejects explicit max token caps that cannot contain the thinking budget", () => {
    expect(() => assertAnthropicThinkingFitsMaxTokens({ effort: "medium", maxTokens: 4_096 })).toThrow(
      /must be greater/i,
    );
    expect(() => assertAnthropicThinkingFitsMaxTokens({ effort: "medium", maxTokens: 4_097 })).not.toThrow();
  });

  it("classifies manual, adaptive opt-in, adaptive default, and always-on model families", () => {
    expect(resolveAnthropicThinkingMode("claude-opus-4-5")).toBe("manual");
    expect(resolveAnthropicThinkingMode("claude-sonnet-4-6")).toBe("adaptive_opt_in");
    expect(resolveAnthropicThinkingMode("claude-opus-4-8")).toBe("adaptive_opt_in");
    expect(resolveAnthropicThinkingMode("claude-sonnet-5")).toBe("adaptive_default_disable_supported");
    expect(resolveAnthropicThinkingMode("claude-fable-5")).toBe("adaptive_always_on");
    expect(resolveAnthropicThinkingMode("claude-mythos-preview")).toBe("adaptive_always_on");
  });

  it("fails closed when GoatCitadel cannot preserve the requested provider effort", () => {
    expect(resolveAnthropicEffort({ effort: "xhigh", model: "claude-opus-4-8" })).toBe("xhigh");
    expect(() => resolveAnthropicEffort({ effort: "xhigh", model: "claude-sonnet-4-6" })).toThrow(
      /does not support xhigh/i,
    );
    expect(() => resolveAnthropicEffort({ effort: "ultra", model: "claude-opus-4-8" })).toThrow(
      /does not support the ultra/i,
    );
    expect(() => resolveAnthropicEffort({ effort: "none", model: "claude-fable-5" })).toThrow(
      /cannot honor an explicit reasoning-off/i,
    );
  });
});
