import { act, create } from "react-test-renderer";
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

  it("dedupes suggested options, auto-selects the first value, and routes select changes", async () => {
    const onChange = vi.fn();
    const onCustomModeChange = vi.fn();

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <SelectOrCustom
          value=""
          onChange={onChange}
          onCustomModeChange={onCustomModeChange}
          autoSelectFirstOption
          options={[
            { value: "", label: "Blank" },
            { value: "openai", label: "OpenAI" },
            { value: "openai", label: "Duplicate" },
            { value: "anthropic", label: "Anthropic" },
          ]}
        />,
      );
    });

    const picker = renderer.root.find((node) => node.props["data-testid"] === "gc-select");
    expect(picker.props.options).toEqual([
      { value: "openai", label: "OpenAI" },
      { value: "anthropic", label: "Anthropic" },
    ]);
    expect(onChange).toHaveBeenCalledWith("openai");

    act(() => {
      picker.props.onChange("anthropic");
    });

    expect(onCustomModeChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenLastCalledWith("anthropic");
  });

  it("switches between suggested and custom modes without dropping operator-entered values", () => {
    const onChange = vi.fn();
    const onCustomModeChange = vi.fn();
    const renderer = create(
      <SelectOrCustom
        value="custom-model"
        onChange={onChange}
        onCustomModeChange={onCustomModeChange}
        customLabel="Model id"
        customPlaceholder="Enter model"
        inputType="password"
        autoSelectFirstOption
        options={[{ value: "openai", label: "OpenAI" }]}
      />,
    );

    const buttons = renderer.root.findAllByType("button");
    const suggested = buttons[0]!;
    const custom = buttons[1]!;

    expect(renderer.root.findByType("p").children.join("")).toContain("Current value is custom");

    act(() => {
      custom.props.onClick();
    });

    expect(onCustomModeChange).toHaveBeenLastCalledWith(true);
    const input = renderer.root.findByType("input");
    expect(input.props.type).toBe("password");
    expect(input.props.placeholder).toBe("Enter model");

    act(() => {
      input.props.onChange({ target: { value: "next-model" } });
    });
    expect(onChange).toHaveBeenLastCalledWith("next-model");

    act(() => {
      suggested.props.onClick();
    });
    expect(onCustomModeChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenLastCalledWith("openai");
  });
});
