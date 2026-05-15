import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("radix-ui", async () => {
  const ReactModule = await import("react");
  const primitive = (tag: string) =>
    ReactModule.forwardRef<unknown, Record<string, unknown> & { asChild?: boolean; children?: React.ReactNode }>(
      ({ asChild, children, ...props }, ref) => {
        const forwardedProps = { ...(props as Record<string, unknown>), ref } as Record<string, unknown> &
          React.RefAttributes<unknown>;
        if (asChild && ReactModule.isValidElement(children)) {
          return ReactModule.cloneElement(children as React.ReactElement<Record<string, unknown>>, forwardedProps);
        }
        return ReactModule.createElement(tag, forwardedProps, children as React.ReactNode);
      },
    );

  return {
    Dialog: {
      Root: primitive("section"),
      Trigger: primitive("button"),
      Portal: primitive("div"),
      Close: primitive("button"),
      Overlay: primitive("div"),
      Content: primitive("article"),
      Title: primitive("h2"),
      Description: primitive("p"),
    },
    Popover: {
      Root: primitive("section"),
      Trigger: primitive("button"),
      Portal: primitive("div"),
      Content: primitive("aside"),
      Anchor: primitive("span"),
    },
  };
});

import { GCModal } from "./GCModal";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./popover";

function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => textOf(child)).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return textOf((node as { children?: unknown }).children);
  }
  if (typeof node === "object" && "props" in node) {
    return textOf((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

function button(renderer: ReactTestRenderer, label: string) {
  const match = renderer.root.findAllByType("button").find((node) => textOf(node).includes(label));
  if (!match) {
    throw new Error(`Button not found: ${label}`);
  }
  return match;
}

describe("popover primitives", () => {
  it("renders anchor, header, title, description, and custom aligned content", () => {
    const renderer = create(
      <Popover open>
        <PopoverAnchor className="anchor-extra">Anchor</PopoverAnchor>
        <PopoverTrigger>Open context</PopoverTrigger>
        <PopoverContent align="start" sideOffset={12} className="content-extra">
          <PopoverHeader className="header-extra">
            <PopoverTitle className="title-extra">Trace context</PopoverTitle>
            <PopoverDescription className="description-extra">Correlation details</PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>,
    );

    expect(renderer.root.findByProps({ "data-slot": "popover" }).props.open).toBe(true);
    expect(renderer.root.findByProps({ "data-slot": "popover-anchor" }).props.className).toContain("anchor-extra");
    expect(renderer.root.findByProps({ "data-slot": "popover-trigger" }).props.children).toBe("Open context");
    expect(renderer.root.findByProps({ "data-slot": "popover-content" }).props.align).toBe("start");
    expect(renderer.root.findByProps({ "data-slot": "popover-content" }).props.sideOffset).toBe(12);
    expect(renderer.root.findByProps({ "data-slot": "popover-content" }).props.className).toContain("content-extra");
    expect(renderer.root.findByProps({ "data-slot": "popover-header" }).props.className).toContain("header-extra");
    expect(renderer.root.findByProps({ "data-slot": "popover-title" }).props.className).toContain("title-extra");
    expect(renderer.root.findByProps({ "data-slot": "popover-description" }).props.className).toContain(
      "description-extra",
    );
    expect(textOf(renderer.root)).toContain("Correlation details");
  });
});

describe("GCModal", () => {
  it("honors dismiss guards and confirm state", async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn(async () => undefined);
    const renderer = create(
      <GCModal
        open
        onOpenChange={onOpenChange}
        title="Reject approval"
        description="This will stop the pending action."
        danger
        confirmLabel="Reject"
        cancelLabel="Keep pending"
        confirmPending
        dismissDisabled
        onConfirm={onConfirm}
      >
        Approval details
      </GCModal>,
    );

    const root = renderer.root.findByProps({ "data-slot": "dialog" });
    act(() => {
      root.props.onOpenChange(false);
    });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(button(renderer, "Keep pending").props.disabled).toBe(true);
    expect(button(renderer, "Working...").props.disabled).toBe(true);
    expect(textOf(renderer.root)).toContain("Approval details");
  });

  it("supports ordinary cancel and confirm callbacks", () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    const renderer = create(
      <GCModal open onOpenChange={onOpenChange} title="Approve action" confirmLabel="Approve" onConfirm={onConfirm} />,
    );

    act(() => {
      renderer.root.findByProps({ "data-slot": "dialog" }).props.onOpenChange(false);
      button(renderer, "Cancel").props.onClick();
      button(renderer, "Approve").props.onClick();
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
