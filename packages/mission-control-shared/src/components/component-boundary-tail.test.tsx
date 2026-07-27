import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CardSkeleton } from "./CardSkeleton";
import { ChangeReviewPanel } from "./ChangeReviewPanel";
import { DataToolbar } from "./DataToolbar";
import { EmbeddedPageChromeProvider } from "./EmbeddedPageChrome";
import { FieldHelp } from "./FieldHelp";
import { GoatLoader } from "./GoatLoader";
import { InlineHelp } from "./InlineHelp";
import { NotificationStack, upsertNotificationItem, type NotificationItem } from "./NotificationStack";
import { OfficeCanvasErrorBoundary } from "./OfficeCanvasErrorBoundary";
import { PageErrorBoundary } from "./PageErrorBoundary";
import { ShellPageFrame } from "./ShellPageFrame";
import { ChatStreamStatusBar } from "./chat/ChatStreamStatusBar";
import { formatWorkProviderModelSummary, formatWorkloadSummaryDescriptor } from "../pages/chat/work-trust";

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

function ThrowWhen({ active }: { active: boolean }) {
  if (active) {
    throw new Error("render failed");
  }
  return <span>Recovered child</span>;
}

describe("shared boundary and presentation tail components", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recovers page render failures through retry and reset-key changes", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onReturnToChat = vi.fn();
    let shouldThrow = true;
    const renderer = create(
      <PageErrorBoundary resetKey="one" pageLabel="Tasks" onReturnToChat={onReturnToChat}>
        <ThrowWhen active={shouldThrow} />
      </PageErrorBoundary>,
    );

    expect(textOf(renderer.toJSON())).toContain("hit a render failure");
    expect(consoleSpy).toHaveBeenCalledWith(
      "[PageErrorBoundary] page render failed",
      expect.objectContaining({ pageLabel: "Tasks" }),
    );

    const buttons = renderer.root.findAllByType("button");
    act(() => {
      buttons.find((button) => textOf(button.props.children).includes("Return to Chat"))!.props.onClick();
    });
    expect(onReturnToChat).toHaveBeenCalled();

    shouldThrow = false;
    renderer.update(
      <PageErrorBoundary resetKey="one" pageLabel="Tasks" onReturnToChat={onReturnToChat}>
        <ThrowWhen active={shouldThrow} />
      </PageErrorBoundary>,
    );
    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Retry page"))!
        .props.onClick();
    });
    expect(textOf(renderer.toJSON())).toContain("Recovered child");

    shouldThrow = true;
    renderer.update(
      <PageErrorBoundary resetKey="one" pageLabel="Tasks" onReturnToChat={onReturnToChat}>
        <ThrowWhen active={shouldThrow} />
      </PageErrorBoundary>,
    );
    shouldThrow = false;
    renderer.update(
      <PageErrorBoundary resetKey="two" pageLabel="Tasks" onReturnToChat={onReturnToChat}>
        <ThrowWhen active={shouldThrow} />
      </PageErrorBoundary>,
    );
    expect(textOf(renderer.toJSON())).toContain("Recovered child");
  });

  it("reports office canvas failures and resets on a new scene key", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let shouldThrow = true;
    const renderer = create(
      <OfficeCanvasErrorBoundary resetKey="scene-a">
        <ThrowWhen active={shouldThrow} />
      </OfficeCanvasErrorBoundary>,
    );
    expect(textOf(renderer.toJSON())).toContain("Office scene failed to render");

    shouldThrow = false;
    renderer.update(
      <OfficeCanvasErrorBoundary resetKey="scene-b">
        <ThrowWhen active={shouldThrow} />
      </OfficeCanvasErrorBoundary>,
    );
    expect(textOf(renderer.toJSON())).toContain("Recovered child");
  });

  it("renders compact presentational wrappers and embedded toolbar variants", () => {
    expect(textOf(create(<CardSkeleton lines={3} />).toJSON()).trim()).toBe("");
    expect(create(<CardSkeleton lines={3} />).root.findAllByProps({ className: "skeleton-line" })).toHaveLength(3);

    expect(textOf(create(<FieldHelp className="field-extra">Field copy</FieldHelp>).toJSON())).toContain("Field copy");
    expect(textOf(create(<InlineHelp className="inline-extra">Inline copy</InlineHelp>).toJSON())).toContain(
      "Inline copy",
    );
    expect(textOf(create(<GoatLoader label="Loading missions" compact />).toJSON())).toContain("Loading missions");

    const toolbar = create(
      <DataToolbar primary={<button type="button">Primary</button>} center={<span>Center</span>} secondary="Second" />,
    );
    expect(JSON.stringify(toolbar.toJSON())).toContain("data-toolbar-has-primary");
    toolbar.update(
      <EmbeddedPageChromeProvider>
        <DataToolbar primary="Primary" center="Center" secondary="Second" className="extra" />
      </EmbeddedPageChromeProvider>,
    );
    expect(JSON.stringify(toolbar.toJSON())).toContain("action-bar-has-secondary");

    const frame = create(
      <ShellPageFrame title="Runs" subtitle={<span>Queue state</span>} actions={<button type="button">New</button>}>
        <span>Embedded body</span>
      </ShellPageFrame>,
    );
    expect(textOf(frame.toJSON())).toContain("Runs");
    expect(textOf(frame.toJSON())).toContain("Embedded body");
  });

  it("renders change review, notifications, stream status, and work-trust labels", () => {
    const onCriticalConfirmChange = vi.fn();
    const review = create(
      <ChangeReviewPanel
        overall="critical"
        items={[{ field: "Provider", level: "warning", hint: "Model changed" }]}
        requireCriticalConfirm
        onCriticalConfirmChange={onCriticalConfirmChange}
      />,
    );
    expect(textOf(review.toJSON())).toContain("Overall risk");
    act(() => {
      review.root.findByType("input").props.onChange({ target: { checked: true } });
    });
    expect(onCriticalConfirmChange).toHaveBeenCalledWith(true);
    review.update(<ChangeReviewPanel overall="safe" items={[]} />);
    expect(textOf(review.toJSON())).toContain("No pending edits.");

    const now = new Date(2026, 0, 1, 9, 30).getTime();
    const incoming: NotificationItem = { id: "n1", tone: "warning", message: "Retry needed", timestamp: now };
    const grouped = upsertNotificationItem([incoming], {
      id: "n2",
      tone: "warning",
      message: "Retry needed",
      timestamp: now + 1,
    });
    expect(grouped[0]).toMatchObject({ id: "n1", count: 2 });
    const replacedGroup = upsertNotificationItem(grouped, {
      id: "n3",
      tone: "error",
      message: "Different",
      groupKey: "deploy",
      timestamp: now + 2,
    });
    expect(
      upsertNotificationItem(replacedGroup, {
        id: "n4",
        tone: "success",
        message: "Sent",
        groupKey: "deploy",
        timestamp: now + 3,
      })[0],
    ).toMatchObject({
      id: "n3",
      count: 1,
      message: "Sent",
    });

    const onDismiss = vi.fn();
    let stack!: ReturnType<typeof create>;
    act(() => {
      stack = create(<NotificationStack items={grouped} onDismiss={onDismiss} />);
    });
    expect(textOf(stack.toJSON())).toContain("x 2");
    act(() => {
      stack.root.findByType("button").props.onClick();
    });
    expect(onDismiss).toHaveBeenCalledWith("n1");
    stack.update(<NotificationStack items={[]} onDismiss={onDismiss} />);
    expect(stack.toJSON()).toBeNull();

    // The enter animation must run only on an item's FIRST mount. Grouped
    // upserts move items to the front of the list, which re-inserts their DOM
    // nodes; re-applying the animation class there restarts the keyframe
    // animation from opacity 0 and makes the whole stack flicker translucent
    // during event bursts.
    const itemClasses = (renderer: ReturnType<typeof create>): Map<string, string> => {
      const map = new Map<string, string>();
      for (const node of renderer.root.findAll((candidate) => candidate.type === "div")) {
        const className = String(node.props.className ?? "");
        if (!className.split(" ").includes("notification-item")) {
          continue;
        }
        const message = textOf(node.children as unknown);
        map.set(message, className);
      }
      return map;
    };
    const first: NotificationItem = { id: "e1", tone: "info", message: "First", timestamp: now };
    const second: NotificationItem = { id: "e2", tone: "info", message: "Second", timestamp: now + 1 };
    let enterStack!: ReturnType<typeof create>;
    act(() => {
      enterStack = create(<NotificationStack items={[first]} onDismiss={onDismiss} />);
    });
    expect([...itemClasses(enterStack).values()][0]).toContain("notification-item-enter");
    act(() => {
      enterStack.update(<NotificationStack items={[second, { ...first, count: 2 }]} onDismiss={onDismiss} />);
    });
    const classesAfterReorder = itemClasses(enterStack);
    expect([...classesAfterReorder.entries()].find(([text]) => text.includes("Second"))?.[1]).toContain(
      "notification-item-enter",
    );
    expect([...classesAfterReorder.entries()].find(([text]) => text.includes("First"))?.[1]).not.toContain(
      "notification-item-enter",
    );

    expect(create(<ChatStreamStatusBar status="idle" queuedCount={0} error={null} />).toJSON()).toBeNull();
    expect(textOf(create(<ChatStreamStatusBar status="connecting" queuedCount={0} error={null} />).toJSON())).toContain(
      "Connecting...",
    );
    expect(
      textOf(create(<ChatStreamStatusBar mode="cowork" status="streaming" queuedCount={2} error={null} />).toJSON()),
    ).toContain("Run response streaming (2 queued messages)");
    expect(textOf(create(<ChatStreamStatusBar status="queued" queuedCount={1} error={null} />).toJSON())).toContain(
      "1 message queued",
    );
    expect(
      textOf(create(<ChatStreamStatusBar mode="cowork" status="error" queuedCount={0} error="boom" />).toJSON()),
    ).toContain("Run response error boom");

    expect(formatWorkProviderModelSummary("OpenAI", "gpt-5.4")).toBe("OpenAI / gpt-5.4");
    expect(formatWorkProviderModelSummary("OpenAI", null)).toBe("OpenAI");
    expect(formatWorkProviderModelSummary(null, "local-model")).toBe("local-model");
    expect(formatWorkProviderModelSummary()).toBe("Provider routing pending");
    expect(
      formatWorkloadSummaryDescriptor({ approvalsCount: 1, activeAgentsCount: 0, openTasksCount: 0, dailyCostUsd: 0 }),
    ).toEqual({
      tone: "warning",
      label: "1 approval waiting",
    });
    expect(
      formatWorkloadSummaryDescriptor({ approvalsCount: 0, activeAgentsCount: 2, openTasksCount: 1, dailyCostUsd: 12 }),
    ).toMatchObject({
      tone: "live",
      label: "2 agents live · 1 task · $12.0",
    });
    expect(
      formatWorkloadSummaryDescriptor({
        approvalsCount: 0,
        activeAgentsCount: 0,
        openTasksCount: 3,
        dailyCostUsd: 0.5,
      }),
    ).toMatchObject({
      tone: "muted",
      label: "3 open tasks · $0.50",
    });
    expect(
      formatWorkloadSummaryDescriptor({ approvalsCount: 0, activeAgentsCount: 0, openTasksCount: 0, dailyCostUsd: 0 }),
    ).toMatchObject({
      tone: "muted",
      label: "Workload clear",
    });
  });
});
