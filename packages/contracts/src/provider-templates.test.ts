import { describe, expect, it } from "vitest";
import {
  builtinProviderProfiles,
  findBuiltinProviderProfile,
  findProviderTemplate,
  inferProviderForModelId,
  providerAllowsForeignModelIds,
} from "./provider-templates.js";

describe("provider templates", () => {
  it("uses GPT-5.4 defaults for OpenAI-family templates", () => {
    expect(findProviderTemplate("openai")?.defaultModel).toBe("gpt-5.4");
    expect(findProviderTemplate("openai")?.apiStyle).toBe("openai-responses");
    expect(findProviderTemplate("openai")?.knownModels).toEqual([
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5-mini",
      "gpt-4.1-mini",
      "gpt-4o-mini",
      "chat-latest",
    ]);
    expect(findProviderTemplate("openrouter")?.defaultModel).toBe("openai/gpt-5.4");
    expect(findProviderTemplate("openrouter")?.apiStyle).toBe("openai-chat-completions");
    expect(findProviderTemplate("openrouter")?.knownModels).toEqual([
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
      "anthropic/claude-sonnet-4",
      "google/gemini-2.5-flash",
      "zai/glm-5v-turbo",
    ]);
    expect(findProviderTemplate("vercel")?.defaultModel).toBe("openai/gpt-5.4");
  });

  it("openai template recognizes chat-latest as a known model", () => {
    const tpl = findProviderTemplate("openai");
    expect(tpl?.knownModels).toContain("chat-latest");
  });

  it("ships OpenAI Codex OAuth as a separate provider template", () => {
    expect(findProviderTemplate("openai-codex")).toMatchObject({
      label: "OpenAI Codex (ChatGPT OAuth)",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      defaultModel: "gpt-5.5",
      apiStyle: "openai-codex-responses",
      knownModels: ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini"],
    });
  });

  it("exposes built-in provider profiles without changing template behavior", () => {
    expect(builtinProviderProfiles).toHaveLength(21);
    expect(findBuiltinProviderProfile("openai")).toMatchObject({
      profileId: "builtin:openai",
      source: "builtin",
      status: "builtin",
      apiStyle: "openai-responses",
      defaultModel: "gpt-5.4",
    });
    expect(findBuiltinProviderProfile("openrouter")?.modelDiscovery).toMatchObject({
      type: "openrouter",
      refreshIntervalHours: 24,
    });
  });

  it("marks Anthropic as a native messages provider", () => {
    expect(findProviderTemplate("anthropic")?.apiStyle).toBe("anthropic-messages");
    expect(findProviderTemplate("anthropic")?.knownModels).toEqual([
      "claude-sonnet-4-6",
      "claude-sonnet-4",
      "claude-opus-4",
    ]);
    expect(findProviderTemplate("claude-code")).toMatchObject({
      label: "Claude Code (Claude subscription)",
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-sonnet-4-6",
      apiStyle: "anthropic-messages",
      knownModels: ["claude-sonnet-4-6", "claude-sonnet-4", "claude-opus-4"],
    });
  });

  it("includes a fallback Google Gemini shortlist for offline model pickers", () => {
    expect(findProviderTemplate("google")?.knownModels).toEqual([
      "models/gemini-2.5-flash",
      "models/gemini-2.5-flash-lite",
      "models/gemini-2.5-pro",
      "models/gemini-flash-latest",
      "gemini-3.1-flash-image-preview",
      "gemini-3-pro-image-preview",
      "gemini-2.5-flash-image",
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

  it("includes DeepSeek V4 fallback models for offline model pickers", () => {
    expect(findProviderTemplate("deepseek")).toMatchObject({
      defaultModel: "deepseek-v4-pro",
      knownModels: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    });
    expect(inferProviderForModelId("deepseek-v4-pro")).toBe("deepseek");
  });

  it("includes GLM fallback models for direct Z.AI and OpenRouter pickers", () => {
    expect(findProviderTemplate("glm")?.knownModels).toEqual([
      "glm-5",
      "glm-5-air",
      "glm-5-flash",
      "glm-5-turbo",
      "glm-5v-turbo",
    ]);
    expect(findProviderTemplate("openrouter")?.knownModels).toContain("zai/glm-5v-turbo");
  });

  it("infers canonical providers for known model ids", () => {
    expect(inferProviderForModelId("gpt-5.4-mini")).toBe("openai");
    expect(inferProviderForModelId("claude-sonnet-4-6")).toBe("anthropic");
    expect(inferProviderForModelId("models/gemini-2.5-flash")).toBe("google");
    expect(inferProviderForModelId("gemini-3-pro-image-preview")).toBe("google");
    expect(inferProviderForModelId("openai/gpt-5.4-mini")).toBe("openai");
    expect(inferProviderForModelId("openai-codex/gpt-5.5")).toBe("openai-codex");
    expect(inferProviderForModelId("anthropic/claude-sonnet-4")).toBe("anthropic");
    expect(inferProviderForModelId("claude-code/claude-sonnet-4")).toBe("claude-code");
    expect(inferProviderForModelId("zai/glm-5v-turbo")).toBe("glm");
    expect(inferProviderForModelId("custom-private-model")).toBeUndefined();
  });

  it("marks pass-through providers as capable of foreign model ids", () => {
    expect(providerAllowsForeignModelIds("openrouter")).toBe(true);
    expect(providerAllowsForeignModelIds("vercel")).toBe(true);
    expect(providerAllowsForeignModelIds("ollama")).toBe(true);
    expect(providerAllowsForeignModelIds("llamacpp")).toBe(true);
    expect(providerAllowsForeignModelIds("openai")).toBe(false);
    expect(providerAllowsForeignModelIds("anthropic")).toBe(false);
  });

  it("ships a llama.cpp local preset for Gemma 4", () => {
    expect(findProviderTemplate("llamacpp")).toMatchObject({
      label: "llama.cpp",
      baseUrl: "http://127.0.0.1:8080/v1",
      defaultModel: "gemma-4-local",
      apiStyle: "openai-chat-completions",
    });
  });
});
