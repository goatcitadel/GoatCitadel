import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusStrip } from "./StatusStrip";

function stubMatchMedia(matches = false) {
  vi.stubGlobal("window", {
    matchMedia: vi.fn(() => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function buildProps(overrides: Partial<React.ComponentProps<typeof StatusStrip>> = {}) {
  return {
    approvalsCount: 2,
    activeAgentsCount: 3,
    dailyCostUsd: 4.25,
    openTasksCount: 5,
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

function collectText(value: unknown): string {
  if (value == null || typeof value === "boolean") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => collectText(item)).join("");
  }
  if (typeof value === "object" && "children" in value) {
    return collectText((value as { children?: unknown }).children);
  }
  if (typeof value === "object" && "props" in value) {
    return collectText((value as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StatusStrip", () => {
  it("routes summary toggles through the controlled collapse callback", async () => {
    stubMatchMedia(false);
    const props = buildProps();
    const renderer = create(<StatusStrip {...props} />);

    const [summaryButton] = renderer.root.findAllByType("button");
    await act(async () => {
      summaryButton?.props.onClick?.();
    });

    expect(props.onToggleVariant).toHaveBeenCalledWith("expanded");
  });

  it("renders the detailed operator cards when expanded", () => {
    stubMatchMedia(false);
    const renderer = create(<StatusStrip {...buildProps({ variant: "expanded" })} />);
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain("Pending decisions");
    expect(text).toContain("Active agents");
    expect(text).toContain("Open tasks");
  });

  it("renders only the expanded detail panel when attached to shell band 2", () => {
    stubMatchMedia(false);
    const renderer = create(<StatusStrip {...buildProps({ variant: "expanded", placement: "attached" })} />);
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain("Pending decisions");
    expect(text).not.toContain("status-strip-summary");
    expect(text).not.toContain("Decisions clear");
  });

  it("stays hidden when attached and compact", () => {
    stubMatchMedia(false);
    const renderer = create(<StatusStrip {...buildProps({ variant: "compact", placement: "attached" })} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it("formats compact summaries, spend thresholds, mobile class, and navigation callbacks", async () => {
    stubMatchMedia(true);
    const props = buildProps({
      approvalsCount: 0,
      activeAgentsCount: 0,
      dailyCostUsd: 125,
      openTasksCount: 1,
      variant: "compact",
      context: "observe",
    });
    const renderer = create(<StatusStrip {...props} />);
    const text = JSON.stringify(renderer.toJSON());
    const visibleText = collectText(renderer.toJSON());

    expect(text).toContain("status-strip-context-observe compact collapsed");
    expect(visibleText).toContain("1 open task");
    expect(visibleText).toContain("No active agents");
    expect(visibleText).toContain("$125 today");

    const buttons = renderer.root
      .findAllByType("button")
      .filter((button) => String(button.props.className).includes("gc-nav"));
    await act(async () => {
      buttons.find((button) => collectText(button.props.children).includes("Decisions clear"))?.props.onClick();
      buttons.find((button) => collectText(button.props.children).includes("No active agents"))?.props.onClick();
      buttons.find((button) => collectText(button.props.children).includes("1 open tasks"))?.props.onClick();
      buttons.find((button) => collectText(button.props.children).includes("$125 today"))?.props.onClick();
    });

    expect(props.onOpenApprovals).toHaveBeenCalledTimes(1);
    expect(props.onOpenAgents).toHaveBeenCalledTimes(1);
    expect(props.onOpenTasks).toHaveBeenCalledTimes(1);
    expect(props.onOpenCosts).toHaveBeenCalledTimes(1);
  });

  it("supports legacy matchMedia listener cleanup and lower spend precision branches", () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({
        matches: false,
        addListener,
        removeListener,
      })),
    });
    const renderer = create(
      <StatusStrip
        {...buildProps({
          approvalsCount: 1,
          activeAgentsCount: 1,
          dailyCostUsd: 10.5,
          openTasksCount: 0,
          variant: "expanded",
        })}
      />,
    );

    expect(addListener).toHaveBeenCalledTimes(1);
    expect(collectText(renderer.toJSON())).toContain("$10.5");

    renderer.update(
      <StatusStrip
        {...buildProps({
          approvalsCount: 0,
          activeAgentsCount: 0,
          dailyCostUsd: 4.25,
          openTasksCount: 0,
          variant: "compact",
        })}
      />,
    );
    expect(collectText(renderer.toJSON())).toContain("$4.25 today");

    renderer.unmount();
    expect(removeListener).toHaveBeenCalledTimes(1);
  });
});
