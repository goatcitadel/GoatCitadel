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
});
