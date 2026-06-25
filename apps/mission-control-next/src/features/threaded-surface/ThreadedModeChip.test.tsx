// @vitest-environment happy-dom
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ThreadedModeChip } from "./ThreadedModeChip";

function findByText(root: ReactTestInstance, text: string): ReactTestInstance | undefined {
  if (root.children.some((c) => typeof c === "string" && c.toLowerCase().includes(text.toLowerCase()))) {
    return root;
  }
  for (const child of root.children) {
    if (typeof child !== "string") {
      const found = findByText(child, text);
      if (found) return found;
    }
  }
  return undefined;
}

function findButton(root: ReactTestInstance, textPattern: RegExp): ReactTestInstance {
  const buttons = root.findAll((n) => n.type === "button");
  const match = buttons.find((b) => {
    const text = b.children.map((c) => (typeof c === "string" ? c : "")).join(" ");
    return textPattern.test(text);
  });
  if (!match) throw new Error(`No button matching ${textPattern}`);
  return match;
}

function findMenuItem(root: ReactTestInstance, textPattern: RegExp): ReactTestInstance {
  const items = root.findAll((n) => n.props.role === "menuitem");
  const match = items.find((item) => {
    const text = item.children
      .map((c) => (typeof c === "string" ? c : ""))
      .join(" ")
      .trim();
    return textPattern.test(text);
  });
  if (!match) throw new Error(`No menuitem matching ${textPattern}. Available: ${items.map((i) => i.children.join("")).join(", ")}`);
  return match;
}

describe("ThreadedModeChip", () => {
  it("shows the resolved mode label", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<ThreadedModeChip mode="code" onOverride={() => {}} />);
    });
    const btn = findButton(renderer!.root, /code/i);
    expect(btn).toBeDefined();
  });

  it("calls onOverride when a different mode is picked", async () => {
    const onOverride = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<ThreadedModeChip mode="chat" onOverride={onOverride} />);
    });

    // Open the menu
    await act(async () => {
      findButton(renderer!.root, /chat/i).props.onClick();
    });

    // Pick "code" from menu
    await act(async () => {
      findMenuItem(renderer!.root, /^code$/i).props.onClick();
    });

    expect(onOverride).toHaveBeenCalledWith("code");
  });

  it("does not call onOverride when the current mode is re-picked", async () => {
    const onOverride = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<ThreadedModeChip mode="chat" onOverride={onOverride} />);
    });

    // Open the menu
    await act(async () => {
      findButton(renderer!.root, /chat/i).props.onClick();
    });

    // Pick "chat" from menu (same mode)
    await act(async () => {
      findMenuItem(renderer!.root, /^chat$/i).props.onClick();
    });

    expect(onOverride).not.toHaveBeenCalled();
  });

  it("renders an Auto preview when mode is unresolved", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<ThreadedModeChip mode={undefined} preview="cowork" onOverride={() => {}} />);
    });

    const root = renderer!.root;
    const autoNode = findByText(root, "auto");
    expect(autoNode).toBeDefined();
    const coworkNode = findByText(root, "cowork");
    expect(coworkNode).toBeDefined();
  });
});
