import { describe, expect, it } from "vitest";
import { buildModelCommandSuggestions, buildOrchestrationCommandSuggestions } from "./chat-command-suggestions";

const providers = [
  {
    providerId: "anthropic",
    label: "Anthropic",
    models: ["claude-sonnet-4.5", " claude-opus-4.1 "],
  },
  {
    providerId: "openai",
    label: "OpenAI",
    models: ["gpt-5.5", "gpt-5.4-mini", ""],
  },
  {
    providerId: "local",
    label: "Local",
    models: ["llama-3.3"],
  },
];

describe("buildModelCommandSuggestions", () => {
  it("returns no suggestions outside the /model command", () => {
    expect(buildModelCommandSuggestions({ draft: "hello", providers })).toEqual([]);
    expect(buildModelCommandSuggestions({ draft: "/models", providers })).toEqual([]);
  });

  it("prioritizes the active provider and trims command values", () => {
    const suggestions = buildModelCommandSuggestions({
      draft: "   /model",
      providers,
      activeProviderId: "openai",
      limit: 3,
    });

    expect(suggestions).toEqual([
      {
        key: "model-openai-gpt-5.4-mini",
        command: "/model openai/gpt-5.4-mini",
        description: "OpenAI · active provider",
        applyValue: "/model openai/gpt-5.4-mini",
      },
      {
        key: "model-openai-gpt-5.5",
        command: "/model openai/gpt-5.5",
        description: "OpenAI · active provider",
        applyValue: "/model openai/gpt-5.5",
      },
      {
        key: "model-anthropic-claude-opus-4.1",
        command: "/model anthropic/claude-opus-4.1",
        description: "Anthropic",
        applyValue: "/model anthropic/claude-opus-4.1",
      },
    ]);
  });

  it("scores exact, prefix, and contains matches for filtered queries", () => {
    expect(
      buildModelCommandSuggestions({
        draft: "/model gpt-5.5",
        providers,
        activeProviderId: "anthropic",
      }).map((item) => item.command),
    ).toEqual(["/model openai/gpt-5.5"]);

    expect(
      buildModelCommandSuggestions({
        draft: "/model sonnet",
        providers,
      }).map((item) => item.command),
    ).toEqual(["/model anthropic/claude-sonnet-4.5"]);

    expect(
      buildModelCommandSuggestions({
        draft: "/model claude-",
        providers,
      }).map((item) => item.command),
    ).toEqual(["/model anthropic/claude-sonnet-4.5", "/model anthropic/claude-opus-4.1"]);
  });
});

describe("buildOrchestrationCommandSuggestions", () => {
  it("returns /btw before other orchestration commands and preserves typed aside text", () => {
    expect(buildOrchestrationCommandSuggestions({ draft: "/btw" })).toEqual([
      {
        key: "btw-side-chat",
        command: "/btw <aside>",
        description: "Open a small side chat tied to this thread without adding to the main transcript.",
        applyValue: "/btw ",
      },
    ]);
    expect(buildOrchestrationCommandSuggestions({ draft: "   /btw   keep this aside " })[0]).toMatchObject({
      command: "/btw <aside>",
      applyValue: "/btw keep this aside",
    });
    expect(buildOrchestrationCommandSuggestions({ draft: "/btween" })).toEqual([]);
  });
});
