import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const reflexMocks = vi.hoisted(() => ({
  stopResizeHandlers: [] as Array<() => void>,
}));

vi.mock("react-reflex", () => ({
  ReflexContainer: ({
    children,
    className,
    orientation,
  }: {
    children: React.ReactNode;
    className?: string;
    orientation?: string;
  }) => (
    <div className={`reflex-container ${className ?? ""}`} data-orientation={orientation}>
      {children}
    </div>
  ),
  ReflexElement: ({
    children,
    className,
    flex,
    maxSize,
    minSize,
    onStopResize,
  }: {
    children: React.ReactNode;
    className?: string;
    flex?: number;
    maxSize?: number;
    minSize?: number;
    onStopResize?: () => void;
  }) => {
    if (onStopResize) {
      reflexMocks.stopResizeHandlers.push(onStopResize);
    }
    return (
      <div
        className={className}
        data-flex={flex}
        data-max-size={maxSize}
        data-min-size={minSize}
        flex={flex}
        onStopResize={onStopResize}
      >
        {children}
      </div>
    );
  },
  ReflexSplitter: ({ className, onStopResize }: { className?: string; onStopResize?: () => void }) => {
    if (onStopResize) {
      reflexMocks.stopResizeHandlers.push(onStopResize);
    }
    return <div className={className} data-splitter />;
  },
}));

class FakeHTMLElement {
  classList: { contains: (className: string) => boolean };
  private readonly size: number;

  constructor(classNames: string[], size: number) {
    this.size = size;
    this.classList = {
      contains: (className: string) => classNames.includes(className),
    };
  }

  getBoundingClientRect() {
    return {
      width: this.size,
      height: this.size,
    };
  }
}

function installWindow(storage = new Map<string, string>()) {
  vi.stubGlobal("HTMLElement", FakeHTMLElement);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    },
  });
  return storage;
}

async function loadLayout(mode: string, forceReflexLayout = mode !== "test") {
  vi.resetModules();
  vi.stubEnv("MODE", mode);
  (globalThis as typeof globalThis & { __GOATCITADEL_TEST_REFLEX_LAYOUT?: boolean }).__GOATCITADEL_TEST_REFLEX_LAYOUT =
    forceReflexLayout;
  return import("./ResizablePaneLayout");
}

