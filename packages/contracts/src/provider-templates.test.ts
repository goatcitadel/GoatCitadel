import { describe, expect, it } from "vitest";
import { findProviderTemplate } from "./provider-templates.js";

describe("provider templates", () => {
  it("uses GPT-5.4-mini defaults for OpenAI-family templates", () => {
    expect(findProviderTemplate("openai")?.defaultModel).toBe("gpt-5.4-mini");
    expect(findProviderTemplate("openai")?.apiStyle).toBe("openai-responses");
    expect(findProviderTemplate("openai")?.knownModels).toEqual([
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5-mini",
      "gpt-4.1-mini",
      "gpt-4o-mini",
    ]);
    expect(findProviderTemplate("openrouter")?.defaultModel).toBe("openai/gpt-5.4-mini");
    expect(findProviderTemplate("openrouter")?.apiStyle).toBe("openai-chat-completions");
    expect(findProviderTemplate("openrouter")?.knownModels).toEqual([
      "openai/gpt-5.4-mini",
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4",
      "google/gemini-2.5-flash",
    ]);
    expect(findProviderTemplate("vercel")?.defaultModel).toBe("openai/gpt-5.4-mini");
  });

  it("marks Anthropic as a native messages provider", () => {
    expect(findProviderTemplate("anthropic")?.apiStyle).toBe("anthropic-messages");
    expect(findProviderTemplate("anthropic")?.knownModels).toEqual([
      "claude-sonnet-4-6",
      "claude-sonnet-4",
      "claude-opus-4",
    ]);
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

  it("includes Perplexity models for unsupported /models endpoints", () => {
    expect(findProviderTemplate("perplexity")?.knownModels).toEqual([
      "sonar",
      "sonar-pro",
      "sonar-reasoning-pro",
      "sonar-deep-research",
    ]);
  });
});
