import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, type CommandPaletteItem } from "./CommandPalette";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON());
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

function makeItems(count = 14): CommandPaletteItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index + 1}`,
    label: `Action ${index + 1}`,
    keywords: index === 12 ? ["deploy", "ship"] : [`keyword-${index + 1}`],
    run: vi.fn(),
  }));
}

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    class TestElement {
      focus = vi.fn();
    }
    vi.stubGlobal("HTMLElement", TestElement);
    vi.stubGlobal("document", {
      activeElement: null,
    });
  });

  it("renders nothing when closed", () => {
    const renderer = create(<CommandPalette open={false} onClose={() => undefined} items={makeItems()} />);

    expect(renderer.toJSON()).toBeNull();
    renderer.unmount();
  });

  it("filters actions, activates keyboard selection, and closes", async () => {
    const items = makeItems();
    const onClose = vi.fn();
    const renderer = create(<CommandPalette open onClose={onClose} items={items} />);

    await act(async () => {
      renderer.root.findByType("input").props.onChange({ target: { value: "deploy" } });
    });

    expect(rendererText(renderer)).toContain("Action 13");
    expect(rendererText(renderer)).not.toContain("Action 2");

    await act(async () => {
      renderer.root.findByType("input").props.onKeyDown({
        key: "Enter",
        preventDefault: vi.fn(),
      });
    });

    expect(items[12]!.run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("supports pointer activation, escape close, and empty-result enter close", async () => {
    const items = makeItems();
    const onClose = vi.fn();
    const renderer = create(<CommandPalette open onClose={onClose} items={items} />);

    const firstAction = renderer.root
      .findAllByType("button")
      .find((button) => reactNodeText(button.props.children).includes("Action 1"));
    expect(firstAction).toBeTruthy();

    await act(async () => {
      firstAction!.props.onMouseEnter();
      firstAction!.props.onClick();
    });

    expect(items[0]!.run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(<CommandPalette open onClose={onClose} items={items} />);
    });

    await act(async () => {
      renderer.root.findByType("input").props.onKeyDown({
        key: "Escape",
        preventDefault: vi.fn(),
      });
    });
    expect(onClose).toHaveBeenCalledTimes(2);

    await act(async () => {
      renderer.root.findByType("input").props.onChange({ target: { value: "missing-action" } });
    });
    expect(rendererText(renderer)).toContain("No matching actions.");

    await act(async () => {
      renderer.root.findByType("input").props.onKeyDown({
        key: "Enter",
        preventDefault: vi.fn(),
      });
    });
    expect(onClose).toHaveBeenCalledTimes(3);
    renderer.unmount();
  });
});
