import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandPalette, readCommandPaletteScrollState, type CommandPaletteItem } from "./CommandPalette";

class FakeElement {
  readonly focus = vi.fn();

  hasAttribute() {
    return false;
  }
}

class FakeDialogElement extends FakeElement {
  constructor(private readonly focusables: FakeElement[]) {
    super();
  }

  querySelectorAll() {
    return this.focusables;
  }

  contains(value: unknown) {
    return this.focusables.includes(value as FakeElement);
  }
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

function installFocusableCommandPalette() {
  const previous = new FakeElement();
  const inputNode = new FakeElement();
  const actionNode = new FakeElement();
  const dialogNode = new FakeDialogElement([inputNode, actionNode]);
  installDocument(previous);
  return {
    actionNode,
    dialogNode,
    inputNode,
    previous,
    createNodeMock: (element: { type: string; props: { className?: string } }) => {
      if (element.type === "input") {
        return inputNode;
      }
      if (element.type === "button") {
        return actionNode;
      }
      if (element.type === "div" && element.props.className === "modal-card command-palette") {
        return dialogNode;
      }
      return new FakeElement();
    },
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

  it("measures vertical overflow and hides the prompt at the end", async () => {
    const listNode = { clientHeight: 100, scrollHeight: 240, scrollTop: 0 };
    expect(readCommandPaletteScrollState(listNode)).toEqual({ overflowing: true, atEnd: false });

    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <CommandPalette
          open
          onClose={() => undefined}
          items={Array.from({ length: 8 }, (_, index) => ({
            id: `command-${index}`,
            label: `Command ${index}`,
            run: vi.fn(),
          }))}
        />,
        {
          createNodeMock: (element) =>
            element.type === "ul" && element.props.className === "command-palette-list" ? listNode : new FakeElement(),
        },
      );
    });
    expect(renderer!.root.findAllByProps({ className: "command-palette-scroll-hint" })).toHaveLength(1);
    expect(renderer!.root.findByType("ul").props["data-overflowing"]).toBe("true");

    listNode.scrollTop = 140;
    await act(async () => {
      renderer!.root.findByType("ul").props.onScroll();
    });
    expect(renderer!.root.findAllByProps({ className: "command-palette-scroll-hint" })).toHaveLength(0);
    expect(renderer!.root.findByType("ul").props["data-at-end"]).toBe("true");
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

  it("renders grouped descriptions, current state, and keyboard hints", () => {
    const markup = renderToStaticMarkup(
      <CommandPalette
        open
        onClose={() => undefined}
        items={[
          {
            id: "memory",
            label: "Memory",
            group: "Library",
            description: "Review memory lifecycle and provenance.",
            keyHint: "G L",
            active: true,
            run: vi.fn(),
          },
        ]}
      />,
    );
    expect(markup).toContain("command-palette-group");
    expect(markup).toContain("Library");
    expect(markup).toContain("Review memory lifecycle and provenance.");
    expect(markup).toContain("Current");
    expect(markup).toContain("G L");
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

  it("covers invalid activation, dialog escape, arrow-up movement, and forward tab trapping", async () => {
    const nodes = installFocusableCommandPalette();
    const runFirst = vi.fn();
    const runSecond = vi.fn();
    const onClose = vi.fn();
    const renderer = create(
      <CommandPalette
        open
        onClose={onClose}
        items={[
          { id: "first", label: "First Action", run: runFirst },
          { id: "second", label: "Second Action", run: runSecond },
        ]}
      />,
      { createNodeMock: nodes.createNodeMock },
    );
    await act(async () => {
      await Promise.resolve();
    });
    const input = renderer.root.findByType("input");
    const dialog = renderer.root.findByProps({ className: "modal-card command-palette" });

    act(() => {
      input.props.onKeyDown(keyboardEvent("ArrowDown"));
      input.props.onKeyDown(keyboardEvent("ArrowUp"));
    });
    const enterFirst = keyboardEvent("Enter");
    act(() => {
      input.props.onKeyDown(enterFirst);
    });
    expect(runFirst).toHaveBeenCalledTimes(1);

    Object.defineProperty(globalThis.document, "activeElement", {
      configurable: true,
      value: nodes.actionNode,
    });
    const tab = keyboardEvent("Tab");
    act(() => {
      dialog.props.onKeyDown(tab);
    });
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(nodes.inputNode.focus).toHaveBeenCalled();

    const escape = keyboardEvent("Escape");
    act(() => {
      dialog.props.onKeyDown(escape);
    });
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);

    act(() => {
      renderer.update(<CommandPalette open onClose={onClose} items={[]} />);
    });
    const enterEmpty = keyboardEvent("Enter");
    act(() => {
      renderer.root.findByType("input").props.onKeyDown(enterEmpty);
    });
    expect(enterEmpty.preventDefault).toHaveBeenCalled();
    expect(runSecond).not.toHaveBeenCalled();
  });

  it("focuses the search field, traps shift-tab, and restores prior focus on close", async () => {
    const nodes = installFocusableCommandPalette();
    const onClose = vi.fn();
    const renderer = create(
      <CommandPalette open onClose={onClose} items={[{ id: "chat", label: "Open Chat", run: vi.fn() }]} />,
      { createNodeMock: nodes.createNodeMock },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(nodes.inputNode.focus).toHaveBeenCalledTimes(1);

    Object.defineProperty(globalThis.document, "activeElement", {
      configurable: true,
      value: nodes.inputNode,
    });
    const dialog = renderer.root.findByProps({ className: "modal-card command-palette" });
    const shiftTab = keyboardEvent("Tab", true);
    act(() => {
      dialog.props.onKeyDown(shiftTab);
    });
    expect(shiftTab.preventDefault).toHaveBeenCalled();
    expect(nodes.actionNode.focus).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(
        <CommandPalette open={false} onClose={onClose} items={[{ id: "chat", label: "Open Chat", run: vi.fn() }]} />,
      );
    });
    expect(nodes.previous.focus).toHaveBeenCalledTimes(1);
  });
});
