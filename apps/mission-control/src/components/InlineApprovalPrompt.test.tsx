import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineApprovalPrompt } from "./InlineApprovalPrompt";

afterEach(() => {
  vi.useRealTimers();
});

describe("InlineApprovalPrompt", () => {
  it("renders a live countdown and disables actions after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));
    let renderer = create(<div />);

    try {
      await act(async () => {
        renderer = create(
          <InlineApprovalPrompt
            approvalId="approval-1"
            toolName="shell.exec"
            reason="Approval required by policy."
            expiresAt="2026-03-22T12:00:05.000Z"
            onApproveOnce={() => undefined}
            onApproveInSession={() => undefined}
            onApproveInWorkspace={() => undefined}
            onDeny={() => undefined}
          />,
        );
      });

      const countdownBefore = renderer.root.findAll((node) =>
        typeof node.props.className === "string" && node.props.className.includes("chat-approval-countdown"));
      expect(countdownBefore[0]?.children.join("")).toContain("Expires in 0m 05s");

      await act(async () => {
        vi.advanceTimersByTime(6_000);
      });

      const expiredLabel = renderer.root.findAll((node) =>
        typeof node.props.className === "string" && node.props.className.includes("chat-approval-countdown") && node.props.className.includes("is-expired"));
      expect(expiredLabel[0]?.children.join("")).toContain("Approval expired, rerun the action.");
      const buttons = renderer.root.findAllByType("button");
      expect(buttons.every((button) => button.props.disabled === true)).toBe(true);
    } finally {
      renderer.unmount();
    }
  });
});
