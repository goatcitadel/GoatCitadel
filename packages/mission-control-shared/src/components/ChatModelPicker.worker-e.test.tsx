import React from "react";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatModelPicker, type ChatModelProviderOption } from "./ChatModelPicker";

function findText(node: unknown, text: string): boolean {
  return JSON.stringify(node).includes(text);
}

const providers: ChatModelProviderOption[] = [
  {
    providerId: "openai",
    label: "OpenAI",
    availabilityLabel: "OpenAI ready",
    models: ["gpt-5.4-mini", "gpt-5.4"],
  },
  {
    providerId: "local",
    label: "Local runtime",
    models: [],
  },
];

describe("ChatModelPicker", () => {
  it("disables provider and model controls when no providers are available", () => {
    const renderer = create(<ChatModelPicker providers={[]} onChangeProvider={vi.fn()} onChangeModel={vi.fn()} />);

    expect(findText(renderer.toJSON(), "No provider selected yet. Connect a provider in Configure")).toBe(true);
    expect(renderer.root.findByType("select").props.disabled).toBe(true);
    expect(renderer.root.findByType("button").props.disabled).toBe(true);
  });

  it("uses a pending provider while model discovery is loading", () => {
    const renderer = create(
      <ChatModelPicker
        providers={providers}
        providerId="openai"
        pendingProviderId="local"
        modelLoading
        onChangeProvider={vi.fn()}
        onChangeModel={vi.fn()}
      />,
    );

    expect(findText(renderer.toJSON(), "Loading models for Local runtime...")).toBe(true);
    expect(findText(renderer.toJSON(), "Loading models...")).toBe(true);
    expect(renderer.root.findByType("select").props.value).toBe("local");
    expect(renderer.root.findByType("button").props.disabled).toBe(true);
  });

  it("shows provider hints or empty-model guidance for the active provider", () => {
    const hinted = create(
      <ChatModelPicker
        providers={[{ ...providers[1]!, availabilityHint: "Start the local runtime first." }]}
        providerId="local"
        onChangeProvider={vi.fn()}
        onChangeModel={vi.fn()}
      />,
    );
    expect(findText(hinted.toJSON(), "Start the local runtime first.")).toBe(true);

    const empty = create(
      <ChatModelPicker
        providers={[providers[1]!]}
        providerId="local"
        onChangeProvider={vi.fn()}
        onChangeModel={vi.fn()}
      />,
    );
    expect(findText(empty.toJSON(), "No models available for Local runtime yet.")).toBe(true);
  });

  it("shows active model contextWindow when LlmRuntimeConfig provides it", () => {
    const renderer = create(
      <ChatModelPicker
        providers={[
          {
            providerId: "openai-codex",
            label: "OpenAI Codex",
            models: ["gpt-5.5"],
          },
        ]}
        providerId="openai-codex"
        model="gpt-5.5"
        activeModelContextWindow={272_000}
        activeModelOutputTokenLimit={32_000}
        onChangeProvider={vi.fn()}
        onChangeModel={vi.fn()}
      />,
    );

    const rendered = renderer.toJSON();
    expect(findText(rendered, "272K")).toBe(true);
    expect(findText(rendered, "272,000")).toBe(true);
  });

  it("renders abbreviated millions for very large active model contextWindows", () => {
    const renderer = create(
      <ChatModelPicker
        providers={[
          {
            providerId: "anthropic",
            label: "Anthropic",
            models: ["claude-opus-4-7"],
          },
        ]}
        providerId="anthropic"
        model="claude-opus-4-7"
        activeModelContextWindow={1_000_000}
        onChangeProvider={vi.fn()}
        onChangeModel={vi.fn()}
      />,
    );

    const rendered = renderer.toJSON();
    expect(findText(rendered, "1M")).toBe(true);
    expect(findText(rendered, "1,000,000")).toBe(true);
  });

  it("renders boundary contextWindow value 999_999 as 1M abbreviation", () => {
    const renderer = create(
      <ChatModelPicker
        providers={[
          {
            providerId: "anthropic",
            label: "Anthropic",
            models: ["claude-opus-4-7"],
          },
        ]}
        providerId="anthropic"
        model="claude-opus-4-7"
        activeModelContextWindow={999_999}
        onChangeProvider={vi.fn()}
        onChangeModel={vi.fn()}
      />,
    );

    const rendered = renderer.toJSON();
    expect(findText(rendered, "1M")).toBe(true);
    expect(findText(rendered, "1000K")).toBe(false);
  });

  it("shows provider context cost and capability metadata", () => {
    const renderer = create(
      <ChatModelPicker
        providers={[
          {
            providerId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            models: ["gpt-5.4"],
            contextWindowTokens: 128000,
            inputCostPerMillionTokens: 1.25,
            outputCostPerMillionTokens: 10,
            capabilities: { voiceInput: true, imageGenerate: true },
            modelProbeState: "ready",
            modelProbeSource: "live",
          },
        ]}
        providerId="openai"
        model="gpt-5.4"
        onChangeProvider={vi.fn()}
        onChangeModel={vi.fn()}
      />,
    );

    const rendered = renderer.toJSON();
    expect(findText(rendered, "128,000 tokens")).toBe(true);
    expect(findText(rendered, "$1.250/M input")).toBe(true);
    expect(findText(rendered, "$10.00/M output")).toBe(true);
    expect(findText(rendered, "voice in · image gen")).toBe(true);
    expect(findText(rendered, "ready via live")).toBe(true);
  });

  it("surfaces model probe warnings and stale catalog metadata", () => {
    const renderer = create(
      <ChatModelPicker
        providers={[
          {
            providerId: "custom",
            label: "Custom gateway",
            models: ["custom-model"],
            modelProbeState: "error",
            modelProbeSource: "error_fallback",
            modelProbeWarning: "401 Unauthorized",
            modelRefreshStatus: "stale",
          },
        ]}
        providerId="custom"
        model="custom-model"
        onChangeProvider={vi.fn()}
        onChangeModel={vi.fn()}
      />,
    );

    const rendered = renderer.toJSON();
    expect(findText(rendered, "401 Unauthorized")).toBe(true);
    expect(findText(rendered, "error via fallback after probe error · stale catalog")).toBe(true);
  });
});
