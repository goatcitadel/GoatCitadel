import React from "react";
import { act, create, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("radix-ui", async () => {
  const ReactModule = await import("react");
  const primitive = (tag: string) =>
    ReactModule.forwardRef<unknown, Record<string, unknown> & { children?: React.ReactNode }>(
      ({ children, ...props }, ref) =>
        ReactModule.createElement(tag, { ...(props as Record<string, unknown>), ref }, children as React.ReactNode),
    );

  return {
    Avatar: {
      Root: primitive("div"),
      Image: primitive("img"),
      Fallback: primitive("span"),
    },
  };
});

vi.mock("vaul", async () => {
  const ReactModule = await import("react");
  const primitive = (tag: string) =>
    ReactModule.forwardRef<unknown, Record<string, unknown> & { children?: React.ReactNode }>(
      ({ children, ...props }, ref) =>
        ReactModule.createElement(tag, { ...(props as Record<string, unknown>), ref }, children as React.ReactNode),
    );

  return {
    Drawer: {
      Root: primitive("section"),
      Trigger: primitive("button"),
      Portal: primitive("div"),
      Close: primitive("button"),
      Overlay: primitive("div"),
      Content: primitive("aside"),
      Title: primitive("h2"),
      Description: primitive("p"),
    },
  };
});

import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "./avatar";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer";

function textOf(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join(" ");
  }
  return (node.children ?? []).map((child) => textOf(child as ReactTestRendererJSON | string | null)).join(" ");
}

describe("avatar primitives", () => {
  it("passes slots, sizes, custom classes, and grouped count content through the wrappers", () => {
    const renderer = create(
      <AvatarGroup className="team">
        <Avatar size="lg" className="lead">
          <AvatarImage src="/lead.png" alt="Lead" className="portrait" />
          <AvatarFallback className="initials">GC</AvatarFallback>
          <AvatarBadge className="online">1</AvatarBadge>
        </Avatar>
        <AvatarGroupCount className="overflow">+4</AvatarGroupCount>
      </AvatarGroup>,
    );

    const root = renderer.root;
    expect(root.findByProps({ "data-slot": "avatar-group" }).props.className).toContain("team");
    expect(root.findByProps({ "data-slot": "avatar" }).props["data-size"]).toBe("lg");
    expect(root.findByProps({ "data-slot": "avatar" }).props.className).toContain("lead");
    expect(root.findByProps({ "data-slot": "avatar-image" }).props.className).toContain("portrait");
    expect(root.findByProps({ "data-slot": "avatar-fallback" }).props.className).toContain("initials");
    expect(root.findByProps({ "data-slot": "avatar-badge" }).props.className).toContain("online");
    expect(textOf(renderer.toJSON())).toContain("+4");

    renderer.unmount();
  });
});

describe("drawer primitives", () => {
  it("renders all drawer wrapper slots and delegates trigger/close actions", () => {
    const onOpenChange = vi.fn();
    const onTrigger = vi.fn();
    const onClose = vi.fn();
    const renderer = create(<div />);

    act(() => {
      renderer.update(
        <Drawer open onOpenChange={onOpenChange}>
          <DrawerTrigger onClick={onTrigger}>Open</DrawerTrigger>
          <DrawerContent className="drawer-body">
            <DrawerHeader className="drawer-heading">Heading</DrawerHeader>
            <DrawerTitle className="drawer-title">Runtime Drawer</DrawerTitle>
            <DrawerDescription className="drawer-copy">Drawer details</DrawerDescription>
            <DrawerFooter className="drawer-actions">
              <DrawerClose onClick={onClose}>Close</DrawerClose>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>,
      );
    });

    expect(renderer.root.findByProps({ "data-slot": "drawer" }).props.open).toBe(true);
    expect(renderer.root.findByProps({ "data-slot": "drawer-content" }).props.className).toContain("drawer-body");
    expect(renderer.root.findByProps({ "data-slot": "drawer-header" }).props.className).toContain("drawer-heading");
    expect(renderer.root.findByProps({ "data-slot": "drawer-title" }).props.className).toContain("drawer-title");
    expect(renderer.root.findByProps({ "data-slot": "drawer-description" }).props.className).toContain("drawer-copy");
    expect(renderer.root.findByProps({ "data-slot": "drawer-footer" }).props.className).toContain("drawer-actions");

    act(() => {
      renderer.root.findByProps({ "data-slot": "drawer-trigger" }).props.onClick();
      renderer.root.findByProps({ "data-slot": "drawer-close" }).props.onClick();
    });

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it("supports direct portal and overlay composition for custom drawer layouts", () => {
    const renderer = create(
      <DrawerPortal>
        <DrawerOverlay className="shade" />
      </DrawerPortal>,
    );

    expect(renderer.root.findByProps({ "data-slot": "drawer-portal" })).toBeDefined();
    expect(renderer.root.findByProps({ "data-slot": "drawer-overlay" }).props.className).toContain("shade");

    renderer.unmount();
  });
});
