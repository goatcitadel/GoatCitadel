import React from "react";
import { act, create } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));

vi.mock("./ui/badge", () => ({
  Badge: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));

vi.mock("./ui/button", () => ({
  Button: ({
    children,
    className,
    ...props
  }: {
    children?: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <button type="button" className={className} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("./ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("./ui/separator", () => ({
  Separator: ({ className }: { className?: string }) => <hr className={className} />,
}));

import { cycleShellNavMode, ShellNavRail } from "./ShellNavRail";

describe("ShellNavRail", () => {
  it("cycles rail density through expanded, compact, and icon modes", () => {
    expect(cycleShellNavMode("expanded")).toBe("compact");
    expect(cycleShellNavMode("compact")).toBe("icon");
    expect(cycleShellNavMode("icon")).toBe("expanded");
  });

  it("hides section labels in icon mode", () => {
    const markup = renderToStaticMarkup(
      <ShellNavRail
        route={{ space: "operate", page: "surface", surface: "chat" }}
        visiblePage="chat"
        navMode="icon"
        approvalsCount={0}
        onSelectSpace={() => undefined}
        onSelectVisiblePage={() => undefined}
        onCycleNavMode={() => undefined}
      />,
    );

    expect(markup).not.toContain("Spaces");
    expect(markup).not.toContain("Modes");
    expect(markup).not.toContain("Queue");
    expect(markup).not.toContain("Operator rail");
  });

  it("shows expanded descriptions, approval counts, and dispatches navigation callbacks", () => {
    const onSelectSpace = vi.fn();
    const onSelectVisiblePage = vi.fn();
    const onCycleNavMode = vi.fn();
    const renderer = create(
      <ShellNavRail
        route={{ space: "operate", page: "surface", surface: "chat" }}
        visiblePage="approvals"
        navMode="expanded"
        approvalsCount={3}
        onSelectSpace={onSelectSpace}
        onSelectVisiblePage={onSelectVisiblePage}
        onCycleNavMode={onCycleNavMode}
      />,
    );

    const markup = renderToStaticMarkup(
      <ShellNavRail
        route={{ space: "operate", page: "surface", surface: "chat" }}
        visiblePage="approvals"
        navMode="expanded"
        approvalsCount={3}
        onSelectSpace={() => undefined}
        onSelectVisiblePage={() => undefined}
        onCycleNavMode={() => undefined}
      />,
    );
    expect(markup).toContain("Spaces");
    expect(markup).toContain("3 pending");

    const buttons = renderer.root.findAllByType("button");
    act(() => {
      buttons.find((button) => button.props["aria-label"] === "Cycle rail density")?.props.onClick();
      buttons.find((button) => button.props["aria-label"] === "Configure")?.props.onClick();
      buttons.find((button) => button.props["aria-label"] === "Approvals")?.props.onClick();
    });

    expect(onCycleNavMode).toHaveBeenCalledOnce();
    expect(onSelectSpace).toHaveBeenCalledWith("configure");
    expect(onSelectVisiblePage).toHaveBeenCalledWith("approvals");
  });

  it("uses compact page badges without descriptions", () => {
    const markup = renderToStaticMarkup(
      <ShellNavRail
        route={{ space: "configure", page: "settings" }}
        visiblePage="general"
        navMode="compact"
        approvalsCount={0}
        onSelectSpace={() => undefined}
        onSelectVisiblePage={() => undefined}
        onCycleNavMode={() => undefined}
      />,
    );

    expect(markup).toContain("Mission Control");
    expect(markup).toContain(">Icon<");
    expect(markup).not.toContain("pending");
  });
});
