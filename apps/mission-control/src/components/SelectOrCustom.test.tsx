import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { SelectOrCustom } from "./SelectOrCustom";

vi.mock("./ui", () => ({
  GCSelect: (props: Record<string, unknown>) => <div data-testid="gc-select" {...props} />,
}));

describe("SelectOrCustom", () => {
  it("renders the suggested picker through GCSelect with a disabled placeholder for unknown values", () => {
    const renderer = create(
      <SelectOrCustom
        value=""
        onChange={vi.fn()}
        options={[
          { value: "openai", label: "OpenAI" },
          { value: "anthropic", label: "Anthropic" },
        ]}
        customPlaceholder="Choose a provider"
      />,
    );

    const picker = renderer.root.find((node) => node.props["data-testid"] === "gc-select");

    expect(picker.props.options).toEqual([
      { value: "", label: "Choose a provider", disabled: true },
      { value: "openai", label: "OpenAI" },
      { value: "anthropic", label: "Anthropic" },
    ]);
    expect(renderer.root.findAllByType("select")).toHaveLength(0);
  });
});
