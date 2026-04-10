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
    collapsed: true,
    onCollapsedChange: vi.fn(),
    onOpenApprovals: vi.fn(),
    onOpenAgents: vi.fn(),
    onOpenCosts: vi.fn(),
    onOpenTasks: vi.fn(),
    ...overrides,
  };
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

    expect(props.onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("renders the detailed operator cards when expanded", () => {
    stubMatchMedia(false);
    const renderer = create(<StatusStrip {...buildProps({ collapsed: false })} />);
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain("Pending decisions");
    expect(text).toContain("Active agents");
    expect(text).toContain("Open tasks");
  });
});
