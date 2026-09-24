import { describe, expect, it } from "vitest";
import { supportsOpenAiFastMode } from "./openai-model-controls.js";

describe("supportsOpenAiFastMode", () => {
  it("accepts documented OpenAI families on API and OAuth routes", () => {
    expect(supportsOpenAiFastMode("openai", "gpt-6-astra")).toBe(true);
    expect(supportsOpenAiFastMode("openai", "gpt-5.6-sol")).toBe(true);
    expect(supportsOpenAiFastMode("openai-codex", "openai-codex/gpt-6-luna")).toBe(true);
    expect(supportsOpenAiFastMode("openai-codex", "gpt-5.5")).toBe(true);
  });

  it("does not promise Fast for older or unrelated models", () => {
    expect(supportsOpenAiFastMode("openai", "gpt-4o-mini")).toBe(false);
    expect(supportsOpenAiFastMode("openai", "gpt-5.5-pro")).toBe(false);
    expect(supportsOpenAiFastMode("openai", "text-embedding-3-large")).toBe(false);
    expect(supportsOpenAiFastMode("anthropic", "gpt-6-sol")).toBe(false);
  });
});
