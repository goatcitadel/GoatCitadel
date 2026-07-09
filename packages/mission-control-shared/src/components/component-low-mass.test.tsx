import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmbeddedPageChromeProvider } from "./EmbeddedPageChrome";
import { ChatModeSwitch } from "./ChatModeSwitch";
import { ClockBadge } from "./ClockBadge";
import { HelpHint } from "./HelpHint";
import { PageHeader } from "./PageHeader";
import { ShellActionGroup } from "./ShellActionGroup";
import { ShellDetailPanelProvider, useShellDetailPanel } from "./ShellDetailPanelContext";
import { ShellStatusCenter } from "./ShellStatusCenter";
import { TableSkeleton } from "./TableSkeleton";
import { ConfigureHubLayout } from "./ConfigureHubLayout";
import { ChatPlanningPill } from "./chat/ChatPlanningPill";
import { IDLE_ACTION_STATE, isPending } from "../state/action-state";
import type { ShellStatusSummary } from "./shell-status-model";

function textOf(node: unknown): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return ((node as { children?: unknown[] }).children ?? []).map(textOf).join(" ");
  }
  return "";
}

function summary(overrides: Partial<ShellStatusSummary> = {}): ShellStatusSummary {
  return {
    tone: "success",
    label: "All systems nominal",
    note: "Gateway linked",
    approvalCount: 0,
    sections: [
      {
        id: "runtime",
        title: "Runtime",
        summary: "6 checks",
        entries: [
          { id: "default", label: "Default", value: "Idle", tone: "default" },
          { id: "warning", label: "Warning", value: "Needs input", note: "Review queue", tone: "warning" },
          { id: "critical", label: "Critical", value: "Blocked", tone: "critical", actionLabel: "Fix" },
          { id: "success", label: "Success", value: "Healthy", tone: "success" },
          { id: "live", label: "Live", value: "Streaming", tone: "live" },
          { id: "muted", label: "Muted", value: "Quiet", tone: "muted", actionLabel: "Open" },
        ],
      },
    ],
    ...overrides,
  };
}

