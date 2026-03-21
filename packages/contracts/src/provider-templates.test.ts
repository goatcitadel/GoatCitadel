import { describe, expect, it } from "vitest";
import { findProviderTemplate } from "./provider-templates.js";

describe("provider templates", () => {
  it("uses GPT-5.4-mini defaults for OpenAI-family templates", () => {
    expect(findProviderTemplate("openai")?.defaultModel).toBe("gpt-5.4-mini");
    expect(findProviderTemplate("openrouter")?.defaultModel).toBe("openai/gpt-5.4-mini");
    expect(findProviderTemplate("vercel")?.defaultModel).toBe("openai/gpt-5.4-mini");
  });

  it("includes a fallback Google Gemini shortlist for offline model pickers", () => {
    expect(findProviderTemplate("google")?.knownModels).toEqual([
      "models/gemini-2.5-flash",
      "models/gemini-2.5-flash-lite",
      "models/gemini-2.5-pro",
      "models/gemini-flash-latest",
    ]);
  });

  it("includes a fallback MiniMax shortlist for offline model pickers", () => {
    expect(findProviderTemplate("minimax")?.knownModels).toEqual([
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2",
    ]);
  });
});
