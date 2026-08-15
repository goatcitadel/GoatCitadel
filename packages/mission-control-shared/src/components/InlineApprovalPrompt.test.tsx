import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InlineApprovalPrompt } from "./InlineApprovalPrompt";

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

const noopCallbacks = {
  onApproveOnce: vi.fn(),
  onApproveInSession: vi.fn(),
  onApproveInWorkspace: vi.fn(),
  onDeny: vi.fn(),
};

describe("InlineApprovalPrompt countdown accessibility", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    renderer = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    renderer?.unmount();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps the ticking countdown out of the assertive alert subtree", () => {
    renderer = create(
      <InlineApprovalPrompt
        approvalId="approval-a11y"
        kind="tool_call"
        toolName="browser.open"
        riskLevel="caution"
        expiresAt="2026-01-01T00:05:00.000Z"
        remainingCount={3}
        {...noopCallbacks}
      />,
    );

    // The visible countdown still renders for sighted users.
    const fullText = textOf(renderer.toJSON());
    expect(fullText).toContain("Expires in 5m 00s");
    expect(fullText).toContain("more waiting");

    // The assertive live region (role="alert") must announce only the static
    // decision summary — never the per-second countdown text.
    const alert = renderer.root.findByProps({ role: "alert" });
    const alertText = textOf(alert.props.children);
    expect(alertText).not.toContain("Expires in");
    expect(alertText).not.toContain("more waiting");
    expect(alertText.length).toBeGreaterThan(0);

    // Every countdown span is explicitly excluded from any live region so a
    // mutation (4m 59s -> 4m 58s) does not trigger a re-announce.
    const countdowns = renderer.root.findAll(
      (node) => typeof node.props.className === "string" && node.props.className.includes("chat-approval-countdown"),
    );
    expect(countdowns.length).toBeGreaterThan(0);
    for (const countdown of countdowns) {
      expect(countdown.props["aria-live"]).toBe("off");
    }
  });

  it("does not re-announce when the countdown ticks down each second", () => {
    renderer = create(
      <InlineApprovalPrompt
        approvalId="approval-tick"
        kind="tool_call"
        riskLevel="safe"
        expiresAt="2026-01-01T00:01:00.000Z"
        {...noopCallbacks}
      />,
    );

    const alertBefore = textOf(renderer!.root.findByProps({ role: "alert" }).props.children);
    expect(textOf(renderer!.toJSON())).toContain("Expires in 1m 00s");

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    // The countdown text changed (visible), but the alert content is unchanged,
    // so assistive tech is not re-triggered by the tick.
    expect(textOf(renderer!.toJSON())).toContain("Expires in 0m 58s");
    const alertAfter = textOf(renderer!.root.findByProps({ role: "alert" }).props.children);
    expect(alertAfter).toBe(alertBefore);
    expect(alertAfter).not.toContain("Expires in");
  });

  it("keeps technical details collapsed with an accessible, mounted disclosure target", () => {
    renderer = create(
      <InlineApprovalPrompt approvalId="approval-details" codeHash="sha256:abc123" {...noopCallbacks} />,
    );

    const findTechnicalDetails = () =>
      renderer!.root.find((node) => node.type === "details" && node.props.className === "approval-technical-details");
    const details = findTechnicalDetails();
    const summary = details.findByType("summary");
    const target = details.find((node) => node.type === "div" && node.props.id === summary.props["aria-controls"]);

    expect(details.props.open).toBe(false);
    expect(summary.props["aria-expanded"]).toBe(false);
    expect(summary.props["aria-controls"]).toBeTruthy();
    expect(target.props.id).toBe(summary.props["aria-controls"]);

    act(() => {
      findTechnicalDetails().props.onToggle({ currentTarget: { open: true } });
    });

    expect(findTechnicalDetails().props.open).toBe(true);
    expect(findTechnicalDetails().findByType("summary").props["aria-expanded"]).toBe(true);
  });
});
