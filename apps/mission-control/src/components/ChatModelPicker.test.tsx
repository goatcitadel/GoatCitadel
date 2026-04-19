import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatModelPicker, type ChatModelProviderOption } from "./ChatModelPicker";

vi.mock("./ui", () => ({
  GCSelect: (props: Record<string, unknown>) => <div data-testid="gc-select" {...props} />,
  GCCombobox: (props: Record<string, unknown>) => <div data-testid="gc-combobox" {...props} />,
}));

const SMALL_PROVIDER: ChatModelProviderOption = {
  providerId: "openai",
  label: "OpenAI",
  models: ["gpt-5.4", "gpt-5.4-mini"],
};

const LARGE_PROVIDER: ChatModelProviderOption = {
  providerId: "openrouter",
  label: "OpenRouter",
  models: Array.from({ length: 15 }, (_value, index) => `model-${index}`),
};

describe("ChatModelPicker", () => {
  it("always renders the model selector as a combobox for small model lists", () => {
    const renderer = create(
      <ChatModelPicker
        providers={[SMALL_PROVIDER]}
        providerId="openai"
        onChangeProvider={vi.fn()}
        onChangeModel={vi.fn()}
      />,
    );

    expect(renderer.root.findAll((node) => node.props["data-testid"] === "gc-combobox")).toHaveLength(1);
    expect(renderer.root.findAll((node) => node.props["data-testid"] === "gc-select")).toHaveLength(1);
  });

  it("keeps the same model control when the active provider model count changes", () => {
    const renderer = create(
      <ChatModelPicker
        providers={[SMALL_PROVIDER, LARGE_PROVIDER]}
        providerId="openai"
        onChangeProvider={vi.fn()}
        onChangeModel={vi.fn()}
      />,
    );

    expect(renderer.root.findAll((node) => node.props["data-testid"] === "gc-combobox")).toHaveLength(1);

    renderer.update(
      <ChatModelPicker
        providers={[SMALL_PROVIDER, LARGE_PROVIDER]}
        providerId="openrouter"
        onChangeProvider={vi.fn()}
        onChangeModel={vi.fn()}
      />,
    );

    expect(renderer.root.findAll((node) => node.props["data-testid"] === "gc-combobox")).toHaveLength(1);
    expect(renderer.root.findAll((node) => node.props["data-testid"] === "gc-select")).toHaveLength(1);
  });
});
