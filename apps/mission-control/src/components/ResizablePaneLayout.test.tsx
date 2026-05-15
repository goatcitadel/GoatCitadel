// @vitest-environment happy-dom

import React from "react";
import { act, create, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { ResizablePaneLayout } from "./ResizablePaneLayout";

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

describe("ResizablePaneLayout", () => {
  it("renders nothing for an empty pane list", () => {
    const renderer = create(<ResizablePaneLayout panes={[]} storageKey="empty" />);
    expect(renderer.toJSON()).toBeNull();
  });

  it("renders a single pane without splitter markup", () => {
    const renderer = create(
      <ResizablePaneLayout
        className="single-test"
        panes={[{ id: "main", children: <span>Main pane</span>, contentClassName: "main-content" }]}
      />,
    );

    const root = renderer.root.findByProps({ className: "gc-resizable-layout gc-resizable-layout-single single-test" });
    expect(root).toBeTruthy();
    expect(collectText(renderer.toJSON())).toContain("Main pane");
    expect(renderer.root.findAllByProps({ className: "gc-resizable-splitter" })).toHaveLength(0);
  });

  it("uses deterministic fallback markup in tests and responds to storage key changes", async () => {
    window.localStorage.setItem(
      "goatcitadel.layout.layout-a",
      JSON.stringify({ version: 3, panes: { left: 0.25, right: 0.75 } }),
    );

    const renderer = create(
      <ResizablePaneLayout
        orientation="horizontal"
        storageKey="layout-a"
        panes={[
          { id: "left", children: <span>Left pane</span> },
          { id: "right", children: <span>Right pane</span> },
        ]}
      />,
    );

    const fallback = renderer.root.findByProps({
      className: "gc-resizable-layout gc-resizable-layout-fallback",
    });
    expect(fallback.props["data-orientation"]).toBe("horizontal");
    expect(collectText(renderer.toJSON())).toContain("Left pane");
    expect(collectText(renderer.toJSON())).toContain("Right pane");

    await act(async () => {
      renderer.update(
        <ResizablePaneLayout
          orientation="vertical"
          storageKey="layout-b"
          panes={[
            { id: "left", children: <span>Left pane</span> },
            { id: "right", children: <span>Right pane</span> },
          ]}
        />,
      );
    });

    expect(
      renderer.root.findByProps({ className: "gc-resizable-layout gc-resizable-layout-fallback" }).props[
        "data-orientation"
      ],
    ).toBe("vertical");
  });
});
