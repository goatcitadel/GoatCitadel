import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandPalette, type CommandPaletteItem } from "./CommandPalette";

class FakeElement {
  readonly focus = vi.fn();
}

function installDocument(activeElement: unknown = null) {
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    writable: true,
    value: FakeElement,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      activeElement,
    },
  });
}

function keyboardEvent(key: string, shiftKey = false) {
  return {
    key,
    shiftKey,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

describe("CommandPalette", () => {
  beforeEach(() => {
    installDocument(new FakeElement());
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "HTMLElement");
  });

  it("renders nothing when closed and resets local state", () => {
    expect(
      renderToStaticMarkup(
        <CommandPalette
          open={false}
          onClose={() => undefined}
          items={[{ id: "chat", label: "Open Chat", run: vi.fn() }]}
        />,
      ),
    ).toBe("");
  });

  it("filters actions and activates the selected item from the keyboard", () => {
    const items: CommandPaletteItem[] = [
      { id: "chat", label: "Open Chat", keywords: ["conversation"], run: vi.fn() },
      { id: "settings", label: "Open Settings", keywords: ["provider"], run: vi.fn() },
      { id: "tools", label: "Manage Tools", keywords: ["mcp"], run: vi.fn() },
    ];
    const onClose = vi.fn();
    const renderer = create(<CommandPalette open onClose={onClose} items={items} />);

    const input = renderer.root.findByType("input");
    act(() => {
      input.props.onChange({ target: { value: "provider" } });
    });
    expect(renderer.root.findAllByType("li")).toHaveLength(1);
    expect(renderer.root.findAll((node) => node.children.includes("Open Settings"))).not.toHaveLength(0);

    const down = keyboardEvent("ArrowDown");
    act(() => {
      input.props.onKeyDown(down);
    });
    expect(down.preventDefault).toHaveBeenCalled();

    const home = keyboardEvent("Home");
    const end = keyboardEvent("End");
    act(() => {
      input.props.onKeyDown(end);
      input.props.onKeyDown(home);
    });
    expect(home.preventDefault).toHaveBeenCalled();
    expect(end.preventDefault).toHaveBeenCalled();

    const enter = keyboardEvent("Enter");
    act(() => {
      input.props.onKeyDown(enter);
    });
    expect(items[1]?.run).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("supports pointer activation, hover selection, backdrop close, and dialog event suppression", () => {
    const item = { id: "tools", label: "Manage Tools", keywords: ["mcp"], run: vi.fn() };
    const onClose = vi.fn();
    const renderer = create(<CommandPalette open onClose={onClose} items={[item]} />);

    const backdrop = renderer.root.findByProps({ className: "modal-backdrop" });
    const dialog = renderer.root.findByProps({ className: "modal-card command-palette" });
    const action = renderer.root.findAllByType("button").find((button) => String(button.props.id).includes("tools"))!;
    const stopPropagation = vi.fn();

    act(() => {
      action.props.onMouseEnter();
      action.props.onFocus();
      dialog.props.onClick({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalled();

    act(() => {
      action.props.onClick();
    });
    expect(item.run).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      backdrop.props.onClick();
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes on escape and handles empty results and tab focus fallback", () => {
    const onClose = vi.fn();
    const renderer = create(
      <CommandPalette open onClose={onClose} items={[{ id: "chat", label: "Open Chat", run: vi.fn() }]} />,
    );
    const input = renderer.root.findByType("input");
    const dialog = renderer.root.findByProps({ className: "modal-card command-palette" });

    act(() => {
      input.props.onChange({ target: { value: "missing" } });
    });
    expect(renderer.root.findByProps({ className: "command-palette-empty" }).children.join("")).toBe(
      "No matching actions.",
    );

    const emptyEnter = keyboardEvent("Enter");
    const emptyDown = keyboardEvent("ArrowDown");
    const emptyUp = keyboardEvent("ArrowUp");
    act(() => {
      input.props.onKeyDown(emptyDown);
      input.props.onKeyDown(emptyUp);
      input.props.onKeyDown(emptyEnter);
    });
    expect(emptyDown.preventDefault).toHaveBeenCalled();
    expect(emptyUp.preventDefault).toHaveBeenCalled();
    expect(emptyEnter.preventDefault).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    const escape = keyboardEvent("Escape");
    const tab = keyboardEvent("Tab");
    const other = keyboardEvent("x");
    act(() => {
      dialog.props.onKeyDown(other);
      dialog.props.onKeyDown(tab);
      input.props.onKeyDown(escape);
    });
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
