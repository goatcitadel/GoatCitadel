// @vitest-environment happy-dom

import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-reflex", () => ({
  ReflexContainer: ({
    children,
    className,
    orientation,
  }: {
    children?: React.ReactNode;
    className?: string;
    orientation?: string;
  }) => (
    <div className={className} data-orientation={orientation}>
      {children}
    </div>
  ),
  ReflexElement: ({
    children,
    className,
    flex,
    onStopResize,
  }: {
    children?: React.ReactNode;
    className?: string;
    flex?: number;
    onStopResize?: () => void;
  }) => (
    <div className={className} data-flex={flex}>
      <button type="button" onClick={onStopResize}>
        Persist pane
      </button>
      {children}
    </div>
  ),
  ReflexSplitter: ({ className, onStopResize }: { className?: string; onStopResize?: () => void }) => (
    <button type="button" className={className} onClick={onStopResize}>
      Splitter
    </button>
  ),
}));

import { ResizablePaneLayout } from "./ResizablePaneLayout";

function makePaneElement(size: number): HTMLElement {
  const element = document.createElement("div");
  element.className = "gc-resizable-pane";
  element.getBoundingClientRect = () =>
    ({
      bottom: size,
      height: size,
      left: 0,
      right: size,
      toJSON: () => ({}),
      top: 0,
      width: size,
      x: 0,
      y: 0,
    }) as DOMRect;
  return element;
}

function createMeasuredContainer(...sizes: number[]): HTMLElement {
  const container = document.createElement("div");
  container.className = "reflex-container";
  for (const size of sizes) {
    container.appendChild(makePaneElement(size));
  }
  return container;
}

function hasClassNameProp(element: { props?: unknown }, className: string): boolean {
  const props = element.props as { className?: unknown } | undefined;
  return typeof props?.className === "string" && props.className.includes(className);
}

function button(renderer: ReactTestRenderer, label: string) {
  const found = renderer.root.findAllByType("button").find((node) => node.children.includes(label));
  if (!found) {
    throw new Error(`Button not found: ${label}`);
  }
  return found;
}

describe("ResizablePaneLayout loop43 resize persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubEnv("MODE", "development");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("clears invalid stored layouts and persists measured vertical pane flexes on resize", async () => {
    window.localStorage.setItem("goatcitadel.layout.editor", JSON.stringify({ version: 1, panes: { left: 0.2 } }));
    const measuredContainer = createMeasuredContainer(200, 600);

    const renderer = create(
      <ResizablePaneLayout
        className="shell-layout"
        splitterClassName="shell-splitter"
        storageKey="editor"
        panes={[
          { children: <span>Left</span>, defaultSize: 1, id: "left", minSize: 120 },
          { children: <span>Right</span>, defaultSize: 3, id: "right", minSize: 240 },
        ]}
      />,
      {
        createNodeMock: (element) => {
          if (hasClassNameProp(element, "gc-resizable-layout")) {
            const root = document.createElement("div");
            root.querySelector = () => measuredContainer;
            return root;
          }
          return document.createElement(typeof element.type === "string" ? element.type : "div");
        },
      },
    );

    expect(window.localStorage.getItem("goatcitadel.layout.editor")).toBeNull();
    expect(renderer.root.findAllByProps({ className: "gc-resizable-splitter shell-splitter" }).length).toBeGreaterThan(
      0,
    );

    await act(async () => {
      button(renderer, "Persist pane").props.onClick();
    });

    expect(JSON.parse(window.localStorage.getItem("goatcitadel.layout.editor") ?? "{}")).toEqual({
      panes: { left: 0.25, right: 0.75 },
      version: 3,
    });
  });

  it("persists horizontal measurements and skips storage writes when panes cannot be measured", async () => {
    const measuredContainer = createMeasuredContainer(50, 150);
    const renderer = create(
      <ResizablePaneLayout
        orientation="horizontal"
        storageKey="stack"
        panes={[
          { children: <span>Top</span>, id: "top" },
          { children: <span>Bottom</span>, id: "bottom" },
        ]}
      />,
      {
        createNodeMock: (element) => {
          if (hasClassNameProp(element, "gc-resizable-layout")) {
            const root = document.createElement("div");
            root.querySelector = () => measuredContainer;
            return root;
          }
          return document.createElement(typeof element.type === "string" ? element.type : "div");
        },
      },
    );

    await act(async () => {
      button(renderer, "Splitter").props.onClick();
    });

    expect(JSON.parse(window.localStorage.getItem("goatcitadel.layout.stack") ?? "{}")).toEqual({
      panes: { bottom: 0.75, top: 0.25 },
      version: 3,
    });

    measuredContainer.replaceChildren();
    window.localStorage.removeItem("goatcitadel.layout.stack");

    await act(async () => {
      button(renderer, "Splitter").props.onClick();
    });

    expect(window.localStorage.getItem("goatcitadel.layout.stack")).toBeNull();
  });
});
