import { describe, expect, it } from "vitest";
import { buildModelCommandSuggestions } from "./chat-command-suggestions";

describe("buildModelCommandSuggestions", () => {
  const providers = [
    {
      providerId: "openai",
      label: "OpenAI",
      models: ["gpt-5.4", "gpt-5.4-mini", "o4-mini"],
    },
    {
      providerId: "moonshot",
      label: "Moonshot",
      models: ["kimi-k2", "gpt-5.4"],
    },
  ];

  it("prioritizes active provider matches and keeps provider-qualified duplicates visible", () => {
    const suggestions = buildModelCommandSuggestions({
      draft: "/model gpt",
      providers,
      activeProviderId: "openai",
    });

    expect(suggestions.map((item) => item.command)).toEqual([
      "/model openai/gpt-5.4",
      "/model openai/gpt-5.4-mini",
      "/model moonshot/gpt-5.4",
    ]);
    expect(suggestions[0]?.description).toContain("active provider");
  });

  it("supports partial model-id filtering when the model id is not known exactly", () => {
    const suggestions = buildModelCommandSuggestions({
      draft: "/model kimi",
      providers,
      activeProviderId: "openai",
    });

    expect(suggestions).toEqual([
      {
        key: "model-moonshot-kimi-k2",
        command: "/model moonshot/kimi-k2",
        description: "Moonshot",
        applyValue: "/model moonshot/kimi-k2",
      },
    ]);
  });
});
