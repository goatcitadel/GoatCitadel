import React from "react";
import { act, create, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { OfficeOperationsDock, type OfficeOperationsDockProps } from "./OfficeOperationsDock";

vi.mock("../../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
}));

vi.mock("../../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    actions,
    children,
    className,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
  }) => (
    <section className={className}>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      {actions}
      {children}
    </section>
  ),
}));

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

function normalizedText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  return collectText(node).replace(/\s+/g, " ").trim();
}

function baseProps(overrides: Partial<OfficeOperationsDockProps> = {}): OfficeOperationsDockProps {
  return {
    showInspectorDock: true,
    showRailDock: true,
    dockTab: "inspector",
    onDockTabChange: vi.fn(),
    availableDockTabs: ["inspector", "operators", "approvals", "rail"],
    renderInspector: () => <div>Inspector details</div>,
    operators: [
      {
        operatorId: "operator-1",
        activeSessions: 2,
        sessionCount: 5,
        lastActivityAt: "2026-05-04T00:00:00.000Z",
      },
    ] as never,
    pendingApprovals: [
      {
        approvalId: "approval-1",
        kind: "tool",
        riskLevel: "medium",
        status: "pending",
        createdAt: "2026-05-04T00:01:00.000Z",
      },
    ] as never,
    sceneEvents: [
      {
        eventId: "event-1",
        eventType: "tool.completed",
        timestamp: "2026-05-04T00:02:00.000Z",
        source: "gateway",
      },
    ] as never,
    formatRelative: (value) => `relative ${value ?? "unknown"}`,
    formatClock: (value) => `clock ${value ?? "unknown"}`,
    summarizeEvent: (event) => `summary ${event.eventType}`,
    ...overrides,
  };
}

describe("OfficeOperationsDock", () => {
  it("shows a hidden-dock recovery panel when both dock surfaces are disabled", () => {
    const renderer = create(<OfficeOperationsDock {...baseProps({ showInspectorDock: false, showRailDock: false })} />);

    const text = normalizedText(renderer.toJSON());
    expect(text).toContain("Operations Dock Hidden");
    expect(text).toContain("restore the side dock");
  });

  it("renders dock tabs and routes tab changes", () => {
    const onDockTabChange = vi.fn();
    const renderer = create(<OfficeOperationsDock {...baseProps({ onDockTabChange })} />);

    expect(normalizedText(renderer.toJSON())).toContain("Inspector details");

    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => collectText(button.children as never) === "Operators")!
        .props.onClick();
    });

    expect(onDockTabChange).toHaveBeenCalledWith("operators");
  });

  it("renders operator, approval, and rail states including empty fallbacks", () => {
    const renderer = create(<OfficeOperationsDock {...baseProps({ dockTab: "operators" })} />);
    expect(normalizedText(renderer.toJSON())).toContain("operator-1");
    expect(normalizedText(renderer.toJSON())).toContain("2 active / 5 total sessions");

    renderer.update(<OfficeOperationsDock {...baseProps({ dockTab: "approvals" })} />);
    expect(normalizedText(renderer.toJSON())).toContain("medium - pending");

    renderer.update(<OfficeOperationsDock {...baseProps({ dockTab: "approvals", pendingApprovals: [] })} />);
    expect(normalizedText(renderer.toJSON())).toContain("No pending approvals.");

    renderer.update(<OfficeOperationsDock {...baseProps({ dockTab: "rail" })} />);
    expect(normalizedText(renderer.toJSON())).toContain("summary tool.completed");
    expect(normalizedText(renderer.toJSON())).toContain("clock 2026-05-04T00:02:00.000Z - gateway");

    renderer.update(<OfficeOperationsDock {...baseProps({ dockTab: "rail", sceneEvents: [] })} />);
    expect(normalizedText(renderer.toJSON())).toContain("No live events yet.");
  });
});
