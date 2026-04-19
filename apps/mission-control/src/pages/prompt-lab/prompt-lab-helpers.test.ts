import { describe, expect, it } from "vitest";
import type { ChatModelProviderOption } from "../../components/ChatModelPicker";
import { resolvePromptLabActiveProvider } from "./prompt-lab-helpers";

const PROVIDERS: ChatModelProviderOption[] = [
  {
    providerId: "openai",
    label: "OpenAI",
    models: ["gpt-5.4", "gpt-5.4-mini"],
  },
  {
    providerId: "llamacpp",
    label: "llama.cpp",
    models: ["gemma-4-local"],
  },
  {
    providerId: "anthropic",
    label: "Anthropic",
    models: ["claude-sonnet-4-6"],
  },
];

describe("resolvePromptLabActiveProvider", () => {
  it("prefers the explicit in-page selection when it is still valid", () => {
    expect(
      resolvePromptLabActiveProvider(PROVIDERS, {
        selectedProviderId: "anthropic",
        runtimeActiveProviderId: "llamacpp",
      })?.providerId,
    ).toBe("anthropic");
  });

  it("defaults Prompt Lab to openai before the runtime active provider", () => {
    expect(
      resolvePromptLabActiveProvider(PROVIDERS, {
        runtimeActiveProviderId: "llamacpp",
      })?.providerId,
    ).toBe("openai");
  });

  it("falls back to the runtime active provider when openai is unavailable", () => {
    expect(
      resolvePromptLabActiveProvider(PROVIDERS.filter((provider) => provider.providerId !== "openai"), {
        runtimeActiveProviderId: "llamacpp",
      })?.providerId,
    ).toBe("llamacpp");
  });

  it("falls back to the first provider when neither the preferred nor active provider is available", () => {
    expect(
      resolvePromptLabActiveProvider(PROVIDERS.filter((provider) => provider.providerId !== "openai"), {
        runtimeActiveProviderId: "missing",
      })?.providerId,
    ).toBe("llamacpp");
  });
});
