import { describe, expect, it } from "vitest";
import { findProviderTemplate } from "./provider-templates.js";

describe("provider templates", () => {
  it("uses GPT-5.4-mini defaults for OpenAI-family templates", () => {
    expect(findProviderTemplate("openai")?.defaultModel).toBe("gpt-5.4-mini");
    expect(findProviderTemplate("openrouter")?.defaultModel).toBe("openai/gpt-5.4-mini");
    expect(findProviderTemplate("vercel")?.defaultModel).toBe("openai/gpt-5.4-mini");
  });
});
