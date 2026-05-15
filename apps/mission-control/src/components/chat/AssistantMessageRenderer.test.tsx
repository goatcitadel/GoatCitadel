// @vitest-environment happy-dom

import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageRenderer } from "./AssistantMessageRenderer";

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

function forceFallbackRenderer(): void {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: "jsdom",
  });
}

describe("AssistantMessageRenderer", () => {
  beforeEach(() => {
    forceFallbackRenderer();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders assistant markdown through the fallback path and copies with clipboard feedback", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText,
      },
    });

    let renderer: ReactTestRenderer = create(<div />);
    await act(async () => {
      renderer = create(
        <AssistantMessageRenderer
          role="assistant"
          content={"**Ship** the patch\n\n- focused tests\n- coverage proof"}
          running
          className="coverage-renderer"
        />,
      );
    });

    expect(collectText(renderer.toJSON())).toContain("Ship");
    expect(
      renderer.root.findAll(
        (node) => node.type === "strong" && Array.isArray(node.children) && node.children.includes("Ship"),
      ),
    ).toHaveLength(1);

    const copyButton = renderer.root.findByProps({ "aria-label": "Copy response to clipboard" });
    await act(async () => {
      await copyButton.props.onClick();
    });

    expect(writeText).toHaveBeenCalledWith("**Ship** the patch\n\n- focused tests\n- coverage proof");
    expect(renderer.root.findByProps({ "aria-label": "Response copied to clipboard" })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1800);
    });

    expect(renderer.root.findByProps({ "aria-label": "Copy response to clipboard" })).toBeTruthy();
  });

  it("falls back to a temporary textarea when clipboard APIs are unavailable", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    let renderer: ReactTestRenderer = create(<div />);
    await act(async () => {
      renderer = create(<AssistantMessageRenderer role="assistant" content="fallback copy" />);
    });

    await act(async () => {
      await renderer.root.findByProps({ "aria-label": "Copy response to clipboard" }).props.onClick();
    });

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("does not expose copy controls for user-authored messages", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    await act(async () => {
      renderer = create(<AssistantMessageRenderer role="user" content={"Operator **request**"} />);
    });

    expect(collectText(renderer.toJSON())).toContain("Operator");
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });
});
