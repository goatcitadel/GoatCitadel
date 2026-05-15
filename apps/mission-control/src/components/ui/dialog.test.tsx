import React from "react";
import { act, create, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("radix-ui", async () => {
  const ReactModule = await import("react");
  const primitive = (tag: string) =>
    ReactModule.forwardRef<unknown, Record<string, unknown> & { asChild?: boolean; children?: React.ReactNode }>(
      ({ asChild, children, ...props }, _ref) => {
        if (asChild && ReactModule.isValidElement(children)) {
          return ReactModule.cloneElement(children, props as Record<string, unknown>);
        }
        return ReactModule.createElement(tag, props as Record<string, unknown>, children as React.ReactNode);
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
  };
});

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

function textOf(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => textOf(child)).join(" ");
  }
  return (node.children ?? []).map((child) => textOf(child as ReactTestRendererJSON | string | null)).join(" ");
}

function reactNodeText(value: unknown): string {
  if (value == null || typeof value === "boolean") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((child) => reactNodeText(child)).join(" ");
  }
  if (typeof value === "object" && "props" in value) {
    return reactNodeText((value as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

describe("dialog primitives", () => {
  it("renders dialog content with header, title, description, footer, and close controls", () => {
    const onOpenChange = vi.fn();
    const onTrigger = vi.fn();
    const onClose = vi.fn();
    const renderer = create(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogTrigger onClick={onTrigger}>Open dialog</DialogTrigger>
        <DialogContent className="dialog-body">
          <DialogHeader className="dialog-heading">Heading</DialogHeader>
          <DialogTitle className="dialog-title">Approval details</DialogTitle>
          <DialogDescription className="dialog-copy">Review the request.</DialogDescription>
          <DialogFooter className="dialog-actions" showCloseButton>
            <DialogClose onClick={onClose}>Dismiss</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    expect(renderer.root.findByProps({ "data-slot": "dialog" }).props.open).toBe(true);
    expect(renderer.root.findByProps({ "data-slot": "dialog-trigger" }).props.children).toBe("Open dialog");
    expect(renderer.root.findByProps({ "data-slot": "dialog-content" }).props.className).toContain("dialog-body");
    expect(renderer.root.findByProps({ "data-slot": "dialog-header" }).props.className).toContain("dialog-heading");
    expect(renderer.root.findByProps({ "data-slot": "dialog-title" }).props.className).toContain("dialog-title");
    expect(renderer.root.findByProps({ "data-slot": "dialog-description" }).props.className).toContain("dialog-copy");
    expect(renderer.root.findByProps({ "data-slot": "dialog-footer" }).props.className).toContain("dialog-actions");
    expect(textOf(renderer.toJSON())).toContain("Close");

    act(() => {
      renderer.root.findByProps({ "data-slot": "dialog-trigger" }).props.onClick();
      renderer.root
        .findAllByProps({ "data-slot": "dialog-close" })
        .find((node) => reactNodeText(node.props.children).includes("Dismiss"))
        ?.props.onClick();
    });

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it("supports custom portal and overlay composition and hidden close buttons", () => {
    const renderer = create(
      <>
        <DialogPortal>
          <DialogOverlay className="shade" />
        </DialogPortal>
        <DialogContent className="without-close" showCloseButton={false}>
          Custom content
        </DialogContent>
      </>,
    );

    expect(renderer.root.findAllByProps({ "data-slot": "dialog-portal" }).length).toBeGreaterThan(0);
    expect(
      renderer.root
        .findAllByProps({ "data-slot": "dialog-overlay" })
        .find((node) => String(node.props.className ?? "").includes("shade"))?.props.className,
    ).toContain("shade");
    expect(renderer.root.findByProps({ "data-slot": "dialog-content" }).props.className).toContain("without-close");
    expect(textOf(renderer.toJSON())).not.toContain("Close");

    renderer.unmount();
  });
});
