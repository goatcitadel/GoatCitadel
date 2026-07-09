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

describe("ThreadedModeControl", () => {
  it("shows the normalized Chat surface label", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<ThreadedModeControl mode="code" onOverride={() => {}} />);
    });

    const control = renderer!.root.findByProps({ "data-mode": "chat" });
    expect(control.props.className).toContain("is-readonly");
    expect(findByText(renderer!.root, /^Surface Chat/i)).toBeDefined();
  });

  it("does not expose override controls when an override handler is provided", async () => {
    const onOverride = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<ThreadedModeControl mode="chat" onOverride={onOverride} />);
    });

    expect(renderer!.root.findAll((node) => node.type === "button")).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props.role === "menuitem")).toHaveLength(0);
    expect(onOverride).not.toHaveBeenCalled();
  });

  it("keeps legacy pinned modes normalized to Chat", async () => {
    const onOverride = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<ThreadedModeControl mode="cowork" onOverride={onOverride} />);
    });

    expect(renderer!.root.findByProps({ "data-mode": "chat" })).toBeDefined();
    expect(findByText(renderer!.root, /Surface Chat/i)).toBeDefined();
    expect(onOverride).not.toHaveBeenCalled();
  });

  it("renders Chat confidence and rationale", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<ThreadedModeControl mode={undefined} preview={PREVIEW} onOverride={() => {}} />);
    });

    expect(findByText(renderer!.root, /Chat · 82% heuristic/i)).toBeDefined();
    expect(findByText(renderer!.root, /draft asks for a code change/i)).toBeDefined();
    expect(renderer!.root.findAll((node) => node.props.role === "menuitem")).toHaveLength(0);
  });

  it("renders a compact non-interactive mirror for the composer", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <ThreadedModeControl mode={undefined} preview={PREVIEW} variant="compact" interactive={false} />,
      );
    });

    expect(findByText(renderer!.root, /Surface Chat/i)).toBeDefined();
    expect(renderer!.root.findAll((node) => node.type === "button")).toHaveLength(0);
  });

  it("renders a readonly status instead of a dead override trigger when no handler is wired", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<ThreadedModeControl mode="cowork" />);
    });

    const control = renderer!.root.findByProps({ "data-mode": "chat" });
    expect(control.props.className).toContain("is-readonly");
    expect(findByText(renderer!.root, /planning, tools, approvals, and code context/i)).toBeDefined();
    expect(renderer!.root.findAll((node) => node.type === "button")).toHaveLength(0);
  });
});