describe("ResizablePaneLayout", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "__GOATCITADEL_TEST_REFLEX_LAYOUT");
    reflexMocks.stopResizeHandlers = [];
  });

  it("renders empty, single-pane, and test fallback layouts", async () => {
    installWindow();
    const { ResizablePaneLayout } = await loadLayout("test");

    expect(create(<ResizablePaneLayout panes={[]} />).toJSON()).toBeNull();

    const single = create(
      <ResizablePaneLayout
        panes={[{ id: "one", children: "One", contentClassName: "content-one" }]}
        className="custom"
      />,
    );
    expect(String(single.root.findByType("div").props.className)).toContain("gc-resizable-layout-single custom");

    const fallback = create(
      <ResizablePaneLayout
        panes={[
          { id: "left", children: "Left", contentClassName: "left-content" },
          { id: "right", children: "Right", contentClassName: "right-content" },
        ]}
        orientation="horizontal"
      />,
    );
    expect(String(fallback.root.findByType("div").props.className)).toContain("gc-resizable-layout-fallback");
    expect(fallback.root.findByType("div").props["data-orientation"]).toBe("horizontal");
  });

  it("clears malformed storage and uses default pane weights in the Reflex path", async () => {
    const storage = installWindow(new Map([["goatcitadel.layout.workbench", '{"version":1,"panes":{"left":1}}']]));
    const { ResizablePaneLayout } = await loadLayout("development");

    const renderer = create(
      <ResizablePaneLayout
        panes={[
          { id: "left", children: "Left", defaultSize: 2, minSize: 100, className: "left-pane" },
          { id: "right", children: "Right", defaultSize: 1, maxSize: 900, className: "right-pane" },
        ]}
        storageKey="workbench"
        splitterClassName="split"
      />,
    );

    expect(storage.has("goatcitadel.layout.workbench")).toBe(false);
    const panes = renderer.root.findAllByProps({ className: "gc-resizable-pane left-pane" });
    expect(panes[0]!.props.flex).toBeCloseTo(2 / 3);
    expect(renderer.root.findAllByProps({ className: "gc-resizable-splitter split" }).length).toBeGreaterThanOrEqual(1);
  });

  it("loads stored pane flexes and persists measured layout after resizing", async () => {
    const storage = installWindow(
      new Map([
        [
          "goatcitadel.layout.workbench",
          JSON.stringify({
            version: 3,
            panes: {
              left: 0.25,
              right: 0.75,
              ignored: -1,
            },
          }),
        ],
      ]),
    );
    const measuredPanes = [
      new FakeHTMLElement(["gc-resizable-pane"], 30),
      new FakeHTMLElement(["gc-resizable-pane"], 70),
    ];
    const rootMock = {
      querySelector: vi.fn(() => ({ children: measuredPanes })),
    };
    const { ResizablePaneLayout } = await loadLayout("development");

    const renderer = create(
      <ResizablePaneLayout
        panes={[
          { id: "left", children: "Left", defaultSize: 1 },
          { id: "right", children: "Right", defaultSize: 1 },
        ]}
        storageKey="workbench"
      />,
      {
        createNodeMock: (element) => {
          if (element.type === "div" && String(element.props.className).includes("gc-resizable-layout")) {
            return rootMock;
          }
          return null;
        },
      },
    );

    const pane = renderer.root.findAllByProps({ className: "gc-resizable-pane" })[0]!;
    expect(pane.props.flex).toBe(0.25);
    act(() => {
      pane.props.onStopResize();
    });
    expect(JSON.parse(storage.get("goatcitadel.layout.workbench") ?? "{}")).toEqual({
      version: 3,
      panes: {
        left: 0.3,
        right: 0.7,
      },
    });
  });

  it("ignores malformed JSON storage without clearing and falls back to equal defaults", async () => {
    const storage = installWindow(new Map([["goatcitadel.layout.workbench", "{not-json"]]));
    const { ResizablePaneLayout } = await loadLayout("development");

    const renderer = create(
      <ResizablePaneLayout
        panes={[
          { id: "left", children: "Left" },
          { id: "right", children: "Right" },
        ]}
        storageKey="workbench"
      />,
    );

    expect(storage.get("goatcitadel.layout.workbench")).toBe("{not-json");
    const panes = renderer.root.findAllByProps({ className: "gc-resizable-pane" });
    expect(panes[0]!.props.flex).toBeCloseTo(0.5);
    expect(panes[1]!.props.flex).toBeCloseTo(0.5);
  });

  it("allows the Reflex path in test mode when the explicit override is enabled", async () => {
    installWindow();
    const { ResizablePaneLayout } = await loadLayout("test", true);

    const renderer = create(
      <ResizablePaneLayout
        panes={[
          { id: "left", children: "Left", minSize: 0, defaultSize: 0 },
          { id: "right", children: "Right", minSize: 0, defaultSize: 0 },
        ]}
        storageKey="  "
      />,
    );

    expect(renderer.root.findAllByProps({ className: "gc-resizable-pane" })[0]!.props.flex).toBeUndefined();
    expect(renderer.root.findByProps({ "data-orientation": "vertical" })).toBeTruthy();
  });

  it("skips persistence when panes cannot be measured", async () => {
    installWindow();
    const rootMock = {
      querySelector: vi.fn(() => null),
    };
    const { ResizablePaneLayout } = await loadLayout("development");

    const renderer = create(
      <ResizablePaneLayout
        panes={[
          { id: "left", children: "Left" },
          { id: "right", children: "Right" },
        ]}
        storageKey="workbench"
      />,
      {
        createNodeMock: (element) => {
          if (element.type === "div" && String(element.props.className).includes("gc-resizable-layout")) {
            return rootMock;
          }
          return null;
        },
      },
    );

    act(() => {
      renderer.root.findAllByProps({ className: "gc-resizable-pane" })[0]!.props.onStopResize();
    });

    expect(rootMock.querySelector).toHaveBeenCalledWith(":scope > .reflex-container");
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
  });

  it("uses the inert fallback when browser storage is unavailable", async () => {
    const { ResizablePaneLayout } = await loadLayout("development");

    const renderer = create(
      <ResizablePaneLayout
        panes={[
          { id: "left", children: "Left" },
          { id: "right", children: "Right" },
        ]}
        storageKey="workbench"
      />,
    );

    expect(String(renderer.root.findByType("div").props.className)).toContain("gc-resizable-layout-fallback");
  });

  it("persists only positive measured panes and ignores zero-sized layouts", async () => {
    const storage = installWindow();
    const { ResizablePaneLayout } = await loadLayout("development");
    const sparseRootMock = {
      querySelector: vi.fn(() => ({
        children: [new FakeHTMLElement(["gc-resizable-pane"], 40)],
      })),
    };

    const sparseRenderer = create(
      <ResizablePaneLayout
        panes={[
          { id: "left", children: "Left" },
          { id: "right", children: "Right" },
        ]}
        storageKey="workbench"
      />,
      {
        createNodeMock: (element) => {
          if (element.type === "div" && String(element.props.className).includes("gc-resizable-layout")) {
            return sparseRootMock;
          }
          return null;
        },
      },
    );

    act(() => {
      sparseRenderer.root.findAllByProps({ className: "gc-resizable-pane" })[0]!.props.onStopResize();
    });
    expect(JSON.parse(storage.get("goatcitadel.layout.workbench") ?? "{}")).toEqual({
      version: 3,
      panes: { left: 1 },
    });

    vi.mocked(window.localStorage.setItem).mockClear();
    const zeroRootMock = {
      querySelector: vi.fn(() => ({
        children: [new FakeHTMLElement(["gc-resizable-pane"], 0), new FakeHTMLElement(["gc-resizable-pane"], 0)],
      })),
    };
    const zeroRenderer = create(
      <ResizablePaneLayout
        panes={[
          { id: "left", children: "Left" },
          { id: "right", children: "Right" },
        ]}
        storageKey="zero"
      />,
      {
        createNodeMock: (element) => {
          if (element.type === "div" && String(element.props.className).includes("gc-resizable-layout")) {
            return zeroRootMock;
          }
          return null;
        },
      },
    );

    act(() => {
      zeroRenderer.root.findAllByProps({ className: "gc-resizable-pane" })[0]!.props.onStopResize();
    });
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
  });
});
