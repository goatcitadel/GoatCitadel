import React from "react";
import { create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const componentMocks = vi.hoisted(() => ({
  useMediaQuery: vi.fn(),
  ResizablePaneLayout: vi.fn(
    ({
      panes,
      storageKey,
      className,
    }: {
      panes: Array<{ id: string; children: React.ReactNode }>;
      storageKey: string;
      className?: string;
    }) => (
      <div data-testid="resizable" data-storage-key={storageKey} className={className}>
        {panes.map((pane) => (
          <section key={pane.id} data-pane={pane.id}>
            {pane.children}
          </section>
        ))}
      </div>
    ),
  ),
}));

vi.mock("../hooks/useMediaQuery", () => ({
  useMediaQuery: componentMocks.useMediaQuery,
}));

vi.mock("./ResizablePaneLayout", () => ({
  ResizablePaneLayout: componentMocks.ResizablePaneLayout,
}));

import { OperatorSplitLayout } from "./OperatorSplitLayout";

function textOf(node: unknown): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return ((node as { children?: unknown[] }).children ?? []).map(textOf).join(" ");
  }
  return "";
}

describe("OperatorSplitLayout", () => {
  beforeEach(() => {
    componentMocks.useMediaQuery.mockReset();
    componentMocks.ResizablePaneLayout.mockClear();
  });

  it("uses the resizable layout on wide screens when inspector content exists", () => {
    componentMocks.useMediaQuery.mockReturnValue(false);
    const renderer = create(
      <OperatorSplitLayout
        topbar={<span>Topbar</span>}
        primary={<span>Primary</span>}
        inspector={<span>Inspector</span>}
        className="custom-layout"
        inspectorMode="collapsible"
      />,
    );

    expect(componentMocks.useMediaQuery).toHaveBeenCalledWith("(max-width: 1279px)");
    expect(componentMocks.ResizablePaneLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: "operator-split.collapsible",
        className: "operator-split-grid operator-split-grid-resizable",
      }),
      undefined,
    );
    expect(textOf(renderer.toJSON())).toContain("Topbar");
    expect(textOf(renderer.toJSON())).toContain("Primary");
    expect(textOf(renderer.toJSON())).toContain("Inspector");
    expect(JSON.stringify(renderer.toJSON())).toContain("custom-layout");
  });

  it("stacks panes on narrow screens and falls back to the empty inspector", () => {
    componentMocks.useMediaQuery.mockReturnValue(true);
    const renderer = create(
      <OperatorSplitLayout
        primary={<span>Primary</span>}
        emptyInspector={<span>Choose a row</span>}
        inspectorMode="empty-selection"
      />,
    );

    expect(componentMocks.ResizablePaneLayout).not.toHaveBeenCalled();
    expect(textOf(renderer.toJSON())).toContain("Choose a row");
    expect(JSON.stringify(renderer.toJSON())).toContain("operator-split-inspector-empty-selection");
  });

  it("renders the non-resizable shell when inspector content is absent", () => {
    componentMocks.useMediaQuery.mockReturnValue(false);
    const renderer = create(<OperatorSplitLayout primary={<span>Primary only</span>} />);

    expect(componentMocks.ResizablePaneLayout).not.toHaveBeenCalled();
    expect(textOf(renderer.toJSON())).toContain("Primary only");
    expect(textOf(renderer.toJSON())).not.toContain("Choose a row");
  });
});
