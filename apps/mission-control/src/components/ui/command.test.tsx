import React from "react";
import { act, create, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("cmdk", async () => {
  const ReactModule = await import("react");

  const primitive = (tag: string) =>
    ReactModule.forwardRef<unknown, Record<string, unknown> & { children?: React.ReactNode }>(
      ({ children, ...props }, ref) =>
        ReactModule.createElement(tag, { ...props, ref, "data-cmdk-mock": tag }, children as React.ReactNode),
    );

  const Command = Object.assign(primitive("div"), {
    Input: primitive("input"),
    List: primitive("ul"),
    Empty: primitive("p"),
    Group: primitive("section"),
    Separator: primitive("hr"),
    Item: primitive("button"),
  });

  return { Command };
});

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <section {...props} data-slot="dialog">
      {children}
    </section>
  ),
  DialogContent: ({
    children,
    showCloseButton,
    ...props
  }: Record<string, unknown> & { children?: React.ReactNode; showCloseButton?: boolean }) => (
    <article {...props} data-show-close-button={showCloseButton} data-slot="dialog-content">
      {children}
    </article>
  ),
  DialogDescription: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <p {...props} data-slot="dialog-description">
      {children}
    </p>
  ),
  DialogHeader: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <header {...props} data-slot="dialog-header">
      {children}
    </header>
  ),
  DialogTitle: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <h2 {...props} data-slot="dialog-title">
      {children}
    </h2>
  ),
}));

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./command";

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

describe("command primitive wrappers", () => {
  it("renders the command shell, search input, list states, groups, items, shortcuts, and separators", () => {
    const onSelect = vi.fn();
    const renderer = create(
      <Command className="command-extra" label="Global command menu">
        <CommandInput className="input-extra" placeholder="Search actions" disabled />
        <CommandList className="list-extra">
          <CommandEmpty className="empty-extra">No matching commands</CommandEmpty>
          <CommandGroup className="group-extra" heading="Navigation">
            <CommandItem className="item-extra" onClick={onSelect} data-checked="true">
              Open Office
              <CommandShortcut className="shortcut-extra">Ctrl+O</CommandShortcut>
            </CommandItem>
            <CommandSeparator className="separator-extra" />
          </CommandGroup>
        </CommandList>
      </Command>,
    );

    expect(renderer.root.findByProps({ "data-slot": "command" }).props.className).toContain("command-extra");

    const input = renderer.root.findByProps({ "data-slot": "command-input" });
    expect(input.props.placeholder).toBe("Search actions");
    expect(input.props.disabled).toBe(true);
    expect(input.props.className).toContain("input-extra");

    expect(renderer.root.findByProps({ "data-slot": "command-list" }).props.className).toContain("list-extra");
    expect(renderer.root.findByProps({ "data-slot": "command-empty" }).props.className).toContain("empty-extra");
    expect(renderer.root.findByProps({ "data-slot": "command-group" }).props.className).toContain("group-extra");
    expect(renderer.root.findByProps({ "data-slot": "command-separator" }).props.className).toContain(
      "separator-extra",
    );
    expect(renderer.root.findByProps({ "data-slot": "command-shortcut" }).props.className).toContain("shortcut-extra");

    const item = renderer.root.findByProps({ "data-slot": "command-item" });
    expect(item.props.className).toContain("item-extra");
    expect(textOf(renderer.toJSON())).toContain("Open Office");
    expect(textOf(renderer.toJSON())).toContain("No matching commands");

    act(() => {
      item.props.onClick();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("wraps command content in an accessible dialog with default and custom metadata", () => {
    const renderer = create(
      <>
        <CommandDialog open>
          <Command>Default palette</Command>
        </CommandDialog>
        <CommandDialog
          open={false}
          title="Jump to surface"
          description="Search GoatCitadel surfaces"
          className="dialog-extra"
          showCloseButton
        >
          <Command>Custom palette</Command>
        </CommandDialog>
      </>,
    );

    const dialogs = renderer.root.findAllByProps({ "data-slot": "dialog" });
    const defaultDialog = dialogs[0];
    const customDialog = dialogs[1];
    expect(defaultDialog).toBeDefined();
    expect(customDialog).toBeDefined();
    expect(defaultDialog?.props.open).toBe(true);
    expect(customDialog?.props.open).toBe(false);

    const contents = renderer.root.findAllByProps({ "data-slot": "dialog-content" });
    const defaultContent = contents[0];
    const customContent = contents[1];
    expect(defaultContent).toBeDefined();
    expect(customContent).toBeDefined();
    expect(defaultContent?.props["data-show-close-button"]).toBe(false);
    expect(customContent?.props["data-show-close-button"]).toBe(true);
    expect(customContent?.props.className).toContain("dialog-extra");

    const text = textOf(renderer.toJSON());
    expect(text).toContain("Command Palette");
    expect(text).toContain("Search for a command to run...");
    expect(text).toContain("Jump to surface");
    expect(text).toContain("Search GoatCitadel surfaces");
    expect(text).toContain("Custom palette");

    renderer.unmount();
  });
});
