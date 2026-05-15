import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { GCSegmentedControl } from "./GCSegmentedControl";

function findRadio(renderer: ReactTestRenderer, label: string) {
  const radio = renderer.root.findAll((node) => node.props.role === "radio" && node.children.includes(label))[0];
  if (!radio) {
    throw new Error(`Unable to find segmented control option: ${label}`);
  }
  return radio;
}

describe("GCSegmentedControl", () => {
  it("selects options by click and skips disabled options during keyboard navigation", () => {
    const onChange = vi.fn();
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = create(
        <GCSegmentedControl
          ariaLabel="Mode"
          value="chat"
          onChange={onChange}
          options={[
            { value: "chat", label: "Chat" },
            { value: "cowork", label: "Cowork", disabled: true },
            { value: "code", label: "Code" },
          ]}
        />,
      );
    });

    expect(findRadio(renderer!, "Chat").props["aria-checked"]).toBe(true);
    expect(findRadio(renderer!, "Cowork").props.disabled).toBe(true);

    act(() => {
      findRadio(renderer!, "Chat").props.onKeyDown({
        key: "ArrowRight",
        preventDefault: vi.fn(),
      });
    });
    expect(onChange).toHaveBeenLastCalledWith("code");

    act(() => {
      findRadio(renderer!, "Chat").props.onKeyDown({
        key: "End",
        preventDefault: vi.fn(),
      });
    });
    expect(onChange).toHaveBeenLastCalledWith("code");

    act(() => {
      findRadio(renderer!, "Code").props.onKeyDown({
        key: "ArrowLeft",
        preventDefault: vi.fn(),
      });
    });
    expect(onChange).toHaveBeenLastCalledWith("chat");

    act(() => {
      findRadio(renderer!, "Code").props.onClick();
    });
    expect(onChange).toHaveBeenLastCalledWith("code");
  });

  it("ignores navigation from disabled options and wraps home/end to enabled options", () => {
    const onChange = vi.fn();
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = create(
        <GCSegmentedControl
          ariaLabel="Route"
          value="tasks"
          onChange={onChange}
          options={[
            { value: "chat", label: "Chat" },
            { value: "tasks", label: "Tasks" },
            { value: "admin", label: "Admin", disabled: true },
          ]}
        />,
      );
    });

    act(() => {
      findRadio(renderer!, "Admin").props.onKeyDown({
        key: "Home",
        preventDefault: vi.fn(),
      });
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      findRadio(renderer!, "Tasks").props.onKeyDown({
        key: "Home",
        preventDefault: vi.fn(),
      });
    });
    expect(onChange).toHaveBeenLastCalledWith("chat");

    act(() => {
      findRadio(renderer!, "Chat").props.onKeyDown({
        key: "ArrowUp",
        preventDefault: vi.fn(),
      });
    });
    expect(onChange).toHaveBeenLastCalledWith("tasks");
  });

  it("keeps non-navigation keys local and does not move when every option is disabled", () => {
    const onChange = vi.fn();
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = create(
        <GCSegmentedControl
          ariaLabel="Disabled route"
          className="custom-segment"
          value="chat"
          onChange={onChange}
          options={[
            { value: "chat", label: "Chat", disabled: true },
            { value: "cowork", label: "Cowork", disabled: true },
          ]}
        />,
      );
    });

    const preventDefault = vi.fn();
    expect(renderer!.root.findByProps({ role: "radiogroup" }).props["aria-label"]).toBe("Disabled route");
    expect(renderer!.root.findByProps({ role: "radiogroup" }).props.className).toContain("custom-segment");

    act(() => {
      findRadio(renderer!, "Chat").props.onKeyDown({
        key: "ArrowRight",
        preventDefault,
      });
      findRadio(renderer!, "Chat").props.onKeyDown({
        key: "Enter",
        preventDefault,
      });
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
