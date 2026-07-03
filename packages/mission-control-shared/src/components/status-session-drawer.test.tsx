import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SideInspectorDrawer, SIDE_INSPECTOR_DOCKED_MAX_WIDTH } from "./SideInspectorDrawer";
import { StatusStrip } from "./StatusStrip";

function installMatchMedia(matches = false) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      innerWidth: matches ? 640 : 1280,
      innerHeight: 800,
      matchMedia: vi.fn(() => ({
        matches,
        addEventListener: vi.fn((_event: string, listener: (event: { matches: boolean }) => void) => {
          listeners.add(listener);
        }),
        removeEventListener: vi.fn((_event: string, listener: (event: { matches: boolean }) => void) => {
          listeners.delete(listener);
        }),
        addListener: vi.fn((listener: (event: { matches: boolean }) => void) => {
          listeners.add(listener);
        }),
        removeListener: vi.fn((listener: (event: { matches: boolean }) => void) => {
          listeners.delete(listener);
        }),
      })),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  return listeners;
}

// react-test-renderer's default createNodeMock returns null for every host-component
// ref, so `drawerRef.current` (the <aside>) would be null and getBoundingClientRect()
// unreachable. Mirrors the pattern in ResizablePaneLayout.test.tsx.
function createDrawerNodeMock(element: { type: string; props: { className?: string } }) {
  if (element.type === "aside" && String(element.props.className).includes("side-inspector-drawer")) {
    return {
      getBoundingClientRect: () => ({ left: 100, top: 80, width: 320, height: 480 }),
    };
  }
  return null;
}

