import { describe, expect, it } from "vitest";
import {
  builtinProviderProfiles,
  findBuiltinProviderProfile,
  findProviderTemplate,
  inferProviderForModelId,
  providerTemplates,
  providerAllowsForeignModelIds,
  providerRecognizesModelId,
} from "./provider-templates.js";

describe("provider templates", () => {
  it("uses GPT-5.4 defaults for OpenAI-family templates", () => {
    expect(findProviderTemplate("openai")?.defaultModel).toBe("gpt-5.4");
    expect(findProviderTemplate("openai")?.apiStyle).toBe("openai-responses");
    // Assert the anchors that matter (default + routing-critical members), not the exact
    // catalog — pinning the full array churns the test on every model addition.
    const openaiModels = findProviderTemplate("openai")?.knownModels ?? [];
    expect(openaiModels).toContain("gpt-5.6");
    expect(openaiModels).toContain("gpt-5.6-terra");
    expect(openaiModels).toContain("gpt-5.6-luna");
    expect(openaiModels).toContain("gpt-5.4");
    expect(openaiModels).toContain("gpt-5.4-mini");
    expect(openaiModels).toContain("chat-latest");
    expect(findProviderTemplate("openrouter")?.defaultModel).toBe("openai/gpt-5.4");
    expect(findProviderTemplate("openrouter")?.apiStyle).toBe("openai-chat-completions");
    const openrouterModels = findProviderTemplate("openrouter")?.knownModels ?? [];
    expect(openrouterModels).toContain("openai/gpt-5.4");
    expect(openrouterModels).toContain("anthropic/claude-sonnet-4");
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
    });
    const codexModels = findProviderTemplate("openai-codex")?.knownModels ?? [];
    expect(codexModels).not.toContain("gpt-5.6");
    expect(codexModels).toContain("gpt-5.6-sol");
    expect(codexModels).toContain("gpt-5.6-terra");
    expect(codexModels).toContain("gpt-5.6-luna");
    expect(codexModels).toContain("gpt-5.5");
  });

  it("exposes built-in provider profiles without changing template behavior", () => {
    expect(builtinProviderProfiles).toHaveLength(providerTemplates.length);
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
    const anthropicModels = findProviderTemplate("anthropic")?.knownModels ?? [];
    expect(anthropicModels).toContain("claude-opus-4-8");
    expect(anthropicModels).toContain("claude-fable-5");
    expect(anthropicModels).toContain("claude-sonnet-4-6");
    expect(findProviderTemplate("claude-code")).toMatchObject({
      label: "Claude Code (Claude subscription)",
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-sonnet-4-6",
      apiStyle: "anthropic-messages",
    });
    expect(findProviderTemplate("claude-code")?.knownModels).toContain("claude-sonnet-4-6");
  });

  it("includes a fallback Google Gemini shortlist for offline model pickers", () => {
    const googleModels = findProviderTemplate("google")?.knownModels ?? [];
    expect(googleModels).toContain("models/gemini-2.5-flash");
    expect(googleModels).toContain("models/gemini-2.5-pro");
  });

  it("ships governed Vertex AI and Fireworks provider templates", () => {
    expect(findProviderTemplate("vertex")).toMatchObject({
      label: "Google Vertex AI",
      apiStyle: "openai-chat-completions",
      authMode: "google-adc",
      defaultModel: "google/gemini-2.5-flash",
      googleCloud: { location: "us-central1", endpointId: "openapi" },
    });
    expect(findProviderTemplate("vertex")?.capabilities?.reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(providerRecognizesModelId("vertex", "google/gemini-2.5-pro")).toBe(true);

    expect(findProviderTemplate("fireworks")).toMatchObject({
      label: "Fireworks AI",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      apiStyle: "openai-chat-completions",
      defaultModel: "accounts/fireworks/models/kimi-k2p6",
    });
    expect(providerAllowsForeignModelIds("fireworks")).toBe(true);
  });

  it("includes a fallback MiniMax shortlist for offline model pickers", () => {
    const minimaxModels = findProviderTemplate("minimax")?.knownModels ?? [];
    expect(minimaxModels).toContain("MiniMax-M2.7");
    expect(minimaxModels).toContain("MiniMax-M2");
  });

  it("includes Perplexity models for unsupported /models endpoints", () => {
    const perplexityModels = findProviderTemplate("perplexity")?.knownModels ?? [];
    expect(perplexityModels).toContain("sonar");
    expect(perplexityModels).toContain("sonar-pro");
  });

  it("includes DeepSeek V4 fallback models for offline model pickers", () => {
    expect(findProviderTemplate("deepseek")).toMatchObject({
      defaultModel: "deepseek-v4-pro",
    });
    expect(findProviderTemplate("deepseek")?.knownModels).toContain("deepseek-v4-pro");
    expect(inferProviderForModelId("deepseek-v4-pro")).toBe("deepseek");
  });

  it("includes GLM fallback models for direct Z.AI and OpenRouter pickers", () => {
    const glmModels = findProviderTemplate("glm")?.knownModels ?? [];
    expect(glmModels).toContain("glm-5");
    expect(glmModels).toContain("glm-5v-turbo");
    expect(findProviderTemplate("openrouter")?.knownModels).toContain("zai/glm-5v-turbo");
  });

  it("infers canonical providers for known model ids", () => {
    expect(inferProviderForModelId("gpt-5.4-mini")).toBe("openai");
    expect(inferProviderForModelId("claude-sonnet-4-6")).toBe("anthropic");
    expect(inferProviderForModelId("models/gemini-2.5-flash")).toBe("google");
    expect(inferProviderForModelId("gemini-3-pro-image-preview")).toBe("google");
    expect(inferProviderForModelId("openai/gpt-5.4-mini")).toBe("openai");
    expect(inferProviderForModelId("openai/gpt-5.6")).toBe("openai");
    expect(inferProviderForModelId("openai-codex/gpt-5.6")).toBe("openai-codex");
    expect(inferProviderForModelId("openai-codex/gpt-5.5")).toBe("openai-codex");
    expect(inferProviderForModelId("anthropic/claude-sonnet-4")).toBe("anthropic");
    expect(inferProviderForModelId("claude-code/claude-sonnet-4")).toBe("claude-code");
    expect(inferProviderForModelId("zai/glm-5v-turbo")).toBe("glm");
    expect(inferProviderForModelId("custom-private-model")).toBeUndefined();
  });

  it("recognizes shared bare model ids for each provider that explicitly supports them", () => {
    expect(providerRecognizesModelId("openai", "gpt-5.6")).toBe(true);
    expect(providerRecognizesModelId("openai-codex", "gpt-5.6")).toBe(false);
    expect(providerRecognizesModelId("openai-codex", "gpt-5.6-sol")).toBe(true);
    expect(providerRecognizesModelId("openai-codex", "gpt-5.6-terra")).toBe(true);
    expect(providerRecognizesModelId("openai-codex", "gpt-5.6-luna")).toBe(true);
    expect(providerRecognizesModelId("openai-codex", "gpt-5.4")).toBe(true);
    expect(providerRecognizesModelId("openai-codex", "openai/gpt-5.6")).toBe(false);
    expect(providerRecognizesModelId("openai-codex", "openai-codex/gpt-5.4")).toBe(true);
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
