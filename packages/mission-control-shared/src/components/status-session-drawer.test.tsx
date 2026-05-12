import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SideInspectorDrawer } from "./SideInspectorDrawer";
import { StatusStrip } from "./StatusStrip";
import { ChatSessionRail } from "./chat/ChatSessionRail";

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

  it("renders mission and external session rows, tags, search hits, and empty states", () => {
    const onSelectSession = vi.fn();
    const onSelectTag = vi.fn();
    const renderer = create(
      <ChatSessionRail
        missionSessions={[
          {
            sessionId: "mission-1",
            projectName: "Atlas",
            folderName: "Planning",
            tags: ["Urgent", "Research", "Extra", "Hidden"],
            searchHits: [{ turnId: "turn-1", excerpt: "matched text" }],
            pinned: true,
            lastActivityAt: "2026-01-01T11:30:00.000Z",
          },
        ]}
        externalSessions={[
          {
            sessionId: "external-1",
            channel: "Slack",
            account: "ops",
            tags: ["Inbox"],
            searchHits: [{ excerpt: "external hit" }],
            lastActivityAt: "2025-12-31T12:00:00.000Z",
          },
        ]}
        selectedSessionId="mission-1"
        selectedTag="urgent"
        onSelectSession={onSelectSession}
        onSelectTag={onSelectTag}
        renderSessionLabel={(sessionId) => `Session ${sessionId}`}
        mode="cowork"
      />,
    );

    const sessionButtons = renderer.root
      .findAllByType("button")
      .filter((button) => String(button.props.className).includes("chat-v11-session-row-button"));
    const tagButtons = renderer.root
      .findAllByType("button")
      .filter((button) => String(button.props.className).includes("chat-v11-session-tag"));
    const hitButtons = renderer.root
      .findAllByType("button")
      .filter((button) => String(button.props.className).includes("chat-v11-session-search-hit"));

    act(() => {
      sessionButtons[0]!.props.onClick();
      tagButtons[0]!.props.onClick();
      tagButtons[1]!.props.onClick();
      hitButtons[0]!.props.onClick();
      hitButtons[1]!.props.onClick();
    });
    expect(onSelectSession).toHaveBeenCalledWith("mission-1");
    expect(onSelectSession).toHaveBeenCalledWith("mission-1", { turnId: "turn-1" });
    expect(onSelectSession).toHaveBeenCalledWith("external-1", { turnId: null });
    expect(onSelectTag).toHaveBeenCalledWith(null);
    expect(onSelectTag).toHaveBeenCalledWith("Research");

    renderer.update(
      <ChatSessionRail
        missionSessions={[]}
        externalSessions={[]}
        selectedSessionId={null}
        onSelectSession={onSelectSession}
        selectedTag={null}
        onSelectTag={onSelectTag}
        renderSessionLabel={(sessionId) => sessionId}
        mode="code"
      />,
    );
    expect(renderer.root.findAllByProps({ className: "chat-v11-empty-item" })).toHaveLength(2);
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
});
