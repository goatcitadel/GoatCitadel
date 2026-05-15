import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mediaState = vi.hoisted(() => ({
  compact: false,
  stacked: false,
}));

vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: (query: string) => {
    if (query.includes("840px")) {
      return mediaState.compact;
    }
    if (query.includes("1200px")) {
      return mediaState.stacked;
    }
    return false;
  },
}));

vi.mock("../../components/ResizablePaneLayout", () => ({
  ResizablePaneLayout: ({
    className,
    orientation,
    panes,
    storageKey,
  }: {
    className?: string;
    orientation?: string;
    panes: Array<{ id: string; children?: React.ReactNode }>;
    storageKey?: string;
  }) => (
    <div className={className} data-orientation={orientation ?? "horizontal"} data-storage-key={storageKey}>
      {panes.map((pane) => (
        <section key={pane.id} data-pane-id={pane.id}>
          {pane.children}
        </section>
      ))}
    </div>
  ),
}));

vi.mock("../../components/ui", () => ({
  Drawer: ({
    children,
    onOpenChange,
    open,
  }: {
    children?: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
  }) => (
    <div data-open={open ? "true" : "false"} data-slot="drawer">
      <button type="button" onClick={() => onOpenChange?.(!open)}>
        Toggle drawer
      </button>
      {open ? children : null}
    </div>
  ),
  DrawerContent: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <div className={className} data-slot="drawer-content">
      {children}
    </div>
  ),
  DrawerDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
  DrawerHeader: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <header className={className}>{children}</header>
  ),
  DrawerTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
  Sheet: ({
    children,
    onOpenChange,
    open,
  }: {
    children?: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
  }) => (
    <div data-open={open ? "true" : "false"} data-slot="sheet">
      <button type="button" onClick={() => onOpenChange?.(!open)}>
        Toggle sheet
      </button>
      {open ? children : null}
    </div>
  ),
  SheetContent: ({ children, className, side }: { children?: React.ReactNode; className?: string; side?: string }) => (
    <aside className={className} data-side={side} data-slot="sheet-content">
      {children}
    </aside>
  ),
  SheetDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
  SheetHeader: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <header className={className}>{children}</header>
  ),
  SheetTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
}));

import { ChatSurfaceLayout } from "./ChatSurfaceLayout";

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
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function instanceText(value: unknown): string {
  if (value == null || typeof value === "boolean") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((child) => instanceText(child)).join(" ");
  }
  if (typeof value === "object" && "children" in value) {
    return instanceText((value as { children?: unknown }).children);
  }
  return "";
}

function button(renderer: ReactTestRenderer, label: string) {
  const match = renderer.root.findAllByType("button").find((node) => instanceText(node).includes(label));
  if (!match) {
    throw new Error(`Button not found: ${label}`);
  }
  return match;
}

describe("ChatSurfaceLayout loop 36 responsive behavior", () => {
  beforeEach(() => {
    mediaState.compact = false;
    mediaState.stacked = false;
  });

  it("uses the compact idle history sheet and toggles the session rail from the launcher", () => {
    mediaState.compact = true;
    const onSessionRailOpenChange = vi.fn();

    const renderer = create(
      <ChatSurfaceLayout
        mode="cowork"
        dockOpen={false}
        hasActiveSession={false}
        sessionRailOpen={false}
        onSessionRailOpenChange={onSessionRailOpenChange}
        sessionRail={<div>Session rail</div>}
        workflowColumn={<div>Workflow column</div>}
        primaryColumn={<div>Primary column</div>}
        contextDock={<div>Context dock</div>}
      />,
    );

    expect(renderer.root.findByProps({ "data-session-state": "idle" })).toBeTruthy();
    expect(rendererText(renderer)).toContain("History");
    expect(rendererText(renderer)).toContain("Workflow column");
    expect(rendererText(renderer)).not.toContain("Primary column");
    expect(rendererText(renderer)).not.toContain("Session rail");

    act(() => {
      button(renderer, "History").props.onClick();
    });

    expect(onSessionRailOpenChange).toHaveBeenCalledWith(true);
    renderer.unmount();
  });

  it("keeps active compact surfaces in drawers and forwards dock open changes", () => {
    mediaState.compact = true;
    const onDockOpenChange = vi.fn();
    const onSessionRailOpenChange = vi.fn();

    const renderer = create(
      <ChatSurfaceLayout
        mode="code"
        dockOpen
        sessionRailOpen
        onDockOpenChange={onDockOpenChange}
        onSessionRailOpenChange={onSessionRailOpenChange}
        sessionRail={<div>Session rail</div>}
        workflowColumn={<div>Workbench column</div>}
        primaryColumn={<div>Thread column</div>}
        contextDock={<div>Context dock</div>}
      />,
    );

    expect(renderer.root.findByProps({ "data-session-state": "active" })).toBeTruthy();
    expect(renderer.root.findByProps({ "data-slot": "drawer-content" })).toBeTruthy();
    expect(rendererText(renderer)).toContain("Hide history");
    expect(rendererText(renderer)).toContain("Session rail");
    expect(rendererText(renderer)).toContain("Context dock");

    act(() => {
      button(renderer, "Hide history").props.onClick();
    });
    act(() => {
      button(renderer, "Toggle drawer").props.onClick();
    });

    expect(onSessionRailOpenChange).toHaveBeenCalledWith(false);
    expect(onDockOpenChange).toHaveBeenCalledWith(false);
    renderer.unmount();
  });

  it("renders chat context as an inline resizable dock on wide desktop", () => {
    const renderer = create(
      <ChatSurfaceLayout
        mode="chat"
        dockOpen
        sessionRail={<div>Session rail</div>}
        primaryColumn={<div>Conversation column</div>}
        contextDock={<div>Context dock</div>}
      />,
    );

    const shell = renderer.root.findByProps({ "data-session-state": "active" });
    expect(shell.props["data-dock-behavior"]).toBe("collapsible");
    expect(renderer.root.findByProps({ "data-storage-key": "chat-surface.chat.dock" })).toBeTruthy();
    expect(renderer.root.findByProps({ "data-pane-id": "artifact" })).toBeTruthy();
    expect(renderer.root.findByProps({ "data-pane-id": "dock" })).toBeTruthy();
    expect(rendererText(renderer)).toContain("Conversation column");
    expect(rendererText(renderer)).toContain("Context dock");
    renderer.unmount();
  });

  it("falls back to the non-resizable stacked desktop grid at the medium breakpoint", () => {
    mediaState.stacked = true;

    const renderer = create(
      <ChatSurfaceLayout
        mode="code"
        dockOpen={false}
        sessionRail={<div>Session rail</div>}
        workflowColumn={<div>Workbench column</div>}
        primaryColumn={<div>Support thread</div>}
        contextDock={<div>Context dock</div>}
      />,
    );

    expect(renderer.root.findAllByProps({ "data-storage-key": "chat-surface.code.main" })).toHaveLength(0);
    expect(renderer.root.findByProps({ "data-surface-slot": "artifact" })).toBeTruthy();
    expect(renderer.root.findByProps({ "data-surface-slot": "support-thread" })).toBeTruthy();
    expect(rendererText(renderer)).toContain("Workbench column");
    expect(rendererText(renderer)).toContain("Support thread");
    expect(rendererText(renderer)).not.toContain("Context dock");
    renderer.unmount();
  });
});
