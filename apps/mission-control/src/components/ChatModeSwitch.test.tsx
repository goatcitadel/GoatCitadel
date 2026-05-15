import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("./ui", () => ({
  GCSegmentedControl: ({
    ariaLabel,
    className,
    onChange,
    options,
    value,
  }: {
    ariaLabel: string;
    className?: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string; disabled?: boolean }>;
    value: string;
  }) => (
    <div aria-label={ariaLabel} className={className} data-value={value}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={option.disabled}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

import { ChatModeSwitch } from "./ChatModeSwitch";

describe("ChatModeSwitch", () => {
  it("renders chat, cowork, and code modes and dispatches selection changes", () => {
    const onChange = vi.fn();
    const renderer = create(<ChatModeSwitch value="chat" onChange={onChange} />);

    const buttons = renderer.root.findAllByType("button");
    expect(buttons.map((button) => button.props.children)).toEqual(["Chat", "Cowork", "Code"]);
    expect(buttons[0]?.props["aria-pressed"]).toBe(true);

    act(() => {
      buttons[1]?.props.onClick();
    });

    expect(onChange).toHaveBeenCalledWith("cowork");
  });

  it("disables all mode options while the surface is locked", () => {
    const renderer = create(<ChatModeSwitch value="code" disabled onChange={vi.fn()} />);

    expect(renderer.root.findAllByType("button").every((button) => button.props.disabled)).toBe(true);
  });
});
