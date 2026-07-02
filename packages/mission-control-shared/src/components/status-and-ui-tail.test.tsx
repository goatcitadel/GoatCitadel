import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GlobalFreshnessPill } from "./GlobalFreshnessPill";
import { StatusStrip } from "./StatusStrip";
import { GCSegmentedControl } from "./ui/GCSegmentedControl";

const statusHandlers = vi.hoisted(() => ({
  useEventStreamStatus: vi.fn(() => ({
    state: "open",
    lastEventAt: 0,
    reconnectAttempts: 0,
    gatewayNodeId: "",
  })),
}));

vi.mock("../hooks/useEventStreamStatus", () => ({
  useEventStreamStatus: statusHandlers.useEventStreamStatus,
}));

function text(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : text(child)))
    .join(" ");
}

function normalizedText(node: ReactTestInstance): string {
  return text(node).replace(/\s+/g, " ").trim();
}

function statusProps(overrides: Partial<React.ComponentProps<typeof StatusStrip>> = {}) {
  return {
    approvalsCount: 0,
    activeAgentsCount: 0,
    dailyCostUsd: 4.25,
    openTasksCount: 0,
    variant: "compact" as const,
    context: "work" as const,
    onToggleVariant: vi.fn(),
    onOpenApprovals: vi.fn(),
    onOpenAgents: vi.fn(),
    onOpenCosts: vi.fn(),
    onOpenTasks: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  statusHandlers.useEventStreamStatus.mockReset();
  statusHandlers.useEventStreamStatus.mockReturnValue({
    state: "open",
    lastEventAt: 0,
    reconnectAttempts: 0,
    gatewayNodeId: "",
  });
});

describe("shared status and UI branch tails", () => {
  it("suppresses attached compact status strips and toggles standalone summaries", () => {
    const compactAttached = create(<StatusStrip {...statusProps({ placement: "attached" })} />);
    expect(compactAttached.toJSON()).toBeNull();

    const onToggleVariant = vi.fn();
    const onOpenApprovals = vi.fn();
    const onOpenAgents = vi.fn();
    const onOpenCosts = vi.fn();
    const onOpenTasks = vi.fn();
    const strip = create(
      <StatusStrip
        {...statusProps({
          approvalsCount: 2,
          activeAgentsCount: 3,
          dailyCostUsd: 125.25,
          openTasksCount: 1,
          variant: "compact",
          onToggleVariant,
          onOpenApprovals,
          onOpenAgents,
          onOpenCosts,
          onOpenTasks,
        })}
      />,
    );

    expect(normalizedText(strip.root)).toContain("2 decisions waiting");
    expect(normalizedText(strip.root)).toContain("$125 today");
    const buttons = strip.root.findAllByType("button");
    expect(buttons.slice(1).map((button) => button.props["aria-label"])).toEqual([
      "Approvals: 2 decisions waiting",
      "Agents: 3 agents live",
      "Tasks: 1 open tasks",
      "Spend: $125 today",
    ]);
    act(() => buttons[0]!.props.onClick());
    act(() => buttons[1]!.props.onClick());
    act(() => buttons[2]!.props.onClick());
    act(() => buttons[3]!.props.onClick());
    act(() => buttons[4]!.props.onClick());
    expect(onToggleVariant).toHaveBeenCalledWith("expanded");
    expect(onOpenApprovals).toHaveBeenCalledTimes(1);
    expect(onOpenAgents).toHaveBeenCalledTimes(1);
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
    expect(onOpenCosts).toHaveBeenCalledTimes(1);
  });

  it("tracks compact viewport media changes through modern and legacy matchMedia APIs", () => {
    const modernListeners: Array<(event: { matches: boolean }) => void> = [];
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn((_type: string, listener: (event: { matches: boolean }) => void) =>
          modernListeners.push(listener),
        ),
        removeEventListener,
      })),
    });

    const modern = create(<StatusStrip {...statusProps({ variant: "expanded" })} />);
    expect(modern.root.findByType("section").props.className).toContain("compact");
    act(() => modernListeners[0]!({ matches: false }));
    expect(modern.root.findByType("section").props.className).not.toContain(" compact");
    act(() => modern.unmount());
    expect(removeEventListener).toHaveBeenCalled();

    const legacyListeners: Array<(event: { matches: boolean }) => void> = [];
    const removeListener = vi.fn();
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({
        matches: false,
        addListener: vi.fn((listener: (event: { matches: boolean }) => void) => legacyListeners.push(listener)),
        removeListener,
      })),
    });
    const legacy = create(<StatusStrip {...statusProps({ variant: "expanded", openTasksCount: 2 })} />);
    expect(text(legacy.root)).toContain("2");
    act(() => legacyListeners[0]!({ matches: true }));
    expect(legacy.root.findByType("section").props.className).toContain("compact");
    act(() => legacy.unmount());
    expect(removeListener).toHaveBeenCalled();
  });

  it("renders freshness labels for compact and detailed stream states", () => {
    statusHandlers.useEventStreamStatus.mockReturnValue({
      state: "retrying",
      lastEventAt: Date.UTC(2026, 4, 14, 12, 30, 0),
      reconnectAttempts: 2,
      gatewayNodeId: "gateway-a",
    });

    const full = create(<GlobalFreshnessPill streamState="error" />);
    expect(normalizedText(full.root)).toContain("Degraded");
    expect(normalizedText(full.root)).toContain("Gateway: gateway-a");
    expect(normalizedText(full.root)).toContain("Reconnects: 2");

    const compact = create(<GlobalFreshnessPill streamState="connecting" variant="compact" />);
    expect(normalizedText(compact.root)).toContain("Reconnecting");

    statusHandlers.useEventStreamStatus.mockReturnValue({
      state: "closed",
      lastEventAt: 0,
      reconnectAttempts: 0,
      gatewayNodeId: "",
    });
    const offline = create(<GlobalFreshnessPill streamState="closed" />);
    expect(normalizedText(offline.root)).toContain("Offline");
    expect(normalizedText(offline.root)).toContain("n/a");
  });

  it("handles segmented-control keyboard navigation and disabled no-op branches", () => {
    const onChange = vi.fn();
    const preventDefault = vi.fn();
    const focusOne = vi.fn();
    const focusTwo = vi.fn();
    const renderer = create(
      <GCSegmentedControl
        value="one"
        ariaLabel="Mode"
        onChange={onChange}
        options={[
          { value: "one", label: "One" },
          { value: "skip", label: "Skip", disabled: true },
          { value: "two", label: "Two" },
        ]}
      />,
      {
        createNodeMock: (element) => {
          if (element.type !== "button") {
            return {};
          }
          return element.props.children === "One" ? { focus: focusOne } : { focus: focusTwo };
        },
      },
    );

    const [one, skip, two] = renderer.root.findAllByType("button");
    act(() => one!.props.onKeyDown({ key: "ArrowRight", preventDefault }));
    expect(onChange).toHaveBeenCalledWith("two");
    expect(focusTwo).toHaveBeenCalled();

    act(() => two!.props.onKeyDown({ key: "ArrowLeft", preventDefault }));
    act(() => two!.props.onKeyDown({ key: "Home", preventDefault }));
    act(() => one!.props.onKeyDown({ key: "End", preventDefault }));
    expect(focusOne).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(4);

    act(() => skip!.props.onKeyDown({ key: "ArrowRight", preventDefault }));
    act(() => skip!.props.onKeyDown({ key: "x", preventDefault }));
    expect(preventDefault).toHaveBeenCalledTimes(4);
  });
});
