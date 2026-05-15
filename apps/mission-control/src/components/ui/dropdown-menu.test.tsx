import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("radix-ui", async () => {
  const ReactModule = await import("react");
  const primitive = (tag: string) =>
    ReactModule.forwardRef<unknown, Record<string, unknown> & { asChild?: boolean; children?: React.ReactNode }>(
      ({ asChild, children, ...props }, ref) => {
        if (asChild && ReactModule.isValidElement(children)) {
          return ReactModule.cloneElement(children, props as Record<string, unknown>);
        }
        return ReactModule.createElement(
          tag,
          { ...(props as Record<string, unknown>), ref },
          children as React.ReactNode,
        );
      },
    );

  return {
    DropdownMenu: {
      Root: primitive("section"),
      Portal: primitive("div"),
      Trigger: primitive("button"),
      Content: primitive("article"),
      Group: primitive("div"),
      Item: primitive("button"),
      CheckboxItem: primitive("button"),
      ItemIndicator: primitive("span"),
      RadioGroup: primitive("div"),
      RadioItem: primitive("button"),
      Label: primitive("div"),
      Separator: primitive("hr"),
      Sub: primitive("section"),
      SubTrigger: primitive("button"),
      SubContent: primitive("article"),
    },
  };
});

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

function slot(renderer: ReactTestRenderer, name: string) {
  return renderer.root.findByProps({ "data-slot": name });
}

describe("dropdown menu primitives", () => {
  it("renders the root, trigger, content, and item slots with caller props preserved", () => {
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    const renderer = create(
      <DropdownMenu open onOpenChange={onOpenChange}>
        <DropdownMenuTrigger onClick={() => onOpenChange(false)}>Actions</DropdownMenuTrigger>
        <DropdownMenuContent className="menu-body" align="end" sideOffset={12}>
          <DropdownMenuGroup className="menu-group">
            <DropdownMenuLabel className="menu-label" inset>
              Operators
            </DropdownMenuLabel>
            <DropdownMenuItem className="menu-item" inset onClick={onSelect}>
              Promote
              <DropdownMenuShortcut className="menu-shortcut">P</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive">Remove</DropdownMenuItem>
            <DropdownMenuSeparator className="menu-separator" />
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(slot(renderer, "dropdown-menu").props.open).toBe(true);
    expect(slot(renderer, "dropdown-menu-trigger").props.children).toBe("Actions");
    expect(slot(renderer, "dropdown-menu-content").props.align).toBe("end");
    expect(slot(renderer, "dropdown-menu-content").props.sideOffset).toBe(12);
    expect(slot(renderer, "dropdown-menu-content").props.className).toContain("menu-body");
    expect(slot(renderer, "dropdown-menu-group").props.className).toContain("menu-group");
    expect(slot(renderer, "dropdown-menu-label").props["data-inset"]).toBe(true);
    expect(slot(renderer, "dropdown-menu-label").props.className).toContain("menu-label");
    expect(slot(renderer, "dropdown-menu-shortcut").props.className).toContain("menu-shortcut");
    expect(slot(renderer, "dropdown-menu-separator").props.className).toContain("menu-separator");

    const items = renderer.root.findAllByProps({ "data-slot": "dropdown-menu-item" });
    const promote = items.find((node) => String(node.props.className ?? "").includes("menu-item"));
    const remove = items.find((node) => node.children.includes("Remove"));
    expect(promote?.props["data-inset"]).toBe(true);
    expect(promote?.props["data-variant"]).toBe("default");
    expect(promote?.props.className).toContain("menu-item");
    expect(remove?.props["data-variant"]).toBe("destructive");

    act(() => {
      slot(renderer, "dropdown-menu-trigger").props.onClick();
      promote?.props.onClick();
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders checkbox, radio, portal, and sub-menu composition", () => {
    const renderer = create(
      <>
        <DropdownMenuPortal>Detached</DropdownMenuPortal>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked className="checkbox-extra" inset>
            Enabled
          </DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value="fast">
            <DropdownMenuRadioItem value="fast" className="radio-extra" inset>
              Fast
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger className="sub-trigger" inset>
              More
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sub-content">Nested action</DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </>,
    );

    expect(slot(renderer, "dropdown-menu-portal").props.children).toBe("Detached");
    expect(slot(renderer, "dropdown-menu-checkbox-item").props.checked).toBe(true);
    expect(slot(renderer, "dropdown-menu-checkbox-item").props["data-inset"]).toBe(true);
    expect(slot(renderer, "dropdown-menu-checkbox-item").props.className).toContain("checkbox-extra");
    expect(renderer.root.findAllByProps({ "data-slot": "dropdown-menu-checkbox-item-indicator" })).toHaveLength(1);
    expect(slot(renderer, "dropdown-menu-radio-group").props.value).toBe("fast");
    expect(slot(renderer, "dropdown-menu-radio-item").props.value).toBe("fast");
    expect(slot(renderer, "dropdown-menu-radio-item").props["data-inset"]).toBe(true);
    expect(slot(renderer, "dropdown-menu-radio-item").props.className).toContain("radio-extra");
    expect(slot(renderer, "dropdown-menu-sub").props.open).toBe(true);
    expect(slot(renderer, "dropdown-menu-sub-trigger").props["data-inset"]).toBe(true);
    expect(slot(renderer, "dropdown-menu-sub-trigger").props.className).toContain("sub-trigger");
    expect(slot(renderer, "dropdown-menu-sub-content").props.className).toContain("sub-content");
  });
});
