import React from "react";
import { create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("@radix-ui/react-select", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");

  function primitive(slot: string, tag: string) {
    return ReactModule.forwardRef<HTMLElement, Record<string, unknown> & { children?: React.ReactNode }>(
      function MockPrimitive({ children, asChild: _asChild, ...props }, ref) {
        return ReactModule.createElement(tag, { ...props, ref, "data-mock-slot": slot }, children as React.ReactNode);
      },
    );
  }

  return {
    Root: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => (
      <div {...props} data-mock-slot="root">
        {children}
      </div>
    ),
    Group: primitive("group", "div"),
    Value: primitive("value", "span"),
    Trigger: primitive("trigger", "button"),
    Icon: ({ children }: { children?: React.ReactNode }) => <span data-mock-slot="icon">{children}</span>,
    Portal: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Content: primitive("content", "div"),
    Viewport: primitive("viewport", "div"),
    Label: primitive("label", "label"),
    Item: primitive("item", "div"),
    ItemIndicator: primitive("item-indicator", "span"),
    ItemText: primitive("item-text", "span"),
    Separator: primitive("separator", "hr"),
    ScrollUpButton: primitive("scroll-up", "button"),
    ScrollDownButton: primitive("scroll-down", "button"),
  };
});

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";

function textContent(node: ReactTestInstance | string | number | null | undefined): string {
  if (node === null || node === undefined) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  return node.children.map((child) => textContent(child as ReactTestInstance | string | number)).join(" ");
}

describe("select primitive wrappers", () => {
  it("renders trigger, value, items, labels, and separators with stable slot metadata", () => {
    const renderer = create(
      <Select value="alpha">
        <SelectTrigger size="sm" className="trigger-extra" aria-invalid>
          <SelectValue placeholder="Choose one">Alpha</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start" className="content-extra">
          <SelectGroup className="group-extra">
            <SelectLabel className="label-extra">Providers</SelectLabel>
            <SelectItem value="alpha" className="item-extra">
              Alpha
            </SelectItem>
            <SelectSeparator className="separator-extra" />
            <SelectItem value="beta">Beta</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    );

    const trigger = renderer.root.findByProps({ "data-slot": "select-trigger" });
    expect(trigger.props["data-size"]).toBe("sm");
    expect(trigger.props.className).toContain("trigger-extra");
    expect(trigger.props.className).toContain("data-[size=sm]:h-7");

    const value = renderer.root.findByProps({ "data-slot": "select-value" });
    expect(textContent(value)).toContain("Alpha");

    const content = renderer.root.findByProps({ "data-slot": "select-content" });
    expect(content.props["data-align-trigger"]).toBe(false);
    expect(content.props.position).toBe("popper");
    expect(content.props.align).toBe("start");
    expect(content.props.className).toContain("content-extra");
    expect(content.props.className).toContain("data-[side=bottom]:translate-y-1");

    expect(renderer.root.findByProps({ "data-slot": "select-group" }).props.className).toContain("group-extra");
    expect(renderer.root.findByProps({ "data-slot": "select-label" }).props.className).toContain("label-extra");
    expect(renderer.root.findByProps({ "data-slot": "select-separator" }).props.className).toContain("separator-extra");
    expect(renderer.root.findAllByProps({ "data-mock-slot": "item" })).toHaveLength(2);
    expect(renderer.root.findAllByProps({ "data-mock-slot": "item-indicator" })).toHaveLength(2);
  });

  it("renders item-aligned content and standalone scroll affordances", () => {
    const renderer = create(
      <>
        <SelectContent>
          <SelectItem value="one">One</SelectItem>
        </SelectContent>
        <SelectScrollUpButton className="up-extra" />
        <SelectScrollDownButton className="down-extra" />
      </>,
    );

    const content = renderer.root.findByProps({ "data-slot": "select-content" });
    expect(content.props["data-align-trigger"]).toBe(true);
    expect(content.props.position).toBe("item-aligned");

    expect(
      renderer.root
        .findAllByProps({ "data-slot": "select-scroll-up-button" })
        .some((node) => String(node.props.className ?? "").includes("up-extra")),
    ).toBe(true);
    expect(
      renderer.root
        .findAllByProps({ "data-slot": "select-scroll-down-button" })
        .some((node) => String(node.props.className ?? "").includes("down-extra")),
    ).toBe(true);
  });
});