function ShellDetailHarness({
  entries,
  onSnapshot,
}: {
  entries: Array<{ id: string; title: string; priority?: number }>;
  onSnapshot: (value: ReturnType<typeof useShellDetailPanel>) => void;
}) {
  const context = useShellDetailPanel();
  const { registerEntry } = context;
  React.useEffect(() => {
    const cleanups = entries.map((entry) =>
      registerEntry({
        ...entry,
        body: <span>{entry.title} body</span>,
      }),
    );
    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [entries, registerEntry]);
  onSnapshot(context);
  return <button onClick={context.openPanel}>{context.activeEntry?.title ?? "none"}</button>;
}

describe("small shared shell components", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders status-center summaries, tone labels, and entry actions", () => {
    const onToggle = vi.fn();
    const onEntryAction = vi.fn();
    const renderer = create(
      <ShellStatusCenter summary={summary({ approvalCount: 1 })} expanded={false} onToggle={onToggle} />,
    );
    expect(textOf(renderer.toJSON())).toContain("1 decision");
    act(() => {
      renderer.root.findByType("button").props.onClick();
    });
    expect(onToggle).toHaveBeenCalled();

    renderer.update(
      <ShellStatusCenter
        summary={summary({ approvalCount: 2 })}
        expanded
        onToggle={onToggle}
        onEntryAction={onEntryAction}
      />,
    );
    const expandedText = textOf(renderer.toJSON());
    expect(expandedText).toContain("2 decisions");
    expect(expandedText).toContain("Attention");
    expect(expandedText).toContain("Critical");
    expect(expandedText).toContain("Healthy");
    expect(expandedText).toContain("Live");
    expect(expandedText).toContain("Quiet");

    act(() => {
      renderer.root.findAllByProps({ className: "shell-status-entry-card interactive" })[0]!.props.onClick();
    });
    expect(onEntryAction).toHaveBeenCalledWith(expect.objectContaining({ id: "critical" }));

    renderer.update(<ShellStatusCenter summary={summary()} expanded={false} onToggle={onToggle} />);
    expect(textOf(renderer.toJSON())).toContain("Clear");
  });

  it("renders page headers, skeleton tables, hints, mode switches, and planning pills", () => {
    const header = create(
      <PageHeader
        eyebrow="Ops"
        title="Mission Control"
        subtitle={<span>Surface status</span>}
        hint={<span>Trust signals</span>}
        actions={<button type="button">Refresh</button>}
        className="custom-header"
        variant="hero"
        density="standard"
      />,
    );
    expect(textOf(header.toJSON())).toContain("Mission Control");
    expect(JSON.stringify(header.toJSON())).toContain("custom-header");

    const hiddenHeader = create(
      <EmbeddedPageChromeProvider>
        <PageHeader title="Hidden" />
      </EmbeddedPageChromeProvider>,
    );
    expect(hiddenHeader.toJSON()).toBeNull();
    hiddenHeader.update(
      <EmbeddedPageChromeProvider>
        <PageHeader title="Forced" forceVisible />
      </EmbeddedPageChromeProvider>,
    );
    expect(textOf(hiddenHeader.toJSON())).toContain("Forced");

    const skeleton = create(<TableSkeleton rows={2} cols={3} />);
    expect(skeleton.root.findAllByType("tr")).toHaveLength(3);
    expect(skeleton.root.findAllByType("td")).toHaveLength(6);

    const hint = create(<HelpHint label="Explain" text="Detailed help" symbol="i" className="hint-extra" />);
    const hintButton = hint.root.findByType("button");
    expect(hintButton.props["aria-label"]).toBe("Explain");
    act(() => {
      hintButton.props.onMouseEnter();
    });
    expect(textOf(hint.toJSON())).toContain("Detailed help");
    act(() => {
      hintButton.props.onMouseLeave();
      hintButton.props.onFocus();
      hintButton.props.onBlur();
      hintButton.props.onClick();
    });
    expect(textOf(hint.toJSON())).toContain("Detailed help");

    const onModeChange = vi.fn();
    const modeSwitch = create(<ChatModeSwitch value="chat" onChange={onModeChange} />);
    expect(modeSwitch.root.findAllByType("button")).toHaveLength(1);
    modeSwitch.update(<ChatModeSwitch value="chat" disabled onChange={onModeChange} />);
    expect(modeSwitch.root.findAllByType("button").every((button) => button.props.disabled)).toBe(true);

    expect(create(<ChatPlanningPill planningMode={undefined} />).toJSON()).toBeNull();
    expect(textOf(create(<ChatPlanningPill planningMode="advisory" />).toJSON())).toContain("Planning mode");
    expect(
      textOf(create(<ChatPlanningPill planningMode="advisory" effectiveToolAutonomy="manual" />).toJSON()),
    ).toContain("manual tools");
  });

  it("renders action groups, pending state helpers, and configure hub tab behavior", () => {
    expect(isPending(IDLE_ACTION_STATE)).toBe(false);
    expect(isPending({ state: "pending", startedAt: "2026-05-14T00:00:00.000Z" })).toBe(true);

    const actionGroup = create(
      <ShellActionGroup className="extra-actions">
        <button type="button">Run check</button>
      </ShellActionGroup>,
    );
    const actionGroupJson = JSON.stringify(actionGroup.toJSON());
    expect(actionGroupJson).toContain("shell-action-group extra-actions");
    expect(actionGroupJson).toContain("Run check");

    const onTabChange = vi.fn();
    const onActiveEntryChange = vi.fn();
    const renderer = create(
      <ShellDetailPanelProvider
        isOpen={false}
        onOpenPanel={vi.fn()}
        onClosePanel={vi.fn()}
        onActiveEntryChange={onActiveEntryChange}
      >
        <ConfigureHubLayout
          title="Providers"
          subtitle="Model routing"
          className="providers-hub"
          guideTitle="Provider guide"
          guideBody="Configure provider truth."
          summaries={[
            { label: "Ready", value: "2", note: "healthy", tone: "success" },
            { label: "Hidden", value: null },
          ]}
          summaryMode="posture"
          showSummaryNotes
          tabItems={[
            { id: "overview", label: "Overview" },
            { id: "secrets", label: "Secrets" },
          ]}
          activeTab="overview"
          onTabChange={onTabChange}
          tabAriaLabel="Provider sections"
        >
          Body
        </ConfigureHubLayout>
      </ShellDetailPanelProvider>,
    );

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain("providers-hub");
    expect(rendered).toContain("healthy");
    expect(rendered).not.toContain("Hidden");

    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.join("") === "Secrets")!
        .props.onClick();
    });
    expect(onTabChange).toHaveBeenCalledWith("secrets");
    expect(onActiveEntryChange).toHaveBeenCalledWith(expect.objectContaining({ title: "Provider guide" }));
  });

  it("selects shell detail entries by priority, order, and unregister callbacks", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const onActiveEntryChange = vi.fn();
    const snapshots: Array<ReturnType<typeof useShellDetailPanel>> = [];
    const renderer = create(
      <ShellDetailPanelProvider
        isOpen={false}
        onOpenPanel={onOpen}
        onClosePanel={onClose}
        onActiveEntryChange={onActiveEntryChange}
      >
        <ShellDetailHarness
          entries={[
            { id: "low", title: "Low", priority: 1 },
            { id: "high-a", title: "High A", priority: 5 },
            { id: "high-b", title: "High B", priority: 5 },
          ]}
          onSnapshot={(snapshot) => snapshots.push(snapshot)}
        />
      </ShellDetailPanelProvider>,
    );

    expect(textOf(renderer.toJSON())).toContain("High B");
    act(() => {
      renderer.root.findByType("button").props.onClick();
    });
    expect(onOpen).toHaveBeenCalled();
    act(() => {
      snapshots.at(-1)?.closePanel();
    });
    expect(onClose).toHaveBeenCalled();
    expect(onActiveEntryChange).toHaveBeenCalledWith(expect.objectContaining({ id: "high-b" }));

    renderer.update(
      <ShellDetailPanelProvider
        isOpen
        onOpenPanel={onOpen}
        onClosePanel={onClose}
        onActiveEntryChange={onActiveEntryChange}
      >
        <ShellDetailHarness entries={[{ id: "low", title: "Low", priority: 1 }]} onSnapshot={() => undefined} />
      </ShellDetailPanelProvider>,
    );
    expect(textOf(renderer.toJSON())).toContain("Low");
  });

  it("updates the clock badge through the browser timer APIs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 10, 15));
    vi.stubGlobal("window", {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });

    const renderer = create(<ClockBadge />);
    expect(textOf(renderer.toJSON())).toContain("10:15");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(textOf(renderer.toJSON())).toContain("10:16");
    renderer.unmount();
  });
});