describe("status/session/drawer components", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    installMatchMedia(false);
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      writable: true,
      value: class {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "HTMLElement");
  });

  it("renders compact and expanded status summaries and dispatches operator actions", () => {
    const callbacks = {
      onToggleVariant: vi.fn(),
      onOpenApprovals: vi.fn(),
      onOpenAgents: vi.fn(),
      onOpenCosts: vi.fn(),
      onOpenTasks: vi.fn(),
    };
    const renderer = create(
      <StatusStrip
        approvalsCount={2}
        approvalsNote="Review now"
        activeAgentsCount={3}
        dailyCostUsd={123.45}
        openTasksCount={1}
        variant="compact"
        context="work"
        {...callbacks}
      />,
    );

    expect(renderer.root.findByProps({ className: "status-strip-summary-value" }).children.join("")).toBe(
      "2 decisions waiting",
    );
    const buttons = renderer.root.findAllByType("button");
    act(() => {
      buttons[0]!.props.onClick();
      buttons[1]!.props.onClick();
      buttons[2]!.props.onClick();
      buttons[3]!.props.onClick();
      buttons[4]!.props.onClick();
    });
    expect(callbacks.onToggleVariant).toHaveBeenCalledWith("expanded");
    expect(callbacks.onOpenApprovals).toHaveBeenCalled();
    expect(callbacks.onOpenAgents).toHaveBeenCalled();
    expect(callbacks.onOpenTasks).toHaveBeenCalled();
    expect(callbacks.onOpenCosts).toHaveBeenCalled();

    renderer.update(
      <StatusStrip
        approvalsCount={0}
        activeAgentsCount={0}
        dailyCostUsd={12.34}
        openTasksCount={5}
        variant="expanded"
        context="observe"
        placement="attached"
        {...callbacks}
      />,
    );
    expect(renderer.root.findAllByProps({ className: "status-strip" })).toHaveLength(1);
    expect(renderer.root.findAll((node) => node.children.includes("$12.3"))).not.toHaveLength(0);

    renderer.update(
      <StatusStrip
        approvalsCount={0}
        activeAgentsCount={0}
        dailyCostUsd={1.23}
        openTasksCount={0}
        variant="compact"
        context="tune"
        placement="attached"
        {...callbacks}
      />,
    );
    expect(renderer.toJSON()).toBeNull();
  });

  it("responds to compact viewport media changes in the status strip", () => {
    const listeners = installMatchMedia(false);
    const renderer = create(
      <StatusStrip
        approvalsCount={0}
        activeAgentsCount={1}
        dailyCostUsd={1.23}
        openTasksCount={0}
        variant="compact"
        context="work"
        onToggleVariant={() => undefined}
        onOpenApprovals={() => undefined}
        onOpenAgents={() => undefined}
        onOpenCosts={() => undefined}
        onOpenTasks={() => undefined}
      />,
    );

    act(() => {
      for (const listener of listeners) {
        listener({ matches: true });
      }
    });
    expect(String(renderer.root.findByType("section").props.className)).toContain("compact");
  });

  it("renders drawer controls, closed state, and drag guard behavior", () => {
    const onClose = vi.fn();
    const onTogglePinned = vi.fn();
    const renderer = create(
      <SideInspectorDrawer
        title="Trace"
        kicker="Inspector"
        subtitle={<span>Details</span>}
        actions={<button type="button">Action</button>}
        pinned
        draggable
        className="custom"
        onClose={onClose}
        onTogglePinned={onTogglePinned}
      >
        Body
      </SideInspectorDrawer>,
    );

    expect(String(renderer.root.findByType("aside").props.className)).toContain("open pinned draggable custom");
    const head = renderer.root.findByProps({ className: "side-inspector-drawer-head" });
    const buttons = renderer.root.findAllByType("button");
    act(() => {
      buttons.find((button) => button.children.join("") === "Unpin")!.props.onClick();
      buttons.find((button) => button.children.join("") === "Close")!.props.onClick();
      head.props.onPointerDown({
        button: 1,
        pointerId: 1,
        clientX: 10,
        clientY: 10,
        target: null,
        preventDefault: vi.fn(),
      });
      head.props.onDoubleClick();
    });
    expect(onTogglePinned).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();

    renderer.update(
      <SideInspectorDrawer title="Trace" open={false}>
        Body
      </SideInspectorDrawer>,
    );
    expect(String(renderer.root.findByType("aside").props.className)).toContain("closed");
    expect(renderer.root.findByType("aside").props["aria-hidden"]).toBe(true);
  });

  it("enables the drag affordance and tracks pointer drags above the docked breakpoint", () => {
    installMatchMedia(false);
    const renderer = create(
      <SideInspectorDrawer title="Trace" draggable>
        Body
      </SideInspectorDrawer>,
      { createNodeMock: createDrawerNodeMock },
    );

    expect(String(renderer.root.findByType("aside").props.className)).toContain("draggable");
    const head = renderer.root.findByProps({ className: "side-inspector-drawer-head" });
    act(() => {
      head.props.onPointerDown({
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 10,
        target: null,
        preventDefault: vi.fn(),
      });
    });

    const pointerMoveListeners = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls
      .filter(([eventName]: [string]) => eventName === "pointermove")
      .map(([, listener]: [string, (event: unknown) => void]) => listener);
    expect(pointerMoveListeners.length).toBeGreaterThan(0);
    act(() => {
      for (const listener of pointerMoveListeners) {
        listener({ pointerId: 1, clientX: 40, clientY: 25 });
      }
    });

    const styleAfterDrag = renderer.root.findByType("aside").props.style as Record<string, string> | undefined;
    expect(styleAfterDrag).toBeDefined();
    expect(styleAfterDrag!["--side-inspector-drag-x"]).toBeDefined();
    expect(styleAfterDrag!["--side-inspector-drag-x"]).not.toBe("0px");
  });

  it("disables the drag affordance entirely at or below the docked breakpoint", () => {
    installMatchMedia(true);
    const renderer = create(
      <SideInspectorDrawer title="Trace" draggable>
        Body
      </SideInspectorDrawer>,
    );

    expect(String(renderer.root.findByType("aside").props.className)).not.toContain("draggable");
    expect(renderer.root.findByType("aside").props.style).toBeUndefined();

    const head = renderer.root.findByProps({ className: "side-inspector-drawer-head" });
    act(() => {
      head.props.onPointerDown({
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 10,
        target: null,
        preventDefault: vi.fn(),
      });
    });

    const pointerMoveListeners = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls
      .filter(([eventName]: [string]) => eventName === "pointermove")
      .map(([, listener]: [string, (event: unknown) => void]) => listener);
    act(() => {
      for (const listener of pointerMoveListeners) {
        listener({ pointerId: 1, clientX: 200, clientY: 200 });
      }
    });

    expect(renderer.root.findByType("aside").props.style).toBeUndefined();
    expect(String(renderer.root.findByType("aside").props.className)).not.toContain("draggable");
  });

  it("resets an in-progress drag offset when the viewport crosses into the docked range", () => {
    const listeners = installMatchMedia(false);
    const renderer = create(
      <SideInspectorDrawer title="Trace" draggable>
        Body
      </SideInspectorDrawer>,
      { createNodeMock: createDrawerNodeMock },
    );

    const head = renderer.root.findByProps({ className: "side-inspector-drawer-head" });
    act(() => {
      head.props.onPointerDown({
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 10,
        target: null,
        preventDefault: vi.fn(),
      });
    });
    const pointerMoveListeners = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls
      .filter(([eventName]: [string]) => eventName === "pointermove")
      .map(([, listener]: [string, (event: unknown) => void]) => listener);
    act(() => {
      for (const listener of pointerMoveListeners) {
        listener({ pointerId: 1, clientX: 60, clientY: 45 });
      }
    });
    const styleWhileDragging = renderer.root.findByType("aside").props.style as Record<string, string> | undefined;
    expect(styleWhileDragging?.["--side-inspector-drag-x"]).not.toBe("0px");

    act(() => {
      for (const listener of listeners) {
        listener({ matches: true });
      }
    });

    expect(String(renderer.root.findByType("aside").props.className)).not.toContain("draggable");
    expect(renderer.root.findByType("aside").props.style).toBeUndefined();

    act(() => {
      for (const listener of listeners) {
        listener({ matches: false });
      }
    });

    const styleAfterReturningWide = renderer.root.findByType("aside").props.style as Record<string, string> | undefined;
    expect(styleAfterReturningWide).toBeDefined();
    expect(styleAfterReturningWide!["--side-inspector-drag-x"]).toBe("0px");
    expect(styleAfterReturningWide!["--side-inspector-drag-y"]).toBe("0px");
  });

  it("exports the docked breakpoint constant used by the media query", () => {
    expect(SIDE_INSPECTOR_DOCKED_MAX_WIDTH).toBe(1180);
  });
});
