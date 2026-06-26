// @vitest-environment happy-dom
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { SurfaceClassifyResponse } from "@goatcitadel/contracts";

import { ThreadedModeControl } from "./ThreadedModeControl";

const PREVIEW: SurfaceClassifyResponse = {
  mode: "code",
  confidence: 0.82,
  source: "heuristic",
  rationale: "The draft asks for a code change with validation.",
  alternatives: ["cowork", "chat"],
};

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function findByText(root: ReactTestInstance, textPattern: RegExp): ReactTestInstance | undefined {
  if (textPattern.test(textOf(root))) {
    return root;
  }
  for (const child of root.children) {
    if (typeof child !== "string") {
      const found = findByText(child, textPattern);
      if (found) return found;
    }
  }
  return undefined;
}

function findButton(root: ReactTestInstance, textPattern: RegExp): ReactTestInstance {
  const buttons = root.findAll((node) => node.type === "button");
  const match = buttons.find((button) => textPattern.test(textOf(button)));
  if (!match) throw new Error(`No button matching ${textPattern}`);
  return match;
}

function findMenuItem(root: ReactTestInstance, textPattern: RegExp): ReactTestInstance {
  const items = root.findAll((node) => node.props.role === "menuitem");
  const match = items.find((item) => textPattern.test(textOf(item)));
  if (!match) {
    throw new Error(`No menuitem matching ${textPattern}. Available: ${items.map(textOf).join(", ")}`);
  }
  return match;
}

describe("ThreadedModeControl", () => {
  it("shows the resolved pinned mode label", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<ThreadedModeControl mode="code" onOverride={() => {}} />);
    });

    expect(findButton(renderer!.root, /code/i)).toBeDefined();
  });

  it("calls onOverride when a different mode is picked", async () => {
    const onOverride = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<ThreadedModeControl mode="chat" onOverride={onOverride} />);
    });

    await act(async () => {
      findButton(renderer!.root, /chat/i).props.onClick();
    });

    await act(async () => {
      findMenuItem(renderer!.root, /^code/i).props.onClick();
    });

    expect(onOverride).toHaveBeenCalledWith("code");
  });

  it("does not call onOverride when the current mode is re-picked", async () => {
    const onOverride = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<ThreadedModeControl mode="chat" onOverride={onOverride} />);
    });

    await act(async () => {
      findButton(renderer!.root, /chat/i).props.onClick();
    });

    await act(async () => {
      findMenuItem(renderer!.root, /^chat/i).props.onClick();
    });

    expect(onOverride).not.toHaveBeenCalled();
  });

  it("renders auto-route confidence and rationale", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<ThreadedModeControl mode={undefined} preview={PREVIEW} onOverride={() => {}} />);
    });

    expect(findButton(renderer!.root, /auto -> code/i)).toBeDefined();
    expect(findByText(renderer!.root, /82% heuristic/i)).toBeDefined();

    await act(async () => {
      findButton(renderer!.root, /auto -> code/i).props.onClick();
    });

    expect(findByText(renderer!.root, /draft asks for a code change/i)).toBeDefined();
    expect(findByText(renderer!.root, /also considered cowork, chat/i)).toBeDefined();
  });

  it("renders a compact non-interactive mirror for the composer", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <ThreadedModeControl mode={undefined} preview={PREVIEW} variant="compact" interactive={false} />,
      );
    });

    expect(findByText(renderer!.root, /auto -> code/i)).toBeDefined();
    expect(renderer!.root.findAll((node) => node.type === "button")).toHaveLength(0);
  });
});
