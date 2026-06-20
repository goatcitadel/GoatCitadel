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

  it("does not ship active xAI/Grok provider support", () => {
    expect(ids).not.toContain("xai");
    expect(config.providers.some((provider) => /xai|grok/i.test(`${provider.providerId} ${provider.label}`))).toBe(false);
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
