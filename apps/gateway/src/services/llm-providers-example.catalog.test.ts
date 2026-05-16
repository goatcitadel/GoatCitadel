import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { LlmConfigFile } from "@goatcitadel/contracts";

describe("config/llm-providers.example.json catalog", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const config = JSON.parse(
    readFileSync(join(repoRoot, "config", "llm-providers.example.json"), "utf8"),
  ) as LlmConfigFile;
  const ids = config.providers.map((p) => p.providerId);

  it("includes the xAI Grok provider with grok-4.3 default", () => {
    expect(ids).toContain("xai");
    const xai = config.providers.find((p) => p.providerId === "xai");
    expect(xai?.defaultModel).toBe("grok-4.3");
    expect(xai?.baseUrl).toBe("https://api.x.ai/v1");
    expect(xai?.apiStyle).toBe("openai-chat-completions");
    expect(xai?.apiKeyEnv).toBe("XAI_API_KEY");
  });

  it("DeepSeek default model is deepseek-v4-pro", () => {
    const deepseek = config.providers.find((p) => p.providerId === "deepseek");
    expect(deepseek?.defaultModel).toBe("deepseek-v4-pro");
  });

  it("Moonshot Kimi default model is kimi-k2.6", () => {
    const moonshot = config.providers.find((p) => p.providerId === "moonshot");
    expect(moonshot?.defaultModel).toBe("kimi-k2.6");
  });

  it("OpenAI Codex remains gpt-5.5", () => {
    const codex = config.providers.find((p) => p.providerId === "openai-codex");
    expect(codex?.defaultModel).toBe("gpt-5.5");
  });
});
