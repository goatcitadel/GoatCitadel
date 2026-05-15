import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from "./input-group";

describe("InputGroup", () => {
  it("renders grouped controls with stable data slots and default button behavior", () => {
    const renderer = create(
      <InputGroup className="custom-group">
        <InputGroupAddon align="inline-start">
          <InputGroupText>$</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput aria-label="Amount" defaultValue="42" />
        <InputGroupButton>Apply</InputGroupButton>
        <InputGroupTextarea aria-label="Notes" defaultValue="memo" />
      </InputGroup>,
    );

    const group = renderer.root.findByProps({ "data-slot": "input-group" });
    expect(group.props.role).toBe("group");
    expect(group.props.className).toContain("custom-group");
    expect(renderer.root.findByProps({ "data-slot": "input-group-addon" }).props["data-align"]).toBe("inline-start");
    expect(
      renderer.root.findAll(
        (node) => typeof node.type === "string" && node.props["data-slot"] === "input-group-control",
      ),
    ).toHaveLength(2);

    const button = renderer.root.findByType("button");
    expect(button.props.type).toBe("button");
    expect(button.props["data-size"]).toBe("xs");
  });

  it("focuses the input from an addon click unless the click came from a nested button", () => {
    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    const renderer = create(
      <InputGroup>
        <InputGroupAddon align="block-end">Prefix</InputGroupAddon>
        <InputGroupInput aria-label="Name" />
      </InputGroup>,
    );
    const addon = renderer.root.findByProps({ "data-slot": "input-group-addon" });

    act(() => {
      addon.props.onClick({
        target: { closest: vi.fn(() => null) },
        currentTarget: { parentElement: { querySelector } },
      });
    });
    expect(querySelector).toHaveBeenCalledWith("input");
    expect(focus).toHaveBeenCalled();

    querySelector.mockClear();
    act(() => {
      addon.props.onClick({
        target: { closest: vi.fn(() => ({ tagName: "BUTTON" })) },
        currentTarget: { parentElement: { querySelector } },
      });
    });
    expect(querySelector).not.toHaveBeenCalled();
  });
});
